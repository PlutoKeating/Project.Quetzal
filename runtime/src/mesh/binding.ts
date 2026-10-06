// 同步服务的绑定接口（设备码，协议见 sync/docs/PROTOCOL.md §2 与 §2.1）：只用 fetch，不依赖 ws——
// 没有网状层组件的机器（灵魂桥跑在 macOS 等）也能申请绑定、接入灵魂仓库。信令 WebSocket 在 directory.ts。

export interface Binding { server: string; token: string; agent: string; body: string; account: string }
export interface BindStart { user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number; device_code: string; check?: string }
/** 批准时顺带链接的灵魂仓库（§2.1）：成功给仓库与 SSH 地址，失败给原因。 */
export type SoulLink = { repo: string; remote: string } | { error: string };

/** 只接受 HTTPS 的同步服务（本机地址除外，开发与测试用）：令牌与信令不能走明文。返回规范化的源（origin）或抛错。 */
export function serverOrigin(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error("同步服务地址不是合法的网址"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("同步服务必须使用 HTTPS（令牌与信令不能明文传输）");
  return u.origin;
}

async function post(url: string, body: unknown, signal?: AbortSignal) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(15_000) });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
}

/** 绑定第一步：申请设备码。 */
export async function startBinding(server: string, req: { agent: { id?: string; name: string }; body: string; kind: "runtime" | "bridge"; nodeKey: string; version: string; soulKey?: string }): Promise<BindStart> {
  const r = await post(`${serverOrigin(server)}/v1/device/code`, req);
  if (r.status !== 200) throw new Error(r.json.error === "login_disabled" ? "这个同步服务还没有配置 GitHub 登录，暂时不能绑定" : r.json.error === "slow_down" ? "申请太频繁，请稍后再试" : `同步服务拒绝了绑定请求（${r.json.error ?? r.status}）`);
  return r.json as BindStart;
}

/** 绑定第二步：按间隔轮询，直到人在网页上批准或拒绝、或过期。返回令牌（带部署公钥申请的，另有灵魂仓库链接的结果 soul）。 */
export async function pollBinding(server: string, b: BindStart, signal: AbortSignal): Promise<Binding & { soul?: SoulLink; consoleToken?: string }> {
  let interval = Math.max(1, b.interval) * 1000;
  const deadline = Date.now() + b.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r, j) => { const t = setTimeout(r, interval); signal.addEventListener("abort", () => { clearTimeout(t); j(new Error("已取消绑定")); }, { once: true }); });
    const r = await post(`${serverOrigin(server)}/v1/device/token`, { device_code: b.device_code }, AbortSignal.any([signal, AbortSignal.timeout(15_000)])).catch((e) => { if (signal.aborted) throw e; return { status: 0, json: {} as Record<string, any> }; });
    if (r.status === 200) {
      const s = r.json.soul;
      const soul: SoulLink | undefined = s && typeof s.remote === "string" && /^git@github\.com:[\w.-]+\/[\w.-]+\.git$/.test(s.remote) && typeof s.repo === "string" ? { repo: s.repo, remote: s.remote }
        : s && typeof s.error === "string" ? { error: s.error.slice(0, 300) } : undefined;
      // 同一次批准顺带的控制台登录（同步服务 1.2 起）：有就存下，App 不用再批准一次就能管理账户
      const c = r.json.console?.access_token;
      const consoleToken = typeof c === "string" && /^qsc_[\w-]{1,96}$/.test(c) ? c : undefined;
      return { server: serverOrigin(server), token: r.json.access_token, agent: r.json.agent?.id ?? "", body: r.json.body ?? "", account: r.json.account ?? "", ...(soul ? { soul } : {}), ...(consoleToken ? { consoleToken } : {}) };
    }
    const err = r.json.error;
    if (err === "slow_down") interval += 5000;
    else if (err === "access_denied") throw new Error("绑定被拒绝了");
    else if (err === "expired_token" || err === "invalid_grant") throw new Error("绑定码已过期，请重新开始");
  }
  throw new Error("绑定码已过期，请重新开始");
}

/** 解绑：令牌作废（同步服务删除这具身体的登记）。 */
export async function unbind(b: Binding) {
  await fetch(`${serverOrigin(b.server)}/v1/me`, { method: "DELETE", headers: { authorization: `Bearer ${b.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

