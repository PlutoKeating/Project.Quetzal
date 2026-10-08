// 局域网信令：同步服务连不上（或它说对方不在线）时，同一个局域网里的身体经 UDP 直接互发信令，照样连成一张网。
//   - 发的是和经同步服务时完全相同的签名信封（identity.ts 的 seal）：收方用灵魂仓库登记的公钥验签、查时间窗与随机数，
//     所以这条通道本身不需要被信任；收到的任何东西都先按形状与大小检查，不合格的丢弃，不回应未经验证的包。
//   - 对方的地址从哪来：直连连上时，选中的候选对里对方的本地地址（host 候选，DTLS 认证过的连接），加上对方经直连告诉我们的端口；
//     以及验过签名的局域网信令的来源地址。只记私有地址（10/8、172.16/12、192.168/16、169.254/16、回环），存在数据目录，不出这台设备。
//   - 端口与网关相同（UDP 与 TCP 的端口互不冲突）：同一台机器上的几个运行基座各用各的网关端口，也就各不相同。
//   - 不需要同步服务、不用组播（安卓不持有组播锁就收不到组播），也就不要求第一次之前就在局域网里：至少经同步服务连上过一次，才记得对方。
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { BODY_NAME } from "./identity.ts";

export const LAN_MAX_PACKET = 60 << 10;   // 一个信封（SDP 或 ICE 候选）远小于它
const RATE_WINDOW_MS = 1000, RATE_MAX = 50; // 每个来源地址每秒最多处理 50 个包
const MAX_PEERS = 64;

/** 只记、只发往私有地址与回环：公网地址不走这条通道。 */
export function privateAddr(a: string): boolean {
  if (net.isIP(a) !== 4) return false;
  const [x, y] = a.split(".").map(Number);
  return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
}
const validPort = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536;

export interface LanEntry { addr: string; port: number; at: number }
export interface LanOptions {
  me: string;
  port: number;                                    // 0：由系统分配（测试用）
  file?: string;                                   // 记住的地址表（缺省只在内存里）
  onEnvelope: (from: string, env: unknown, addr: string, port: number) => void;
  log: (msg: string) => void;
}

export class Lan {
  private o: LanOptions;
  private sock?: dgram.Socket;
  private table: Record<string, LanEntry> = {};
  private rate = new Map<string, number[]>();
  bound = 0; // 实际监听的端口（0：没在监听）

  constructor(o: LanOptions) {
    this.o = o;
    if (o.file) try {
      const v = JSON.parse(fs.readFileSync(o.file, "utf8"));
      if (v && typeof v === "object") for (const [b, e] of Object.entries(v as Record<string, LanEntry>)) if (BODY_NAME.test(b) && e && privateAddr(e.addr) && validPort(e.port)) this.table[b] = { addr: e.addr, port: e.port, at: Number(e.at) || 0 };
    } catch {}
  }

  /** 开始监听。端口被占用等错误只记一笔：这条通道是锦上添花，没有它网状层照常经同步服务工作。 */
  start(): Promise<void> {
    return new Promise((resolve) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: false });
      s.on("error", (e) => { this.o.log(`局域网信令不可用：${(e as Error).message}`); try { s.close(); } catch {} if (this.sock === s) { this.sock = undefined; this.bound = 0; } resolve(); });
      s.on("message", (buf, r) => { try { this.onPacket(buf, r.address, r.port); } catch (e) { this.o.log(`局域网信令处理出错（已丢弃）：${(e as Error).message}`); } });
      s.bind(this.o.port, () => { this.sock = s; this.bound = s.address().port; resolve(); });
    });
  }
  stop() { try { this.sock?.close(); } catch {} this.sock = undefined; this.bound = 0; }

  private onPacket(buf: Buffer, addr: string, port: number) {
    if (buf.length > LAN_MAX_PACKET || !privateAddr(addr)) return;
    const now = Date.now(), times = (this.rate.get(addr) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_MAX) return;
    times.push(now); this.rate.set(addr, times);
    if (this.rate.size > 256) this.rate.delete(this.rate.keys().next().value!);
    let env: any;
    try { env = JSON.parse(buf.toString("utf8")); } catch { return; }
    if (!env || typeof env !== "object" || typeof env.from !== "string" || !BODY_NAME.test(env.from) || env.from === this.o.me || env.to !== this.o.me) return;
    this.o.onEnvelope(env.from, env, addr, port);
  }

  /** 发一个签名信封给某具身体：记得它的局域网地址才发。返回是否发出。 */
  send(body: string, env: unknown): boolean {
    const e = this.table[body];
    if (!this.sock || !e) return false;
    const buf = Buffer.from(JSON.stringify(env));
    if (buf.length > LAN_MAX_PACKET) return false;
    try { this.sock.send(buf, e.port, e.addr); return true; } catch { return false; }
  }

  /** 记下某具身体的局域网地址（只在验证过身份之后调用）。地址或端口不变就只更新时间，不写盘。 */
  learn(body: string, addr: string, port: number) {
    if (!BODY_NAME.test(body) || body === this.o.me || !privateAddr(addr) || !validPort(port)) return;
    const old = this.table[body], now = Date.now();
    this.table[body] = { addr, port, at: now };
    if (old && old.addr === addr && old.port === port) return;
    const names = Object.keys(this.table);
    if (names.length > MAX_PEERS) delete this.table[names.sort((a, b) => this.table[a].at - this.table[b].at)[0]];
    this.o.log(`记下 ${body} 的局域网地址`);
    this.save();
  }

  known(): string[] { return Object.keys(this.table); }
  has(body: string) { return Object.hasOwn(this.table, body); }

  private save() {
    if (!this.o.file) return;
    try { fs.mkdirSync(path.dirname(this.o.file), { recursive: true }); fs.writeFileSync(this.o.file, JSON.stringify(this.table, null, 2)); } catch {}
  }
}
