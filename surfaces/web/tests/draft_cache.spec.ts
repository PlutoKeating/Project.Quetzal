import { describe, expect, it } from "vitest";
import { QuetzalcoatlApp } from "../src/app.js";
import { createSpineCache, createDegradedMemoryCache, type SpineCache } from "../src/cache/wasm_cache.js";
import type { AppTransport, TransportHandlers } from "../src/transport/client.js";

class QuietTransport implements AppTransport {
  handlers: TransportHandlers | null = null;
  async connect(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
  }
  async sendChat(): Promise<void> {}
  close(): void {}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function bootWith(cache: SpineCache) {
  const root = document.createElement("div");
  document.body.append(root);
  const app = new QuetzalcoatlApp(root, { transport: new QuietTransport(), cache });
  await app.start();
  const input = root.querySelector<HTMLTextAreaElement>("[data-role='composer-input']");
  if (!input) throw new Error("缺少输入框");
  return { root, app, input, cache };
}

describe("草稿缓存与降级", () => {
  it("启动时从缓存恢复草稿，输入后延迟写回", async () => {
    const cache = createDegradedMemoryCache("no-wasm", "测试内存缓存");
    await cache.set("web-composer-draft", encoder.encode("上次没说完的话"));
    const { input } = await bootWith(cache);
    expect(input.value).toBe("上次没说完的话");

    input.value = "新的草稿";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 380));
    const stored = await cache.get("web-composer-draft");
    expect(stored && decoder.decode(stored)).toBe("新的草稿");
  });

  it("发送后清空草稿，避免下次误恢复已发送内容", async () => {
    const cache = await createSpineCache({ probe: async () => ({ available: false }) });
    await cache.set("web-composer-draft", encoder.encode("待发送"));
    const { root, input } = await bootWith(cache);
    expect(input.value).toBe("待发送");
    root.querySelector<HTMLButtonElement>("[data-role='composer-submit']")?.click();
    await new Promise((done) => setTimeout(done, 20));
    const stored = await cache.get("web-composer-draft");
    expect(stored?.byteLength ?? 0).toBe(0);
  });

  it("缓存读写抛错时输入与发送仍可用", async () => {
    const broken: SpineCache = {
      status: { kind: "memory", degraded: "wasm-error", detail: "OPFS 不可写" },
      async get() {
        throw new Error("read failed");
      },
      async set() {
        throw new Error("write failed");
      },
    };
    const { input } = await bootWith(broken);
    input.value = "仍然可输入";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 380));
    expect(input.value).toBe("仍然可输入");
    expect(input.disabled).toBe(false);
  });
});
