// 同源 Web 入口：先初始化缓存 Worker（WASM 缺失即降级），再启动三档原生 DOM 应用。
import { QuetzalcoatlApp } from "./app.js";
import { openWorkerCache } from "./cache/worker_cache.js";
import { DaemonClient } from "./transport/client.js";

function safeLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    const probe = "__qz_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  const cache = await openWorkerCache({
    workerUrl: new URL("./wasm_cache_worker.js", import.meta.url),
  });
  const transport = new DaemonClient();
  const app = new QuetzalcoatlApp(root, {
    transport,
    storage: safeLocalStorage(),
    cache,
  });
  window.addEventListener(
    "pagehide",
    () => {
      transport.close();
    },
    { once: true },
  );
  await app.start();
  root.dataset["boot"] = "ready";
}

void boot();
