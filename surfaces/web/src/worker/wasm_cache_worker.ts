// Web Worker 薄入口：探测 `/wasm/quetzalcoatl_wasm_bg.wasm` 与 wasm-bindgen glue，
// 存在则使用 OPFS 单写者缓存（Web Lock 独占租约），缺失则回报 `degraded: "no-wasm"`。
import type { CacheProbeResult, WasmHostFactory, WasmSpineHandle } from "../cache/wasm_cache.js";
import { WasmCacheWorkerCore, type WorkerInbound } from "./wasm_cache_core.js";

const WASM_BINARY_URL = "/wasm/quetzalcoatl_wasm_bg.wasm";
const WASM_GLUE_URL = "/wasm/quetzalcoatl_wasm.js";

interface RawSpineHandle {
  readBlob?: (key: string) => Promise<Uint8Array | undefined | null>;
  read_blob?: (key: string) => Promise<Uint8Array | undefined | null>;
  writeBlob?: (key: string, bytes: Uint8Array) => Promise<void>;
  write_blob?: (key: string, bytes: Uint8Array) => Promise<void>;
}

interface WasmGlue {
  default?: () => Promise<unknown> | unknown;
  OpfsSpine?: { open(root: string): Promise<RawSpineHandle> };
}

function adaptSpine(raw: RawSpineHandle): WasmSpineHandle {
  const read = raw.readBlob ?? raw.read_blob;
  const write = raw.writeBlob ?? raw.write_blob;
  if (typeof read !== "function" || typeof write !== "function") {
    throw new Error("wasm 导出缺少 OpfsSpine.readBlob/writeBlob（或 snake_case 变体）");
  }
  return {
    readBlob: async (key) => (await read.call(raw, key)) ?? null,
    writeBlob: async (key, bytes) => {
      await write.call(raw, key, bytes);
    },
  };
}

async function loadGlue(): Promise<WasmGlue> {
  const module: unknown = await import(/* @vite-ignore */ WASM_GLUE_URL);
  if (typeof module !== "object" || module === null) {
    throw new Error("wasm glue 模块为空");
  }
  return module as WasmGlue;
}

async function probe(): Promise<CacheProbeResult> {
  try {
    const response = await fetch(WASM_BINARY_URL, { method: "HEAD", cache: "no-store" });
    if (!response.ok) return { available: false };
    const length = response.headers.get("content-length");
    if (length !== null && Number.parseInt(length, 10) <= 0) return { available: false };
  } catch {
    return { available: false };
  }
  return {
    available: true,
    load: async (): Promise<WasmHostFactory> => {
      const glue = await loadGlue();
      return {
        open: async (root: string) => {
          if (typeof glue.default === "function") {
            await glue.default();
          }
          const opfs = glue.OpfsSpine;
          if (!opfs || typeof opfs.open !== "function") {
            throw new Error("wasm 导出缺少 OpfsSpine（请用 wasm-bindgen 重新生成）");
          }
          return adaptSpine(await opfs.open(root));
        },
      };
    },
  };
}

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;

const core = new WasmCacheWorkerCore(
  (message) => scope.postMessage(message),
  { probe },
);

scope.onmessage = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return;
  const candidate = data as Partial<WorkerInbound>;
  if (candidate.type !== "init" && candidate.type !== "get" && candidate.type !== "set") return;
  void core.handle(data as WorkerInbound);
};
