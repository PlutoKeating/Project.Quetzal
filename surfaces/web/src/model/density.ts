import { isDensity, type Density } from "./state.js";

export const DENSITY_STORAGE_KEY = "qz.web.density";
/** Web 端首次打开使用 Companion（零术语引导），桌面端可在本地切换后持久化。 */
export const DEFAULT_DENSITY: Density = "companion";

export interface DensityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type DensityListener = (density: Density) => void;

/** 三档认知密度的持久化控制器：切换同步生效、按用户本地保存、存储不可用时退化为内存态。 */
export class DensityController {
  #current: Density;
  #storage: DensityStorage | null;
  #listeners = new Set<DensityListener>();

  constructor(storage?: DensityStorage | null, fallback: Density = DEFAULT_DENSITY) {
    this.#storage = storage ?? null;
    this.#current = this.#read(fallback);
  }

  #read(fallback: Density): Density {
    try {
      const raw = this.#storage?.getItem(DENSITY_STORAGE_KEY) ?? null;
      return isDensity(raw) ? raw : fallback;
    } catch {
      return fallback;
    }
  }

  #write(density: Density): void {
    try {
      this.#storage?.setItem(DENSITY_STORAGE_KEY, density);
    } catch {
      // 隐私模式/配额拒绝：内存态仍然有效，绝不因持久化失败阻断切换。
    }
  }

  get current(): Density {
    return this.#current;
  }

  set(next: Density): Density {
    if (!isDensity(next)) return this.#current;
    if (next === this.#current) return this.#current;
    this.#current = next;
    this.#write(next);
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch {
        // 单个订阅者异常不得中断其他视图更新。
      }
    }
    return this.#current;
  }

  cycle(): Density {
    const next: Density =
      this.#current === "companion" ? "workbench" : this.#current === "workbench" ? "inspector" : "companion";
    return this.set(next);
  }

  subscribe(listener: DensityListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
