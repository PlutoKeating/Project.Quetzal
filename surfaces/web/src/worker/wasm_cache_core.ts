// Worker 内部协议：只做「初始化 + 读写转发」，不含任何 DOM 或 UI 逻辑。
// 这样同一份状态机可在 vitest（jsdom）中以注入探针直接测试，Worker 入口只是薄壳。
import {
  createSpineCache,
  createMemoryCache,
  type CacheProbe,
  type SpineCache,
} from "../cache/wasm_cache.js";

export type WorkerInbound =
  | { type: "init"; root?: string }
  | { type: "get"; id: number; key: string }
  | { type: "set"; id: number; key: string; bytes: number[] };

export type WorkerOutbound =
  | { type: "ready"; mode: SpineCache["status"]["kind"]; degraded: string | null }
  | { type: "result"; id: number; bytes: number[] | null }
  | { type: "ok"; id: number }
  | { type: "error"; id?: number; detail: string };

export interface WorkerDeps {
  probe: CacheProbe;
}

export class WasmCacheWorkerCore {
  readonly #post: (message: WorkerOutbound) => void;
  readonly #deps: WorkerDeps;
  #cache: SpineCache | null = null;

  constructor(post: (message: WorkerOutbound) => void, deps: WorkerDeps) {
    this.#post = post;
    this.#deps = deps;
  }

  async handle(message: WorkerInbound): Promise<void> {
    try {
      if (message.type === "init") {
        this.#cache = await createSpineCache({
          probe: this.#deps.probe,
          root: message.root ?? "web",
        });
        this.#post({
          type: "ready",
          mode: this.#cache.status.kind,
          degraded: this.#cache.status.degraded,
        });
        return;
      }
      if (!this.#cache) {
        this.#post({
          type: "error",
          ...("id" in message ? { id: message.id } : {}),
          detail: "缓存未初始化（先发送 init）",
        });
        return;
      }
      if (message.type === "get") {
        const bytes = await this.#cache.get(message.key);
        this.#post({
          type: "result",
          id: message.id,
          bytes: bytes ? Array.from(bytes) : null,
        });
        return;
      }
      await this.#cache.set(message.key, Uint8Array.from(message.bytes));
      this.#post({ type: "ok", id: message.id });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#post({ type: "error", detail });
    }
  }
}

export { createMemoryCache };
