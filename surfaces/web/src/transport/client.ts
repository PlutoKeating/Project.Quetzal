// 同源守护进程传输：`POST /auth/local` 取 256-bit 会话令牌 → WebSocket `/rpc`（先认证后 RPC），
// WebSocket 不可用时自动回退 HTTP `POST /rpc` + `GET /rpc/snapshot`。
// 无守护进程时抛类型化 `DaemonUnavailable`，调用方渲染降级视图，绝不白屏。
import { normalizeSnapshot, type ViewPatch, type ViewSnapshot } from "../model/state.js";
import {
  chatEnvelope,
  type IpcRequestEnvelope,
  type ToolCardKind,
} from "./protocol.js";

export interface WebSocketLike {
  readyState: number;
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: MessageEvent) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  onclose: ((this: unknown, ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type TransportKind = "websocket" | "http";

export interface ConnectionState {
  online: boolean;
  transport?: TransportKind | "offline";
  detail?: string;
}

export interface ToolCardEvent {
  kind: ToolCardKind;
  id: string;
  title: string;
  detail?: string;
}

export interface StreamToken {
  messageId: string;
  seq: number;
  text: string;
}

export interface TransportHandlers {
  onSnapshot(snapshot: ViewSnapshot): void;
  onPatch(patch: ViewPatch): void;
  onToken(token: StreamToken): void;
  onToolCard(card: ToolCardEvent): void;
  onConnection(state: ConnectionState): void;
}

export interface CommitResult {
  ok: boolean;
  detail: string;
  code?: string;
}

export interface AppTransport {
  connect(handlers: TransportHandlers): Promise<void>;
  sendChat(text: string): Promise<void>;
  /** 可选：把共享产物提交到当前群组会话；个人会话由 UI 禁用。 */
  commitArtifact?(artifactKey: string): Promise<CommitResult>;
  close(): void;
}

export interface DaemonClientOptions {
  fetcher?: typeof fetch;
  websocketFactory?: (url: string) => WebSocketLike;
  locationOrigin?: string;
}

interface PendingResponse {
  resolve: (response: { kind: string; data?: unknown }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function mapCommitResponse(response: { kind: string; data?: unknown }): CommitResult {
  const data =
    typeof response.data === "object" && response.data !== null
      ? (response.data as Record<string, unknown>)
      : {};
  const detail = typeof data["detail"] === "string" ? data["detail"] : "";
  if (response.kind === "ack") {
    return { ok: true, detail: detail || "已提交到群组" };
  }
  const code = typeof data["code"] === "string" ? data["code"] : "COMMIT_FAILED";
  return { ok: false, detail: detail || "提交失败", code };
}

export class DaemonUnavailable extends Error {
  readonly code = "DAEMON_UNAVAILABLE";
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = "DaemonUnavailable";
    this.detail = detail;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export class DaemonClient implements AppTransport {
  readonly #fetcher: typeof fetch | null;
  readonly #websocketFactory: ((url: string) => WebSocketLike) | null;
  readonly #locationOrigin: string;
  #handlers: TransportHandlers | null = null;
  #socket: WebSocketLike | null = null;
  #token = "";
  #httpOnly = false;
  #nextId = 1;
  #errorSeq = 0;
  #keepalive: ReturnType<typeof setInterval> | null = null;
  readonly #pending = new Map<number, PendingResponse>();

  constructor(options: DaemonClientOptions = {}) {
    this.#fetcher = options.fetcher ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.#websocketFactory = options.websocketFactory ?? null;
    this.#locationOrigin =
      options.locationOrigin ??
      (typeof globalThis.location === "object" && globalThis.location ? globalThis.location.origin : "");
  }

  async connect(handlers: TransportHandlers): Promise<void> {
    this.#handlers = handlers;
    this.#token = await this.#authenticate();
    try {
      await this.#openSocket();
    } catch (error) {
      this.#httpOnly = true;
      handlers.onConnection({
        online: true,
        transport: "http",
        detail: `WebSocket 不可用，已回退 HTTP /rpc（${describe(error)}）`,
      });
      await this.#loadHttpSnapshot();
    }
  }

  async sendChat(text: string): Promise<void> {
    if (!this.#handlers) return;
    const message = text.trim();
    if (message.length === 0) return;
    if (!this.#httpOnly && this.#socket && this.#socket.readyState === 1) {
      this.#socket.send(JSON.stringify(chatEnvelope(this.#nextId, message)));
      this.#nextId += 1;
      return;
    }
    const result = await this.#postRpc({
      method: "chat",
      params: {
        message,
        thread_id: null,
        peer_id: null,
        workspace_dir: null,
        verifier_dag: null,
        router_attempted_forbidden_tools: [],
      },
    });
    if (!result) {
      this.#handlers.onToolCard({
        kind: "error",
        id: `http-error-${this.#errorSeq}`,
        title: "消息未能送达本机守护进程",
        detail: "请确认 quetzalcoatld 仍在运行，然后重试。",
      });
      this.#errorSeq += 1;
    }
  }

  async commitArtifact(artifactKey: string): Promise<CommitResult> {
    const params = { artifact_key: artifactKey };
    if (!this.#httpOnly && this.#socket && this.#socket.readyState === 1) {
      try {
        const response = await this.#request("web_commit_artifact", params);
        return mapCommitResponse(response);
      } catch (error) {
        return {
          ok: false,
          code: "RPC_UNAVAILABLE",
          detail: `提交请求未完成：${describe(error)}`,
        };
      }
    }
    return this.#httpCommit(params);
  }

  #request(
    method: string,
    params: unknown,
  ): Promise<{ kind: string; data?: unknown }> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error("WebSocket 未连接"));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("RPC 响应超时"));
      }, 10_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, request: { method, params } }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #rejectPending(reason: string): void {
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.#pending.delete(id);
    }
  }

  async #httpCommit(params: { artifact_key: string }, allowReauth = true): Promise<CommitResult> {
    if (!this.#fetcher) {
      return { ok: false, code: "NO_FETCH", detail: "当前环境无法访问本机守护进程" };
    }
    let response: Response;
    try {
      response = await this.#fetcher(`${this.#origin()}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ method: "web_commit_artifact", params }),
        credentials: "same-origin",
      });
    } catch (error) {
      return { ok: false, code: "NETWORK", detail: describe(error) };
    }
    if (response.status === 401 && allowReauth) {
      try {
        this.#token = await this.#authenticate();
      } catch (error) {
        return { ok: false, code: "DAEMON_UNAVAILABLE", detail: describe(error) };
      }
      return this.#httpCommit(params, false);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        ok: false,
        code: `HTTP_${response.status}`,
        detail: "守护进程返回了无法解析的提交响应",
      };
    }
    if (!response.ok) {
      const mapped = mapCommitResponse(
        typeof payload === "object" && payload !== null
          ? (payload as { kind: string; data?: unknown })
          : { kind: "error" },
      );
      return mapped.ok
        ? { ok: false, code: `HTTP_${response.status}`, detail: "提交失败" }
        : mapped;
    }
    return mapCommitResponse(payload as { kind: string; data?: unknown });
  }

  /** 断线重连后请求服务端重发整份快照（避免补丁序裂后的状态漂移）。 */
  async resync(): Promise<void> {
    if (this.#socket && this.#socket.readyState === 1) {
      this.#socket.send(JSON.stringify({ type: "resync" }));
      return;
    }
    await this.#loadHttpSnapshot();
  }

  close(): void {
    this.#stopKeepalive();
    this.#rejectPending("连接已关闭");
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // 已关闭
      }
    }
    this.#handlers = null;
  }

  #origin(): string {
    if (!this.#locationOrigin) {
      throw new DaemonUnavailable("无法确定同源地址（缺少 location.origin）");
    }
    return this.#locationOrigin.replace(/\/$/u, "");
  }

  async #authenticate(): Promise<string> {
    if (!this.#fetcher) {
      throw new DaemonUnavailable("当前环境不支持 fetch，无法访问本机守护进程");
    }
    let response: Response;
    try {
      // POST 确保浏览器必定附带同源 `Origin`（GET 可能省略），与守护进程的
      // “无 Origin 即拒绝”策略配套；这不是 CSRF 放宽，而是把可认证面收紧到浏览器页面。
      response = await this.#fetcher(`${this.#origin()}/auth/local`, {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
    } catch (error) {
      throw new DaemonUnavailable(`POST /auth/local 不可达：${describe(error)}`);
    }
    if (!response.ok) {
      throw new DaemonUnavailable(`POST /auth/local 返回 ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DaemonUnavailable(`POST /auth/local 响应不是 JSON：${describe(error)}`);
    }
    if (typeof payload !== "object" || payload === null) {
      throw new DaemonUnavailable("POST /auth/local 响应为空");
    }
    const token = stringField(payload as Record<string, unknown>, "token");
    if (!token) {
      throw new DaemonUnavailable("POST /auth/local 未返回会话令牌");
    }
    return token;
  }

  #openSocket(): Promise<void> {
    const origin = this.#origin().replace(/^http/u, "ws");
    const url = `${origin}/rpc`;
    return new Promise<void>((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = this.#websocketFactory
          ? this.#websocketFactory(url)
          : (new WebSocket(url) as unknown as WebSocketLike);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // 忽略
        }
        reject(new Error("WebSocket 握手超时"));
      }, 3000);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#socket = socket;
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("WebSocket 握手失败"));
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket 在握手前关闭"));
          return;
        }
        if (this.#socket === socket) {
          this.#socket = null;
          this.#stopKeepalive();
          this.#rejectPending("WebSocket 已断开");
          this.#httpOnly = true;
          this.#handlers?.onConnection({
            online: true,
            transport: "http",
            detail: "WebSocket 已断开，已切换到 HTTP /rpc",
          });
        }
      };
      socket.onmessage = (event: MessageEvent) => this.#dispatch(event.data);
      if (socket.readyState === 1) {
        // 极端情况下工厂返回已连接 socket（测试替身）。
        this.#socket = socket;
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    }).then(() => {
      const socket = this.#socket;
      if (!socket) throw new Error("WebSocket 未建立");
      socket.send(JSON.stringify({ auth: this.#token }));
      this.#startKeepalive(socket);
    });
  }

  // 守护进程对 Web 连接有 30s 读超时；20s 心跳避免静默断链后无谓回退。
  #startKeepalive(socket: WebSocketLike): void {
    this.#stopKeepalive();
    this.#keepalive = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        this.#stopKeepalive();
      }
    }, 20_000);
  }

  #stopKeepalive(): void {
    if (this.#keepalive !== null) {
      clearInterval(this.#keepalive);
      this.#keepalive = null;
    }
  }

  #dispatch(raw: unknown): void {
    const handlers = this.#handlers;
    if (!handlers || typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const frame = message as Record<string, unknown>;
    const type = stringField(frame, "type");
    switch (type) {
      case "ready":
        handlers.onConnection({ online: true, transport: "websocket" });
        return;
      case "snapshot": {
        try {
          handlers.onSnapshot(normalizeSnapshot(frame["state"]));
        } catch {
          // 畸形快照不覆盖本地状态。
        }
        return;
      }
      case "patch": {
        const patch = frame["patch"];
        if (typeof patch === "object" && patch !== null) {
          handlers.onPatch(patch as unknown as ViewPatch);
        }
        return;
      }
      case "response": {
        const id = frame["id"];
        if (typeof id !== "number") return;
        const entry = this.#pending.get(id);
        if (!entry) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        const response = frame["response"];
        if (typeof response === "object" && response !== null) {
          const record = response as Record<string, unknown>;
          entry.resolve({
            kind: typeof record["kind"] === "string" ? record["kind"] : "error",
            data: record["data"],
          });
        } else {
          entry.reject(new Error("畸形 RPC 响应"));
        }
        return;
      }
      case "token": {
        const messageId = stringField(frame, "messageId");
        const text = stringField(frame, "text");
        const seq = frame["seq"];
        if (messageId && text !== undefined && typeof seq === "number") {
          handlers.onToken({ messageId, seq, text });
        }
        return;
      }
      case "tool":
      case "approval":
      case "error": {
        const id = stringField(frame, "id") ?? `event-${this.#errorSeq}`;
        const title = stringField(frame, "title") ?? stringField(frame, "detail") ?? "守护进程事件";
        const detail = stringField(frame, "detail");
        this.#errorSeq += 1;
        handlers.onToolCard({ kind: type, id, title, detail });
        return;
      }
      default:
        return;
    }
  }

  async #postRpc(request: IpcRequestEnvelope, allowReauth = true): Promise<boolean> {
    if (!this.#fetcher) return false;
    try {
      const response = await this.#fetcher(`${this.#origin()}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(request),
        credentials: "same-origin",
      });
      if (response.status === 401 && allowReauth) {
        // 守护进程重启会作废内存会话令牌：重新走 /auth/local 后只重试一次。
        try {
          this.#token = await this.#authenticate();
        } catch {
          return false;
        }
        return this.#postRpc(request, false);
      }
      return response.ok;
    } catch {
      return false;
    }
  }

  async #loadHttpSnapshot(allowReauth = true): Promise<void> {
    if (!this.#fetcher) return;
    try {
      const response = await this.#fetcher(`${this.#origin()}/rpc/snapshot`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
        credentials: "same-origin",
      });
      if (response.status === 401 && allowReauth) {
        try {
          this.#token = await this.#authenticate();
        } catch {
          return;
        }
        await this.#loadHttpSnapshot(false);
        return;
      }
      if (!response.ok) return;
      const payload: unknown = await response.json();
      this.#handlers?.onSnapshot(normalizeSnapshot(payload));
    } catch {
      // 快照兜底失败不影响 HTTP 发送能力。
    }
  }
}
