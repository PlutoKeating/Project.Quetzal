// 账户：App（控制台）的「账户」页经运行基座管理同步服务上的账户（与官网的账户页是同一套接口，见 sync/docs/PROTOCOL.md §5）。
// 运行基座手里的身体令牌只代表这具身体；要管理账户，先做一次「控制台登录」：这具身体（已绑定）向同步服务申请一对码，
// 人在官网的「批准设备」页批准后，拿到一个账户会话令牌（qsc_，存 secrets/sync-account.json，0600）。之后控制台的账户操作都由这里带上它转发。
// 令牌失效（被吊销、过期、账户删除）时删除本地文件，控制台回到「登录」。agent 的工具不提供这些操作，只有持网关令牌的控制台能用。
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config.ts";
import { bus } from "../bus.ts";
import { addTimeline } from "../store.ts";
import { VERSION } from "../version.ts";
import { readBinding } from "./runtime.ts";
import { serverOrigin } from "./directory.ts";

const FILE = () => path.join(paths.secrets, "sync-account.json");
interface Saved { server: string; token: string; account: string; at: number }
interface SignIn { code: string; uri: string; expires: number; abort: AbortController }

let signing: SignIn | undefined;
let lastError = "";

function saved(): Saved | undefined {
  try { const s = JSON.parse(fs.readFileSync(FILE(), "utf8")) as Saved; return s.token?.startsWith("qsc_") && s.server ? s : undefined; } catch { return undefined; }
}
function forget() { fs.rmSync(FILE(), { force: true }); }

/** 账户页的状态：bound 为这具身体已绑定同步服务（控制台登录的前提）；signedIn 为已有账户会话；signing 为进行中的登录（给人看的码与链接）。 */
export function accountStatus() {
  const b = readBinding(), s = saved();
  const sameServer = !!b && !!s && s.server === b.server;
  return {
    server: b?.server ?? "", bound: !!b, signedIn: sameServer, account: sameServer ? s!.account : b?.account ?? "",
    signing: signing ? { code: signing.code, uri: signing.uri, expires: signing.expires } : null,
    error: lastError,
  };
}
const changed = () => bus.emit("account", accountStatus());

async function post(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(15_000) });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
}

/** 开始控制台登录：返回状态（signing 里是码与链接）；后台轮询，批准后保存令牌。 */
export async function signIn() {
  const b = readBinding();
  if (!b) throw new Error("这具身体还没有绑定同步服务：先在「多具身体」里绑定");
  signing?.abort.abort();
  const r = await post(`${serverOrigin(b.server)}/v1/console/code`, {}, { authorization: `Bearer ${b.token}`, "x-quetzal-version": VERSION });
  if (r.status !== 200) throw new Error(r.json.error === "unauthorized" ? "这具身体的绑定已失效：先在「多具身体」里重新绑定" : r.json.error === "slow_down" ? "申请太频繁，请稍后再试" : `同步服务拒绝了登录请求（${r.json.error ?? r.status}）`);
  const start = r.json as { device_code: string; user_code: string; verification_uri_complete: string; expires_in: number; interval: number };
  const abort = new AbortController();
  signing = { code: start.user_code, uri: start.verification_uri_complete, expires: Date.now() + start.expires_in * 1000, abort };
  lastError = "";
  changed();
  void poll(b.server, start, abort).catch((e: Error) => { if (signing?.abort === abort) { signing = undefined; lastError = e.message; changed(); } });
  return accountStatus();
}

async function poll(server: string, start: { device_code: string; expires_in: number; interval: number }, abort: AbortController) {
  let interval = Math.max(1, start.interval) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((res, rej) => { const t = setTimeout(res, interval); abort.signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("已取消登录")); }, { once: true }); });
    const r = await post(`${serverOrigin(server)}/v1/device/token`, { device_code: start.device_code }, {}, AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])).catch((e) => { if (abort.signal.aborted) throw e; return { status: 0, json: {} as Record<string, any> }; });
    if (r.status === 200 && String(r.json.access_token ?? "").startsWith("qsc_")) {
      fs.writeFileSync(FILE(), JSON.stringify({ server: serverOrigin(server), token: r.json.access_token, account: r.json.account ?? "", at: Date.now() } satisfies Saved, null, 2), { mode: 0o600 });
      signing = undefined; lastError = "";
      addTimeline("mesh", `这具身体上的控制台登录了账户 ${r.json.account ?? ""}`, {});
      changed();
      return;
    }
    const err = r.json.error;
    if (err === "slow_down") interval += 5000;
    else if (err === "access_denied") throw new Error("登录被拒绝了");
    else if (err === "expired_token" || err === "invalid_grant") throw new Error("登录码已过期，请重新开始");
  }
  throw new Error("登录码已过期，请重新开始");
}

export function cancelSignIn() { signing?.abort.abort(); signing = undefined; changed(); return accountStatus(); }

/** 用账户会话令牌调用同步服务的账户接口。令牌失效时删除本地文件并抛出。 */
async function web<T>(p: string, body?: unknown): Promise<T> {
  const s = saved(), b = readBinding();
  if (!s || !b || s.server !== b.server) throw new Error("还没有登录账户");
  const headers = { authorization: `Bearer ${s.token}` };
  const r = body === undefined
    ? await fetch(`${s.server}${p}`, { headers, signal: AbortSignal.timeout(15_000) }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => ({})) as Record<string, any> }))
    : await post(`${s.server}${p}`, body, headers);
  if (r.status === 401) { forget(); changed(); throw new Error("账户登录已失效（可能在官网上被吊销了），请重新登录"); }
  if (r.status >= 400) throw Object.assign(new Error(String(r.json.error ?? r.status)), { code: r.json.error });
  return r.json as T;
}

export const account = {
  get: () => web("/v1/web/account"),
  lookup: (code: string) => web("/v1/web/device/lookup", { code: String(code ?? "") }),
  /** agent：身体没给 agent 时人选的 agent id 或 "new"。返回 next 时由控制台在浏览器里打开（经 GitHub 把部署密钥加到灵魂仓库，同步服务协议 §2.1）。 */
  decide: (code: string, approve: boolean, agent?: string) => web("/v1/web/device/decide", { code: String(code ?? ""), approve: !!approve, ...(typeof agent === "string" && agent.length <= 64 ? { agent } : {}) }),
  removeBody: (agent: string, body: string) => web("/v1/web/bodies/remove", { agent: String(agent ?? ""), body: String(body ?? "") }),
  removeAgent: (agent: string) => web("/v1/web/agents/remove", { agent: String(agent ?? "") }),
  revokeConsole: (id: string) => web("/v1/web/consoles/revoke", { id: String(id ?? "") }),
  /** 退出这个控制台的登录：同步服务作废令牌，删除本地文件。 */
  async signOut() { await web("/v1/web/logout", {}).catch(() => {}); forget(); changed(); return accountStatus(); },
  async deleteAccount() { await web("/v1/web/account/delete", { confirm: true }); forget(); changed(); return accountStatus(); },
};
