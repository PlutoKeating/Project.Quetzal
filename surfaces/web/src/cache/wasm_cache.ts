// 浏览器端草稿缓存：wasm 产物存在时走 `quetzalcoatl-wasm` 的 OPFS 单写者宿主，
// 缺失或初始化失败时明确降级为内存缓存（刷新即丢），绝不伪装为持久化成功。

export type CacheMode = "wasm-opfs" | "memory";

export interface CacheStatus {
  kind: CacheMode;
  /** `null` 表示无降级；否则为机器可读原因。 */
  degraded: string | null;
  detail: string;
}

export interface SpineCache {
  readonly status: CacheStatus;
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, bytes: Uint8Array): Promise<void>;
}

export interface WasmSpineHandle {
  readBlob(key: string): Promise<Uint8Array | null>;
  writeBlob(key: string, bytes: Uint8Array): Promise<void>;
}

export interface WasmHostFactory {
  open(root: string): Promise<WasmSpineHandle>;
}

export type CacheProbeResult =
  | { available: true; load: () => Promise<WasmHostFactory> }
  | { available: false };

export interface CacheProbe {
  (): Promise<CacheProbeResult>;
}

export const NO_WASM = "no-wasm";

export interface MemoryCacheOptions {
  store?: Map<string, Uint8Array>;
}

export function createMemoryCache(options: MemoryCacheOptions = {}): SpineCache {
  const store = options.store ?? new Map<string, Uint8Array>();
  return {
    status: {
      kind: "memory",
      degraded: NO_WASM,
      detail: "未找到 quetzalcoatl_wasm_bg.wasm，草稿仅保存在内存中，刷新后丢失。",
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, bytes) {
      store.set(key, new Uint8Array(bytes));
    },
  };
}

export interface SpineCacheOptions {
  probe: CacheProbe;
  root?: string;
}

export async function createSpineCache(options: SpineCacheOptions): Promise<SpineCache> {
  let probe: CacheProbeResult;
  try {
    probe = await options.probe();
  } catch (error) {
    return createFailedCache("probe-error", error);
  }
  if (!probe.available) {
    return createMemoryCache();
  }
  try {
    const host = await probe.load();
    const spine = await host.open(options.root ?? "web");
    return {
      status: {
        kind: "wasm-opfs",
        degraded: null,
        detail: "草稿经 Web Lock 独占租约写入 OPFS（单写者）。",
      },
      get: (key) => spine.readBlob(key),
      set: (key, bytes) => spine.writeBlob(key, bytes),
    };
  } catch (error) {
    return createFailedCache("wasm-error", error);
  }
}

export function createDegradedMemoryCache(reason: string, detail: string): SpineCache {
  const base = createMemoryCache();
  return {
    ...base,
    status: { kind: "memory", degraded: reason, detail },
  };
}

function createFailedCache(reason: string, error: unknown): SpineCache {
  const detail = error instanceof Error ? error.message : String(error);
  return createDegradedMemoryCache(
    reason,
    `WASM 缓存初始化失败（${detail}），已降级为内存缓存。`,
  );
}
