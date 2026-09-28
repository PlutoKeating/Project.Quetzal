// 供应商兼容层：个别供应商对请求有额外约定（端点、请求头、按模型区分的协议……）。
// 每个兼容模块只在识别到对应供应商时自动生效，对其他供应商没有任何影响；核心适配器保持通用。
import type { Provider } from "../types.ts";
import type { Target } from "../adapters.ts";
import { openCodeGo } from "./opencode-go.ts";

export interface CallContext {
  session: string; // 一次对话（一次醒来 / 一段交谈 / 一次连通性测试）的稳定标识
}

export interface ProviderCompat {
  id: string;
  /** 是否作用于这个供应商。 */
  matches(provider: Pick<Provider, "catalogId" | "name" | "baseUrl">): boolean;
  /** 调整一次调用的目标（地址、协议、模型名、请求头）。 */
  adapt(target: Target, ctx: CallContext): Target;
}

export const compats: ProviderCompat[] = [openCodeGo];

export const compatFor = (provider: Pick<Provider, "catalogId" | "name" | "baseUrl">) => compats.find((x) => x.matches(provider));

export function applyCompat(provider: Pick<Provider, "catalogId" | "name" | "baseUrl">, target: Target, ctx: CallContext): Target {
  const c = compatFor(provider);
  return c ? c.adapt(target, ctx) : target;
}
