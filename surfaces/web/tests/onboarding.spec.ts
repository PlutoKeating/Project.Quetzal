import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuetzalcoatlApp } from "../src/app.js";
import type { AppTransport, TransportHandlers } from "../src/transport/client.js";

class QuietTransport implements AppTransport {
  async connect(_handlers: TransportHandlers): Promise<void> {}
  async sendChat(): Promise<void> {}
  close(): void {}
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

async function boot(storage: ReturnType<typeof memoryStorage>) {
  const root = document.createElement("div");
  document.body.append(root);
  const app = new QuetzalcoatlApp(root, { transport: new QuietTransport(), storage });
  await app.start();
  return { root, app };
}

describe("Companion 10 秒零术语引导（可跳过、可记忆）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("首次打开显示 3 步引导并自动推进", async () => {
    const { root } = await boot(memoryStorage());
    const card = root.querySelector('[data-role="onboarding"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute("aria-live")).toBe("off");
    expect(card?.getAttribute("data-onboarding-step")).toBe("1");
    expect(card?.textContent).toContain("写一句话");
    vi.advanceTimersByTime(4000);
    expect(root.querySelector('[data-role="onboarding"]')?.getAttribute("data-onboarding-step")).toBe("2");
    vi.advanceTimersByTime(4000);
    expect(root.querySelector('[data-role="onboarding"]')?.getAttribute("data-onboarding-step")).toBe("3");
  });

  it("10 秒后自动收起并记住已完成", async () => {
    const storage = memoryStorage();
    const { root } = await boot(storage);
    expect(root.querySelector('[data-role="onboarding"]')).not.toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(root.querySelector('[data-role="onboarding"]')).toBeNull();
    expect(storage.map.get("qz.web.onboarded")).toBe("1");
  });

  it("点击跳过立即收起并持久化，重建后不再出现", async () => {
    const storage = memoryStorage();
    const { root } = await boot(storage);
    root.querySelector<HTMLButtonElement>('[data-role="onboarding-skip"]')?.click();
    expect(root.querySelector('[data-role="onboarding"]')).toBeNull();
    expect(storage.map.get("qz.web.onboarded")).toBe("1");

    const second = await boot(storage);
    expect(second.root.querySelector('[data-role="onboarding"]')).toBeNull();
  });
});
