import { describe, expect, it, vi } from "vitest";
import {
  DaemonUnavailable,
  DaemonClient,
  type WebSocketLike,
} from "../src/transport/client.js";
import { createSpineCache } from "../src/cache/wasm_cache.js";
import { WasmCacheWorkerCore } from "../src/worker/wasm_cache_core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("无守护进程时的类型化降级视图", () => {
  it("/auth/local 不可达时抛 DaemonUnavailable 而不是普通异常", async () => {
    const client = new DaemonClient({
      fetcher: async () => new Response("nope", { status: 503 }),
    });
    const result = client.connect({
      onSnapshot: () => undefined,
      onPatch: () => undefined,
      onToken: () => undefined,
      onToolCard: () => undefined,
      onConnection: () => undefined,
    });
    await expect(result).rejects.toBeInstanceOf(DaemonUnavailable);
    await result.catch((error: unknown) => {
      expect((error as DaemonUnavailable).code).toBe("DAEMON_UNAVAILABLE");
      expect((error as DaemonUnavailable).detail).toContain("503");
    });
  });

  it("WebSocket 不可用时回退 HTTP /rpc 仍能发送消息", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/local")) {
        return Response.json({ token: "tok", expires_in_secs: 60 });
      }
      if (url.endsWith("/rpc")) {
        const body = init?.body;
        expect(typeof body).toBe("string");
        return Response.json({ kind: "ack", data: { detail: "accepted" } });
      }
      return new Response("missing", { status: 404 });
    });
    const handlers = {
      onSnapshot: vi.fn(),
      onPatch: vi.fn(),
      onToken: vi.fn(),
      onToolCard: vi.fn(),
      onConnection: vi.fn(),
    };
    const client = new DaemonClient({
      fetcher: fetcher as unknown as typeof fetch,
      websocketFactory: () => {
        throw new Error("no websocket in this environment");
      },
      locationOrigin: "http://127.0.0.1:1234",
    });
    await client.connect(handlers);
    await client.sendChat("你好");
    expect(calls.some((url) => url.endsWith("/rpc"))).toBe(true);
    expect(handlers.onConnection).toHaveBeenCalledWith(
      expect.objectContaining({ online: true }),
    );
    client.close();
  });

  it("WebSocket 握手成功后先认证再接收快照", async () => {
    const sent: string[] = [];
    let instance: FakeSocket | null = null;
    class FakeSocket implements WebSocketLike {
      onopen: ((this: unknown, ev: unknown) => void) | null = null;
      onmessage: ((this: unknown, ev: MessageEvent) => void) | null = null;
      onerror: ((this: unknown, ev: unknown) => void) | null = null;
      onclose: ((this: unknown, ev: unknown) => void) | null = null;
      readyState = 0;
      constructor() {
        instance = this;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.call(this, {});
        });
      }
      send(data: string): void {
        sent.push(data);
        const parsed = JSON.parse(data) as { auth?: string };
        if (parsed.auth !== undefined) {
          queueMicrotask(() => {
            this.onmessage?.call(this, {
              data: JSON.stringify({ type: "ready" }),
            } as MessageEvent);
            this.onmessage?.call(this, {
              data: JSON.stringify({
                type: "snapshot",
                state: { rev: 2, density: "workbench", rows: {} },
              }),
            } as MessageEvent);
          });
        }
      }
      close(): void {
        this.readyState = 3;
      }
    }
    const client = new DaemonClient({
      fetcher: (async () =>
        Response.json({ token: "tok", expires_in_secs: 60 })) as unknown as typeof fetch,
      websocketFactory: () => new FakeSocket(),
      locationOrigin: "http://127.0.0.1:1234",
    });
    const snapshots: number[] = [];
    await client.connect({
      onSnapshot: (snapshot) => snapshots.push(snapshot.rev),
      onPatch: () => undefined,
      onToken: () => undefined,
      onToolCard: () => undefined,
      onConnection: () => undefined,
    });
    await vi.waitFor(() => expect(snapshots).toEqual([2]));
    expect(JSON.parse(sent[0] ?? "{}")).toEqual({ auth: "tok" });
    expect(instance).not.toBeNull();
    client.close();
  });

  it("HTTP 兜底遇到 401 会重新认证并只重试一次", async () => {
    let authCalls = 0;
    let rpcCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/local")) {
        authCalls += 1;
        return Response.json({ token: `tok-${authCalls}`, expires_in_secs: 60 });
      }
      if (url.endsWith("/rpc")) {
        rpcCalls += 1;
        return rpcCalls === 1 ? new Response("stale", { status: 401 }) : Response.json({ ok: true });
      }
      return new Response("missing", { status: 404 });
    });
    const client = new DaemonClient({
      fetcher: fetcher as unknown as typeof fetch,
      websocketFactory: () => {
        throw new Error("no websocket");
      },
      locationOrigin: "http://127.0.0.1:1234",
    });
    const handlers = {
      onSnapshot: vi.fn(),
      onPatch: vi.fn(),
      onToken: vi.fn(),
      onToolCard: vi.fn(),
      onConnection: vi.fn(),
    };
    await client.connect(handlers);
    await client.sendChat("重启后重试");
    expect(authCalls).toBe(2);
    expect(rpcCalls).toBe(2);
    expect(handlers.onToolCard).not.toHaveBeenCalled();
    client.close();
  });
});

describe("WASM 缓存可用性矩阵", () => {
  it("无 wasm 产物时明确报告 degraded: no-wasm 并回退内存缓存", async () => {
    const cache = await createSpineCache({ probe: async () => ({ available: false }) });
    expect(cache.status.kind).toBe("memory");
    expect(cache.status.degraded).toBe("no-wasm");
    await cache.set("draft-1", encoder.encode("内存里的草稿"));
    const value = await cache.get("draft-1");
    expect(value && decoder.decode(value)).toBe("内存里的草稿");
  });

  it("wasm 产物存在时使用 OPFS 单写者宿主", async () => {
    const writes: string[] = [];
    const cache = await createSpineCache({
      probe: async () => ({
        available: true,
        load: async () => ({
          open: async (root: string) => ({
            readBlob: async (key: string) =>
              writes.includes(`${root}:${key}`) ? encoder.encode("wasm") : null,
            writeBlob: async (key: string) => {
              writes.push(`${root}:${key}`);
            },
          }),
        }),
      }),
      root: "web",
    });
    expect(cache.status.kind).toBe("wasm-opfs");
    expect(cache.status.degraded).toBeNull();
    await cache.set("spine-1", encoder.encode("x"));
    expect(writes).toEqual(["web:spine-1"]);
  });

  it("wasm 初始化失败时降级并保留可诊断原因", async () => {
    const cache = await createSpineCache({
      probe: async () => ({
        available: true,
        load: async () => {
          throw new Error("Web Locks 不可用");
        },
      }),
    });
    expect(cache.status.kind).toBe("memory");
    expect(cache.status.degraded).toBe("wasm-error");
    expect(cache.status.detail).toContain("Web Locks");
  });
});

describe("worker 缓存协议", () => {
  it("无 wasm 时 ready 消息携带 no-wasm，且内存读写可用", async () => {
    const out: unknown[] = [];
    const core = new WasmCacheWorkerCore(
      (message) => out.push(message),
      { probe: async () => ({ available: false }) },
    );
    await core.handle({ type: "init", root: "web" });
    expect(out[0]).toEqual({ type: "ready", mode: "memory", degraded: "no-wasm" });
    await core.handle({ type: "set", id: 1, key: "k", bytes: [1, 2, 3] });
    await core.handle({ type: "get", id: 2, key: "k" });
    expect(out[1]).toEqual({ type: "ok", id: 1 });
    expect(out[2]).toEqual({ type: "result", id: 2, bytes: [1, 2, 3] });
  });

  it("init 之前的读写被显式拒绝而不是静默丢数据", async () => {
    const out: unknown[] = [];
    const core = new WasmCacheWorkerCore(
      (message) => out.push(message),
      { probe: async () => ({ available: false }) },
    );
    await core.handle({ type: "get", id: 7, key: "k" });
    expect(out[0]).toEqual(
      expect.objectContaining({ type: "error", id: 7 }),
    );
  });
});
