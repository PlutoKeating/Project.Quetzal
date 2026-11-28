// 治理面的传输：本机握手 `POST /auth/local` 取会话令牌，之后每次调用都是一次 `POST /rpc` 的请求/响应。
// 请求体 {"method","params"}，响应体 {"kind","data"}；失败是 {"kind":"error","data":{"code","detail"}}。
import { DecodeError, RESULT_DECODERS } from "./decode.js";
import type {
  AuditPage,
  AuditQuery,
  Baseline,
  BaselineSigned,
  DevicesView,
  DirectiveDraft,
  EntryWrite,
  HostsView,
  MemoriesPage,
  MemoriesQuery,
  MemoryDetail,
  SeaMethod,
  SeaMethods,
  SeaOverview,
  SeaSelf,
  SeaUs,
  SeaUser,
} from "./types.js";

/** 守护进程联系不上：没在运行、握手被拒，或请求没有回来。 */
export class DaemonUnreachable extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = "DaemonUnreachable";
    this.detail = detail;
  }
}

/** 守护进程答复了，但答复是一个错误。 */
export class SeaError extends Error {
  readonly method: SeaMethod;
  readonly code: string;
  readonly detail: string;
  readonly status: number;

  constructor(method: SeaMethod, code: string, detail: string, status: number) {
    super(detail || code);
    this.name = "SeaError";
    this.method = method;
    this.code = code;
    this.detail = detail;
    this.status = status;
  }

  /**
   * 接口未就绪：握手成功，但守护进程不认识这个方法（没放进 Web 可调用的名单，或还没有实现）。
   * 与「调用了、但被业务拒绝」是两回事，界面上是两种状态。
   */
  get notReady(): boolean {
    if (this.status === 404 || this.status === 501) return true;
    if (this.status === 403 && this.code === "PERMISSION_DENIED") return true;
    if (this.code === "METHOD_NOT_FOUND" || this.code === "NOT_IMPLEMENTED") return true;
    return this.code === "SERIALIZATION_ERROR" && /unknown variant/iu.test(this.detail);
  }
}

export interface SeaApi {
  overview(): Promise<SeaOverview>;
  self(): Promise<SeaSelf>;
  user(): Promise<SeaUser>;
  us(): Promise<SeaUs>;
  memories(query?: MemoriesQuery): Promise<MemoriesPage>;
  memory(id: string): Promise<MemoryDetail>;
  baseline(): Promise<Baseline>;
  hosts(): Promise<HostsView>;
  devices(): Promise<DevicesView>;
  audit(query?: AuditQuery): Promise<AuditPage>;
  entryUpdate(id: string, text: string): Promise<EntryWrite>;
  entryMute(id: string, muted: boolean): Promise<EntryWrite>;
  entryErase(id: string): Promise<EntryWrite>;
  baselineSign(directives: readonly DirectiveDraft[], passphrase: string): Promise<BaselineSigned>;
  focusSet(selfWeight: number): Promise<SeaUs>;
  rhythmSet(speakFirst: boolean, quietHours: readonly number[] | null): Promise<SeaSelf>;
  deviceRevoke(deviceId: string, passphrase: string): Promise<DevicesView>;
}

export interface SeaClientOptions {
  fetcher?: typeof fetch;
  origin?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export class SeaClient implements SeaApi {
  readonly #fetcher: typeof fetch | null;
  readonly #origin: string;
  readonly #timeoutMs: number;
  #token: string | null = null;
  #handshake: Promise<string> | null = null;

  constructor(options: SeaClientOptions = {}) {
    this.#fetcher = options.fetcher ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.#origin = (
      options.origin ??
      (typeof globalThis.location === "object" && globalThis.location ? globalThis.location.origin : "")
    ).replace(/\/$/u, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  overview(): Promise<SeaOverview> {
    return this.call("sea_overview", null);
  }

  self(): Promise<SeaSelf> {
    return this.call("sea_self", null);
  }

  user(): Promise<SeaUser> {
    return this.call("sea_user", null);
  }

  us(): Promise<SeaUs> {
    return this.call("sea_us", null);
  }

  memories(query: MemoriesQuery = {}): Promise<MemoriesPage> {
    return this.call("sea_memories", query);
  }

  memory(id: string): Promise<MemoryDetail> {
    return this.call("sea_memory", { id });
  }

  baseline(): Promise<Baseline> {
    return this.call("sea_baseline", null);
  }

  hosts(): Promise<HostsView> {
    return this.call("sea_hosts", null);
  }

  devices(): Promise<DevicesView> {
    return this.call("sea_devices", null);
  }

  audit(query: AuditQuery = {}): Promise<AuditPage> {
    return this.call("sea_audit", query);
  }

  entryUpdate(id: string, text: string): Promise<EntryWrite> {
    return this.call("sea_entry_update", { id, text });
  }

  entryMute(id: string, muted: boolean): Promise<EntryWrite> {
    return this.call("sea_entry_mute", { id, muted });
  }

  entryErase(id: string): Promise<EntryWrite> {
    return this.call("sea_entry_erase", { id });
  }

  baselineSign(directives: readonly DirectiveDraft[], passphrase: string): Promise<BaselineSigned> {
    return this.call("sea_baseline_sign", {
      directives: directives.map(({ title, text }) => ({ title, text })),
      passphrase,
    });
  }

  focusSet(selfWeight: number): Promise<SeaUs> {
    return this.call("sea_focus_set", { self_weight: selfWeight });
  }

  rhythmSet(speakFirst: boolean, quietHours: readonly number[] | null): Promise<SeaSelf> {
    return this.call("sea_rhythm_set", {
      speak_first: speakFirst,
      quiet_hours: quietHours === null ? null : [...quietHours],
    });
  }

  deviceRevoke(deviceId: string, passphrase: string): Promise<DevicesView> {
    return this.call("sea_device_revoke", { device_id: deviceId, passphrase });
  }

  async call<M extends SeaMethod>(
    method: M,
    params: SeaMethods[M]["params"],
  ): Promise<SeaMethods[M]["result"]> {
    const body = JSON.stringify(params === null ? { method } : { method, params });
    let response = await this.#post(body, await this.#session());
    if (response.status === 401) {
      // 守护进程重启会作废内存里的会话令牌：重新握手后只重试一次。
      this.#token = null;
      response = await this.#post(body, await this.#session());
      if (response.status === 401) {
        throw new DaemonUnreachable("本机会话被拒绝，重新握手之后仍然没有通过");
      }
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SeaError(method, `HTTP_${response.status}`, "守护进程的答复不是 JSON", response.status);
    }
    const envelope = asRecord(payload);
    const kind = stringAt(envelope, "kind");
    if (kind === "error") {
      const data = asRecord(envelope?.["data"]);
      throw new SeaError(
        method,
        stringAt(data, "code") || "UNKNOWN_ERROR",
        stringAt(data, "detail"),
        response.status,
      );
    }
    if (!response.ok) {
      throw new SeaError(
        method,
        `HTTP_${response.status}`,
        stringAt(envelope, "error") || `守护进程返回 ${response.status}`,
        response.status,
      );
    }
    if (kind !== method) {
      throw new SeaError(
        method,
        "UNEXPECTED_KIND",
        `答复的 kind 是「${kind || "空"}」，应为「${method}」`,
        response.status,
      );
    }
    try {
      return RESULT_DECODERS[method](envelope?.["data"], "data");
    } catch (error) {
      if (error instanceof DecodeError) {
        throw new SeaError(method, "MALFORMED_RESPONSE", error.message, response.status);
      }
      throw error;
    }
  }

  async #post(body: string, token: string): Promise<Response> {
    const fetcher = this.#requireFetcher();
    try {
      return await fetcher(`${this.#requireOrigin()}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        credentials: "same-origin",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new DaemonUnreachable(`请求没有回来：${describe(error)}`);
    }
  }

  #session(): Promise<string> {
    if (this.#token !== null) return Promise.resolve(this.#token);
    this.#handshake ??= this.#authenticate().finally(() => {
      this.#handshake = null;
    });
    return this.#handshake;
  }

  async #authenticate(): Promise<string> {
    const fetcher = this.#requireFetcher();
    let response: Response;
    try {
      // 用 POST 让浏览器一定带上同源的 Origin；守护进程对没有 Origin 的握手一律拒绝。
      response = await fetcher(`${this.#requireOrigin()}/auth/local`, {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new DaemonUnreachable(`本机握手没有回来：${describe(error)}`);
    }
    if (!response.ok) {
      throw new DaemonUnreachable(`本机握手被拒绝（${response.status}）`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DaemonUnreachable("本机握手的答复不是 JSON");
    }
    const token = stringAt(asRecord(payload), "token");
    if (token === "") {
      throw new DaemonUnreachable("本机握手没有给出会话令牌");
    }
    this.#token = token;
    return token;
  }

  #requireFetcher(): typeof fetch {
    if (!this.#fetcher) throw new DaemonUnreachable("当前环境不能发起网络请求");
    return this.#fetcher;
  }

  #requireOrigin(): string {
    if (this.#origin === "") throw new DaemonUnreachable("无法确定同源地址");
    return this.#origin;
  }
}
