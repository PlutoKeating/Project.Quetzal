import { beforeEach, describe, expect, it } from "vitest";
import { DENSITY_STORAGE_KEY, DensityController } from "../src/model/density.js";

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

describe("认知密度切换：即时且按用户本地持久化", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("首次打开默认 Companion，切换后同步写入 localStorage", () => {
    const storage = memoryStorage();
    const controller = new DensityController(storage);
    expect(controller.current).toBe("companion");
    expect(controller.set("workbench")).toBe("workbench");
    expect(storage.map.get(DENSITY_STORAGE_KEY)).toBe("workbench");
    expect(controller.current).toBe("workbench");
  });

  it("重新加载时恢复上次密度", () => {
    const storage = memoryStorage({ [DENSITY_STORAGE_KEY]: "inspector" });
    expect(new DensityController(storage).current).toBe("inspector");
  });

  it("非法持久化值回退 Companion 而不是崩溃", () => {
    const storage = memoryStorage({ [DENSITY_STORAGE_KEY]: "galaxy-brain" });
    expect(new DensityController(storage).current).toBe("companion");
    storage.setItem(DENSITY_STORAGE_KEY, "{}");
    expect(new DensityController(storage).current).toBe("companion");
  });

  it("cycle 顺序为 companion → workbench → inspector → companion", () => {
    const controller = new DensityController(memoryStorage());
    controller.set("companion");
    expect(controller.cycle()).toBe("workbench");
    expect(controller.cycle()).toBe("inspector");
    expect(controller.cycle()).toBe("companion");
  });

  it("订阅者在同步调用中收到通知（无异步等待）", () => {
    const controller = new DensityController(memoryStorage());
    const seen: string[] = [];
    controller.subscribe((density) => seen.push(density));
    controller.set("inspector");
    controller.set("inspector");
    expect(seen).toEqual(["inspector"]);
  });

  it("浏览器 localStorage 被禁用时仍可在内存内切换", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const controller = new DensityController(hostile);
    expect(() => controller.set("companion")).not.toThrow();
    expect(controller.current).toBe("companion");
  });
});
