// 网络变化：换 Wi-Fi、Wi-Fi 换成移动数据、默认网络被系统切走时，网状层不能等 TCP / ICE 自己超时（信令连接可能挂十几分钟）。
// 两个来源，任一个报告变化就通知（合并 1 秒内的多次）：
//   - 平台的通知（适配器的 onNetworkChange：安卓 App 由系统的默认网络回调触发，立即）；
//   - 每 5 秒比较一次「网络指纹」：本机网卡地址（取不到时略过，例如部分安卓版本不许 App 读网卡），
//     加上去往同步服务的那条路由此刻会用哪个本机地址（UDP connect 只让内核选路，不发任何包）。
//     后者能发现「Wi-Fi 还连着、系统已把默认网络切到移动数据」这种网卡地址都没变的情况。
// 不发任何网络请求：不额外访问同步服务、也不访问别的服务器。
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { normAddr } from "./link.ts";

export const POLL_MS = 5_000;
const DEBOUNCE_MS = 1_000;

/** 本机所有非回环地址（规范化后）；取不到（没有权限等）返回 undefined。 */
export function localAddresses(): Set<string> | undefined {
  try {
    const out = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (!a.internal) out.add(normAddr(a.address));
    return out;
  } catch { return undefined; }
}

/** 去往 remote 的路由此刻用哪个本机地址（不发包）。没有路由或出错返回 undefined。 */
export function routeLocal(remote: string, timeoutMs = 1000): Promise<string | undefined> {
  const family = net.isIP(remote);
  if (!family) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let done = false;
    const s = dgram.createSocket(family === 6 ? "udp6" : "udp4");
    const finish = (v: string | undefined) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => finish(undefined), timeoutMs);
    t.unref?.();
    s.on("error", () => finish(undefined));
    try {
      s.connect(443, remote, () => { try { finish(normAddr(s.address().address)); } catch { finish(undefined); } });
    } catch { finish(undefined); }
  });
}

export interface NetWatchOptions {
  onChange: (why: string) => void;
  target?: () => string | undefined;                                  // 同步服务的地址（信令连接的对端 IP）：据此看路由选了哪个本机地址
  platform?: (cb: (detail: string) => void) => (() => void) | void;    // 平台的网络变化通知（适配器的 onNetworkChange）
  pollMs?: number;
}

/** 开始监视；返回停止函数。第一次采样只记下基准，不报告。 */
export function watchNetwork(o: NetWatchOptions): () => void {
  let first = true, lastAddrs = "", lastTarget: string | undefined, lastRoute: string | undefined;
  let timer: NodeJS.Timeout | undefined, pending: NodeJS.Timeout | undefined, stopped = false, busy = false;
  const why = new Set<string>();
  const report = (w: string) => {
    if (stopped) return;
    why.add(w);
    clearTimeout(pending);
    pending = setTimeout(() => { const w2 = [...why].join("、"); why.clear(); try { o.onChange(w2); } catch {} }, DEBOUNCE_MS);
    pending.unref?.();
  };
  const sample = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const addrs = localAddresses();
      const target = o.target?.();
      const route = target ? await routeLocal(target) : undefined;
      const a = addrs ? [...addrs].sort().join(",") : "?";
      // 路由只在去往同一个地址、前后都选得出时比较（信令连接断开、换了同步服务的入口地址时不算网络变了）
      if (!first && a !== lastAddrs) report("本机地址变了");
      else if (!first && target && target === lastTarget && route && lastRoute && route !== lastRoute) report("默认网络换了");
      first = false; lastAddrs = a; lastTarget = target; lastRoute = route;
    } finally { busy = false; }
  };
  void sample();
  timer = setInterval(() => void sample(), o.pollMs ?? POLL_MS);
  timer.unref?.();
  let off: (() => void) | void;
  try { off = o.platform?.((d) => report(d || "系统报告网络变了")); } catch {}
  return () => { stopped = true; clearInterval(timer); clearTimeout(pending); try { off?.(); } catch {} };
}
