// 主线程侧的 Worker 缓存适配器：与 `wasm_cache_worker.ts` 通过结构化消息通信。
// Worker 不可用 / 初始化超时 / WASM 缺失时统一降级为内存缓存，并在状态中保留可诊断原因。
import {
  createDegradedMemoryCache,
  createMemoryCache,
  type SpineCache,
} from "./wasm_cache.js";
import type { WorkerOutbound } from "../worker/wasm_cache_core.js";

interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
}

export interface WorkerCacheOptions {
  workerUrl: string | URL;
  timeoutMs?: number;
}

interface Pending {
  resolve(value: WorkerOutbound): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const INIT_TIMEOUT_MS = 2500;
const REQUEST_TIMEOUT_MS = 2000;

export async function openWorkerCache(options: WorkerCacheOptions): Promise<SpineCache> {
  if (typeof Worker === "undefined") {
    return createDegradedMemoryCache("worker-unavailable", "当前浏览器不支持 Web Worker，草稿仅保存在内存中。");
  }
  let worker: WorkerLike;
  try {
    worker = new Worker(options.workerUrl, {
      type: "module",
      name: "qz-wasm-cache",
    }) as unknown as WorkerLike;
  } catch (error) {
    return createDegradedMemoryCache(
      "worker-unavailable",
      `Web Worker 启动失败（${error instanceof Error ? error.message : String(error)}），草稿仅保存在内存中。`,
    );
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let readyMode: "wasm-opfs" | "memory" = "memory";
  let readyDegraded: string | null = "no-wasm";
  let failInit: ((error: Error) => void) | null = null;

  const initPromise = new Promise<void>((resolve, reject) => {
    failInit = reject;
    const timer = setTimeout(() => {
      reject(new Error("缓存 Worker 初始化超时"));
    }, options.timeoutMs ?? INIT_TIMEOUT_MS);
    pending.set(0, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
      timer,
    });
  });

  worker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as WorkerOutbound | null;
    if (!data || typeof data !== "object") return;
    if (data.type === "ready") {
      readyMode = data.mode;
      readyDegraded = data.degraded;
      pending.get(0)?.resolve(data);
      pending.delete(0);
      return;
    }
    if ("id" in data && typeof data.id === "number") {
      const entry = pending.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(data.id);
      if (data.type === "error") entry.reject(new Error(data.detail));
      else entry.resolve(data);
    }
  });
  worker.addEventListener("error", (event: Event) => {
    const message = event instanceof ErrorEvent ? event.message : "Worker 运行时错误";
    failInit?.(new Error(message));
  });

  try {
    worker.postMessage({ type: "init", root: "web" });
    await initPromise;
  } catch (error) {
    worker.terminate();
    return createDegradedMemoryCache(
      "worker-unavailable",
      `缓存 Worker 初始化失败（${error instanceof Error ? error.message : String(error)}），草稿仅保存在内存中。`,
    );
  }

  // Worker 报告了 wasm 宿主，但读写仍可能因 Web Lock 争用失败；失败即明确降级。
  const call = <T extends WorkerOutbound>(message: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("缓存 Worker 请求超时"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (value: WorkerOutbound) => void, reject, timer });
      worker.postMessage({ ...(message as Record<string, unknown>), id });
    });

  if (readyMode === "memory") {
    const fallback = createMemoryCache();
    return {
      ...fallback,
      status: {
        kind: "memory",
        degraded: readyDegraded ?? "no-wasm",
        detail:
          readyDegraded === null
            ? "缓存 Worker 以内存模式运行。"
            : "未找到 quetzalcoatl_wasm_bg.wasm，草稿仅保存在内存中，刷新后丢失。",
      },
    };
  }

  return {
    status: {
      kind: "wasm-opfs",
      degraded: null,
      detail: "草稿经 Web Lock 独占租约写入 OPFS（单写者）。",
    },
    async get(key) {
      const result = await call<{ type: "result"; id: number; bytes: number[] | null }>({
        type: "get",
        key,
      });
      return result.bytes ? Uint8Array.from(result.bytes) : null;
    },
    async set(key, bytes) {
      await call({ type: "set", key, bytes: Array.from(bytes) });
    },
  };
}
