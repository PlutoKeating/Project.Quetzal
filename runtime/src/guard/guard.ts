// 闸门：能力授权（允许 / 每次询问 / 禁止）、审批队列、急停、审计。
// 所有工具调用都经过 guard.check；默认全部允许，你可以在控制台或飞书里随时收紧。
import fs from "node:fs";
import crypto from "node:crypto";
import { config, paths, saveConfig, type Level } from "../config.ts";
import { bus, type Approval } from "../bus.ts";
import { audit, addTimeline } from "../store.ts";

const pending = new Map<string, { a: Approval; resolve: (ok: boolean) => void }>();
const ASK_TIMEOUT_MS = 30 * 60_000;

export const PERMISSION_LABELS: Record<string, string> = {
  network: "联网", shell: "执行命令", device: "设备功能", camera: "相机", microphone: "麦克风",
  location: "定位", message: "主动发消息", self_modify: "修改自身参数", memory: "改写记忆", hands: "操作屏幕与应用",
};

export function level(permission: string): Level { return config.permissions[permission] ?? "allow"; }
export function setLevel(permission: string, l: Level, actor: string) {
  saveConfig({ permissions: { [permission]: l } });
  audit(actor, "permission.set", "", { permission, level: l }, "ok");
}

export async function check(permission: string, action: string, reason: string, args: unknown): Promise<boolean> {
  if (fs.existsSync(paths.stop)) return false;
  const l = level(permission);
  if (l === "allow") return true;
  if (l === "deny") { audit("amani", action, reason, args, "denied: policy"); return false; }
  const a: Approval = { id: crypto.randomBytes(4).toString("hex"), action, reason, args, status: "pending" };
  addTimeline("approval", `请求批准：${action}`, { id: a.id, reason, args });
  const ok = await new Promise<boolean>((resolve) => {
    pending.set(a.id, { a, resolve });
    bus.emit("approval", a);
    setTimeout(() => decide(a.id, false, "system", "超时未处理"), ASK_TIMEOUT_MS).unref();
  });
  return ok;
}

export function decide(id: string, approve: boolean, actor: string, note = ""): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  p.a.status = approve ? "approved" : "denied";
  audit(actor, `approval.${p.a.status}`, note, { id, action: p.a.action }, "ok");
  addTimeline("approval", `${approve ? "已批准" : "已拒绝"}：${p.a.action}${note ? `（${note}）` : ""}`, { id });
  bus.emit("approval", p.a);
  p.resolve(approve);
  return true;
}
export const approvals = () => [...pending.values()].map((p) => p.a);

export function emergencyStop(actor: string, reason = "") {
  fs.writeFileSync(paths.stop, `${new Date().toISOString()} ${actor} ${reason}\n`);
  for (const id of pending.keys()) decide(id, false, "system", "急停");
  audit(actor, "stop", reason, null, "ok");
  addTimeline("stop", `急停（${actor}）${reason ? "：" + reason : ""}`);
  bus.emit("state");
}

export function releaseStop(actor: string) {
  fs.rmSync(paths.stop, { force: true });
  audit(actor, "unstop", "", null, "ok");
  addTimeline("stop", `解除急停（${actor}）`);
  bus.emit("state");
}
