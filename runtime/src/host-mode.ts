// 真实环境模式：某个会话里，她的 shell 命令不经沙箱，直接以基座进程的系统用户在主机上执行。
//   为什么有它：沙箱刻意让她碰不到主机上的登录凭据（系统钥匙串经会话 D-Bus，Windows 上沙箱是另一个用户），
//   所以对方在终端里 gh auth login 之后，沙箱里的 gh 仍然用不了。挂载凭据目录或放开 D-Bus 等于默认把整串钥匙交出去；
//   这里改为由对方逐次决定：她带着理由请求（host_mode 工具，每次都生成审批，不受「允许」档位影响），或对方在控制台里自己打开。
//   边界：
//   - 按会话：只对开启它的那个对话会话生效（醒来思考、做梦、子 agent、其他身体经 body_call 调用的命令一律仍在沙箱里）；
//     只在这具身体上：状态只在这个进程的内存里，不同步给其他身体。
//   - 不持久：基座重启后一律回到沙箱；IDLE_MS 内没有一条真实环境命令就自动退出；急停（STOP）立即退出。
//   - 退出时：进行中的前台命令与在真实环境里启动的后台任务一起结束。
//   - 每条真实环境命令都写进审计（参数带 realEnv: true），进出都写审计与时间线；系统提示与工具结果让她知道当前在哪种模式。
//   - 基座自己的环境变量（QUETZAL_*）与名字像令牌、密钥的环境变量不传给她的命令（sandbox.ts 的 hostEnv）；但这只是不主动交出——
//     真实环境里她能读写这个系统用户能读写的一切，包括密钥目录、保密库与网关令牌。
import fs from "node:fs";
import { paths } from "./config.ts";
import { bus } from "./bus.ts";
import { audit, addTimeline, getSession } from "./store.ts";
import { ask } from "./guard/guard.ts";
import { listJobs, stopJob } from "./sh.ts";
import { log } from "./log.ts";

export const IDLE_MS = 30 * 60_000;

export interface HostMode { conv: string; title: string; since: number; last: number; by: "agent" | "user"; reason: string; until: number }
interface Entry extends Omit<HostMode, "title" | "until"> { ac: AbortController }
const active = new Map<string, Entry>();
const asking = new Set<string>();

const view = (e: Entry): HostMode => ({ conv: e.conv, title: (() => { try { return getSession(e.conv)?.title ?? ""; } catch { return ""; } })(), since: e.since, last: e.last, by: e.by, reason: e.reason, until: e.last + IDLE_MS });
const changed = () => bus.emit("state");

/** 此刻处在真实环境里的会话（控制台据此显示警示条）。 */
export const hostModes = (): HostMode[] => [...active.values()].map(view);

/** 这个会话是否在真实环境里（过了空闲时限的顺带退出）。 */
export function hostActive(conv?: string): HostMode | undefined {
  const e = conv ? active.get(conv) : undefined;
  if (!e) return undefined;
  if (Date.now() - e.last >= IDLE_MS) { exitHost(conv!, "system", `${IDLE_MS / 60_000} 分钟没有真实环境命令，自动回到沙箱`); return undefined; }
  return view(e);
}

/** 一条真实环境命令：刷新空闲计时，返回中止信号（退出时结束这条命令）。 */
export function touchHost(conv: string): AbortSignal | undefined {
  const e = active.get(conv);
  if (!e) return undefined;
  e.last = Date.now();
  return e.ac.signal;
}

/** 进入真实环境。by：agent（对方批准了她的请求）或 user（对方自己打开）。急停中不能进入。 */
export function enterHost(conv: string, by: "agent" | "user", reason: string, actor: string): HostMode {
  if (!conv) throw new Error("真实环境只能在一个对话会话里打开");
  if (fs.existsSync(paths.stop)) throw new Error("急停中，不能进入真实环境");
  const now = Date.now();
  const e = active.get(conv) ?? { conv, since: now, last: now, by, reason, ac: new AbortController() };
  e.last = now;
  active.set(conv, e);
  audit(actor, "host.enter", reason, { conv, by }, "ok");
  addTimeline("host", `进入真实环境（${by === "user" ? `${actor}打开` : `${actor}批准`}）`, { conv, reason });
  log("host", `会话 ${conv} 进入真实环境（${actor}）`);
  changed();
  return view(e);
}

/** 退出真实环境：结束进行中的真实环境命令与后台任务。返回是否原本在真实环境里。 */
export function exitHost(conv: string, actor: string, why = ""): boolean {
  const e = active.get(conv);
  if (!e) return false;
  active.delete(conv);
  e.ac.abort();
  for (const j of listJobs()) if (j.host === conv && !j.ended) stopJob(j.id);
  audit(actor, "host.exit", why, { conv }, "ok");
  addTimeline("host", `退出真实环境（${actor}）${why ? `：${why}` : ""}`, { conv });
  log("host", `会话 ${conv} 退出真实环境（${actor}）${why ? `：${why}` : ""}`);
  changed();
  return true;
}

export function exitAllHost(actor: string, why: string) { for (const conv of [...active.keys()]) exitHost(conv, actor, why); }

/** 她请求进入：每次都生成审批（不看能力类别的档位），并发系统通知（App 在后台时也看得到）。返回给她的结果。 */
export async function requestHost(conv: string, reason: string, notify?: (text: string) => void): Promise<string> {
  if (hostActive(conv)) return "已经在真实环境里了：这个会话里的 shell 命令直接在主机上执行。做完了用 host_mode 的 exit 回到沙箱。";
  if (asking.has(conv)) return "这个会话里已经有一个进入真实环境的请求在等对方决定。";
  const why = reason.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!why) return "请求要写明理由：为什么沙箱里做不到、要在主机上做什么。";
  asking.add(conv);
  try {
    notify?.(`请求进入真实环境：${why}`);
    const ok = await ask("进入真实环境（命令不经沙箱）", why, { conv }, "host");
    if (!ok) return "对方没有同意（或超时、急停），仍在沙箱里。不要设法绕过沙箱；告诉对方你需要什么，或者换个做法。";
    if (!hostActive(conv)) enterHost(conv, "agent", why, "对方");
    return `已进入真实环境：从现在起这个会话里的 shell 命令不经沙箱，以基座的系统用户直接在主机上执行，能读写对方能读写的一切。只做对方同意的事；做完了用 host_mode 的 exit 回到沙箱（${IDLE_MS / 60_000} 分钟没有命令、基座重启或急停也会自动回到沙箱）。`;
  } finally { asking.delete(conv); }
}

// 急停：立即退出全部；空闲超时：每分钟检查一次（命令执行时也会顺带检查）
bus.on("state", () => { if (active.size && fs.existsSync(paths.stop)) exitAllHost("system", "急停"); });
setInterval(() => { for (const conv of [...active.keys()]) hostActive(conv); }, 60_000).unref();

/** 测试用：清空；把某个会话的最近一条命令往前推 ms（模拟空闲）。 */
export function resetHost() { active.clear(); asking.clear(); }
export function ageHost(conv: string, ms: number) { const e = active.get(conv); if (e) e.last -= ms; }
