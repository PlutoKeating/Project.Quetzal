import { describe, expect, it } from "vitest";
import { createSpineCache } from "../src/cache/wasm_cache.js";
import { WasmCacheWorkerCore } from "../src/worker/wasm_cache_core.js";

// `src/cache/` 与 `src/worker/` 是另一条产品线的地基：治理面不引用它们，但它们的行为继续被守住。

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("WASM 缓存可用性矩阵", () => {
  it("无 wasm 产物时明确报告 degraded: no-wasm 并回退内存缓存", async () => {
    const cache = await createSpineCache({ probe: async () => ({ available: false }) });
    expect(cache.status.kind).toBe("memory");
    expect(cache.status.degraded).toBe("no-wasm");
    await cache.set("blob-1", encoder.encode("内存里的内容"));
    const value = await cache.get("blob-1");
    expect(value && decoder.decode(value)).toBe("内存里的内容");
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
