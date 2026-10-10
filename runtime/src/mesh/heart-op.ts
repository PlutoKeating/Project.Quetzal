// 心脏操作的网状层入口（DISTRIBUTED.md C1、C2）：只有协调者的心脏在跳（heart/heart.ts），
// 跟随者的感觉、对话带来的驱动力变化、经历与性格调整都经「heart.op」事件转给它应用（mesh/coordinator.ts 转发）。
// 这里只管一件事：别处转来的操作**校验形状之后**才落到心脏——对方是可信的身体，但一条出错或被攻破的身体
// 转来的数据同样不能把心脏写坏（参数类型、键名、范围都先查一遍）。
// 心脏状态本身归 heart 模块，网状层不复制一份；认领、设置分区、提醒、在场这些「全网共用的心智数据」各自
// 按条目或修改时刻合并（mind/claims.ts、mesh/shared.ts、mesh/presence.ts），不走这里。
import { applyHeartOp } from "../heart/heart.ts";

/** 跟随者可以转来的心脏操作（与 heart/heart.ts 的 HeartOp 一致）。 */
export const HEART_OPS = new Set(["nudge", "experience", "openLoops", "personality"]);
/** 驱动力的四个键。 */
const DRIVE_KEYS = new Set(["curiosity", "expression", "social", "openLoops"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 别处转来的一条心脏操作是否是合格的形状。不合格时不应用、也不抛错（丢弃并记一笔）。
 * nudge 的参数是 (reason, drives, opts)：drives 只认四个键、每个都是有限数；opts 只能是对象。
 * experience / openLoops 是一个有限的非负数；personality 是一个对象（键与范围由心脏再收窄）。
 */
export function heartOpOk(op: unknown, args: unknown[]): boolean {
  if (typeof op !== "string" || !HEART_OPS.has(op)) return false;
  const a = args.length <= 5 ? args : undefined; // 参数最多 5 个，多的说明对方不是这个协议
  if (!a) return false;
  if (op === "nudge") {
    if (typeof a[0] !== "string") return false;
    if (a[1] !== undefined) {
      if (!isObj(a[1])) return false;
      for (const [k, v] of Object.entries(a[1])) if (!DRIVE_KEYS.has(k) || typeof v !== "number" || !Number.isFinite(v)) return false;
    }
    if (a[2] !== undefined && !isObj(a[2])) return false;
  } else if (op === "experience" || op === "openLoops") {
    // 不带参数按 1 / 0 算（与 heart 的 Number(args[0]) || 1 一致），带了必须是有限的非负数
    if (a.length && (typeof a[0] !== "number" || !Number.isFinite(a[0]) || a[0] < 0)) return false;
  } else if (a.length && !isObj(a[0])) return false;
  return true;
}

/** 应用一条别处转来的心脏操作；形状不对时丢弃并返回 false。 */
export function applyHeartOpRemote(op: unknown, args: unknown[]): boolean {
  const a = Array.isArray(args) ? args : [];
  if (!heartOpOk(op, a)) return false;
  applyHeartOp(op as "nudge", a.slice(0, 5)); // 只有 heartOpOk 通过的各种 op 会走到这里
  return true;
}
