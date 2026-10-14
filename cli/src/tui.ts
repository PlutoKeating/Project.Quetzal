// 终端控制台：只调用本机网关，不另建 agent，不自动重发外部操作。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { Writable } from "node:stream";

/** 过滤远端文本中的终端指令、控制字符与双向排版标记。 */
export function terminalText(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
export interface Gateway {
  connect(): Promise<void>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
export type GatewayEvent = (event: string, data: any) => void;

/** 第一帧认证，令牌不进 URL、日志或终端。请求超时/断线只报结果未知。 */
export class LocalGateway implements Gateway {
  private socket?: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; refresh(): void }>();
  private token = "";
  private ready = false;
  private home: string; private port: number; private event: GatewayEvent; private disconnected: () => void;
  constructor(home: string, port: number, event: GatewayEvent, disconnected: () => void) { this.home = home; this.port = port; this.event = event; this.disconnected = disconnected; }
  private failPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("连接断开：已发送操作的结果未知，不会自动重发。")); }
    this.pending.clear();
  }
  async connect() {
    if (this.socket) this.close();
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error("网关端口无效");
    try { this.token = fs.readFileSync(path.join(this.home, "secrets", "gateway.token"), "utf8").trim(); } catch { this.token = ""; }
    if (!this.token) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/auth/local`, { redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error();
        const auth = await response.json();
        if (typeof auth.token !== "string") throw new Error();
        this.token = auth.token;
      } catch { throw new Error("本机认证失败，请确认运行基座已启动，并使用其同一用户和正确 --home；可用 quetzal open 打开控制台。"); }
    }
    if (this.token.length > 4096) throw new Error("本机认证文件无效");
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/rpc`);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let authenticated = false;
      const timer = setTimeout(() => { socket.close(); reject(new Error("网关认证超时")); }, 5000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ auth: this.token })));
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || event.data.length > 4 * 1024 * 1024) return;
        let message: any; try { message = JSON.parse(event.data); } catch { return; }
        if (!message || typeof message !== "object") return;
        if (message.event === "hello") { authenticated = true; this.ready = true; clearTimeout(timer); resolve(); return; }
        if (!authenticated) return;
        if (message.event === "rpc.progress") { this.pending.get(message.data?.id)?.refresh(); return; }
        if (typeof message.event === "string") { this.event(message.event, message.data); return; }
        const p = this.pending.get(message.id);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(message.id);
        // 不回显网关原始错误：其中可能有参数、私有地址或凭据。
        if (message.error) p.reject(new Error("网关请求失败，请在控制台检查状态。")); else p.resolve(message.result);
      });
      socket.addEventListener("error", () => { if (!authenticated) { clearTimeout(timer); reject(new Error("连接本机网关失败，请先启动运行基座。")); } });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.ready = false; this.socket = undefined; this.failPending();
        if (!authenticated) reject(new Error("网关认证失败，请核对 --home 或重新打开控制台。"));
        else this.disconnected();
      });
    });
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("尚未连接；输入 /reconnect 重新连接，不会重发旧消息。"));
    const socket = this.socket, id = ++this.seq;
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, timer: undefined as unknown as NodeJS.Timeout, refresh: () => {} };
      p.refresh = () => {
        clearTimeout(p.timer);
        p.timer = setTimeout(() => { this.pending.delete(id); reject(new Error("请求无进展：结果未知，不会重发；请查看 /history 或控制台。")); }, 45000);
      };
      this.pending.set(id, p); p.refresh();
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(p.timer); this.pending.delete(id); reject(new Error("发送失败，结果未知，不会自动重发。")); }
    });
  }
  safe(text: unknown) { return terminalText(text).replaceAll(this.token || "\0", "[凭据]"); }
  close() { this.ready = false; const socket = this.socket; this.socket = undefined; this.failPending(); socket?.close(); }
}

const HELP = "/sessions 列会话 · /use 编号 选择 · /new [标题] 新建 · /history 历史\n/approvals 审批 · /approve 编号 · /deny 编号 · /stop 停止本会话\n/reconnect 重连 · /quit 退出 · 普通文字发给同一个 agent（默认插话）\n保密输入不在终端接收，请使用 quetzal open。";
interface Conversation { id: string; title?: string }
interface Approval { id: string; body?: string; action?: string; reason?: string; status?: string; kind?: string }
export class TerminalChat {
  conv = "";
  secretBlocked = true; // 初始化前不可发送；重连时同样屏蔽回显。
  private sessions: Conversation[] = [];
  private approvals: Approval[] = [];
  private secrets = new Set<string>();
  private active = new Map<string, string>();
  private streaming = new Set<string>();
  private displayed = new Set<string>();
  private initializing = false;
  private connectionEpoch = 0;
  private buffered: { event: string; data: any }[] = [];
  private gateway: Gateway; private write: (text: string, stream?: boolean) => void; private mute: (blocked: boolean) => void; private quit: () => void; private initialConv?: string;
  constructor(gateway: Gateway, write: (text: string, stream?: boolean) => void, mute: (blocked: boolean) => void, quit: () => void, initialConv?: string) { this.gateway = gateway; this.write = write; this.mute = mute; this.quit = quit; this.initialConv = initialConv; }
  private print(text: unknown) { this.write(terminalText(text)); }
  private block() { this.secretBlocked = !this.conv || this.secrets.has(this.conv); this.mute(this.secretBlocked); }
  async start() {
    this.secretBlocked = true; this.mute(true);
    const epoch = this.connectionEpoch;
    this.initializing = true; this.buffered = [];
    try {
      await this.gateway.connect();
      const [sessions, secrets, approvals, live] = await Promise.all([
        this.gateway.request("sessions"), this.gateway.request("secrets.pending"), this.gateway.request("approvals"), this.gateway.request("sessions.live"),
      ]);
      this.sessions = Array.isArray(sessions) ? sessions : [];
      this.secrets = new Set(Array.isArray(secrets) ? secrets.map((s) => s.conv) : []);
      this.approvals = Array.isArray(approvals) ? approvals : [];
      this.active.clear(); this.streaming.clear(); this.displayed.clear();
      if (Array.isArray(live)) for (const turn of live) if (typeof turn.turn === "string") this.active.set(turn.turn, turn.conv);
      if (this.initialConv && !this.conv) {
        if (!this.sessions.some((s) => s.id === this.initialConv)) throw new Error("指定会话不存在，请用 /sessions 选择已有会话。");
        this.conv = this.initialConv;
      }
      if (!this.conv) this.conv = this.sessions[0]?.id ?? "";
      if (!this.conv) { const s = await this.gateway.request("sessions.create", { title: "终端对话" }) as Conversation; this.conv = s.id; }
      if (epoch !== this.connectionEpoch) throw new Error("恢复期间连接已断开，请重新连接。");
      this.initializing = false;
      for (const pending of this.buffered.splice(0)) this.event(pending.event, pending.data);
      this.block();
      this.print(`已连接同一个 agent。会话 ${this.conv}\n${HELP}`);
      await this.history();
      if (this.secretBlocked) this.print("本会话正在接收保密值：已屏蔽输入回显，终端不发送任何普通输入。请转到控制台完成或取消。");
      if ([...this.active.values()].includes(this.conv)) this.print("本会话有进行中的轮次；可继续插话或 /stop。不会重发断线前的请求。");
      this.showApprovals();
    } catch (error) { this.initializing = false; this.secretBlocked = true; this.mute(true); throw error; }
  }
  disconnected() { this.connectionEpoch++; this.secretBlocked = true; this.mute(true); this.print("连接已断开，输入回显已屏蔽。操作结果可能未知；输入 /reconnect 只恢复状态，不重发消息，或 /quit 退出。"); }
  event(event: string, data: any) {
    if (this.initializing) { this.buffered.push({ event, data }); return; }
    if (!data || typeof data !== "object") return;
    if (event === "secret" && typeof data.conv === "string") {
      if (data.status === "open" || data.status === "progress") this.secrets.add(data.conv); else this.secrets.delete(data.conv);
      this.block();
      if (data.conv === this.conv && this.secretBlocked) this.print("保密输入已开始：回显关闭，普通输入不会发送。请在控制台完成或取消；不要在终端输入凭据。");
      else if (data.conv === this.conv) this.print("保密输入已结束，可继续普通对话。");
    } else if (event === "approval") {
      const key = (a: Approval) => `${a.body ?? ""}/${a.id}`;
      this.approvals = this.approvals.filter((a) => key(a) !== key(data));
      if (data.status === "pending") { this.approvals.push(data); this.showApprovals(); }
    } else if (event === "session.switch" && data.from === this.conv && typeof data.to === "string") {
      this.conv = data.to; this.block(); this.print(`已切换到会话 ${this.conv}`);
    } else if (event === "activity" && typeof data.session === "string") {
      if (data.kind === "start" || data.kind === "queued") this.active.set(data.session, data.conv);
      if (data.kind === "done" || data.kind === "error") { this.active.delete(data.session); this.streaming.delete(data.session); }
      if (data.conv !== this.conv) return;
      if (data.kind === "step") { this.streaming.delete(data.session); }
      else if (data.kind === "delta") { this.streaming.add(data.session); this.displayed.add(data.session); this.write(terminalText(data.text), true); }
      else if (data.kind === "tool") this.print(`\n[工具 ${data.name}：${data.status}]`); // 不打印 summary / args / result。
      else if (data.kind === "text" && !this.streaming.has(data.session) && data.text) { this.displayed.add(data.session); this.print(data.text); }
      else if (data.kind === "done" || data.kind === "error") {
        if (data.reply && !this.displayed.has(data.session)) { this.displayed.add(data.session); this.print(data.reply); }
        if (this.displayed.size > 1000) this.displayed.delete(this.displayed.values().next().value!);
        this.print(data.kind === "error" ? "\n[轮次中断，请查看控制台或 /history]" : "\n[轮次结束]");
      }
    }
  }
  private showApprovals() {
    const pending = this.approvals.filter((a) => a.status === "pending");
    this.approvals = pending;
    if (!pending.length) { this.print("没有待审批动作。"); return; }
    pending.forEach((a, i) => this.print(`${i + 1}. ${a.action ?? "动作"}${a.kind === "host" ? "（进入真实环境）" : ""} · ${a.reason ?? ""}\n   /approve ${i + 1} 或 /deny ${i + 1}；完整参数请到控制台核对。`));
  }
  private async history() {
    if (!this.conv) return;
    const history = await this.gateway.request("sessions.messages", { id: this.conv, limit: 10 });
    if (Array.isArray(history)) for (const m of history) if (m.mode !== "ignored" && m.role !== "ambient") this.print(`${m.role === "agent" ? "agent" : "你"}：${m.text}`);
  }
  async line(input: string, blockedAtInput = false) {
    if (!input.trim()) return;
    const originalConv = this.conv;
    const [command, ...parts] = input.trim().split(/\s+/), argument = parts.join(" ");
    if ((this.secretBlocked || blockedAtInput) && !managementInput(input)) {
      this.print("输入未发送：输入时处于保密/断线状态，只接受无正文的管理命令，请到控制台完成或取消。"); return;
    }
    if (command === "/quit" || command === "/exit") { this.gateway.close(); this.quit(); return; }
    if (command === "/help") { this.print(HELP); return; }
    if (command === "/reconnect") { await this.start(); return; }
    if (command === "/stop") { await this.gateway.request("chat.stop", { conv: this.conv }); this.print("已请求停止当前会话。"); return; }
    if (command === "/sessions") {
      const sessions = await this.gateway.request("sessions"); this.sessions = Array.isArray(sessions) ? sessions : [];
      this.sessions.forEach((s, i) => this.print(`${i + 1}. ${s.title ?? s.id}${s.id === this.conv ? "（当前）" : ""}`)); return;
    }
    if (command === "/use") {
      const selected = this.sessions[Number(argument) - 1]; if (!selected) throw new Error("输入 /sessions 查看编号，再用 /use 编号选择。");
      this.conv = selected.id; this.block(); await this.history(); return;
    }
    if (command === "/new") {
      const s = await this.gateway.request("sessions.create", { title: argument || "终端对话" }) as Conversation;
      this.conv = s.id; this.block(); this.print(`新会话 ${this.conv}`); return;
    }
    if (command === "/history") { await this.history(); return; }
    if (command === "/approvals") {
      const approvals = await this.gateway.request("approvals"); this.approvals = Array.isArray(approvals) ? approvals : []; this.showApprovals(); return;
    }
    if (command === "/approve" || command === "/deny") {
      const a = this.approvals[Number(argument) - 1]; if (!a) throw new Error("请先用 /approvals 查看编号。");
      const result = await this.gateway.request("decide", { id: a.id, body: a.body, approve: command === "/approve" });
      this.print(result ? "审批决定已送达。" : "审批已失效或无法处理，请刷新列表。"); return;
    }
    if (command.startsWith("/")) throw new Error("不认识的终端命令，输入 /help 查看。");
    if (this.secretBlocked) { this.print("普通输入未发送：保密输入或连接未就绪，请使用控制台或 /reconnect。"); return; }
    // 发送前再次核对保密输入，防止其他控制台刚开启而本地尚未看到推送。
    const secrets = await this.gateway.request("secrets.pending");
    if (this.conv !== originalConv || this.secretBlocked || this.secrets.has(originalConv)) {
      this.print("输入未发送：发送前会话或保密/连接状态已改变，请确认当前状态。"); return;
    }
    if (Array.isArray(secrets) && secrets.some((s) => s.conv === originalConv)) {
      this.secrets.add(this.conv); this.block(); this.print("普通输入未发送：请在控制台完成保密输入。"); return;
    }
    const conv = originalConv, turn = crypto.randomUUID();
    // 不等待长对话完成，确保 /stop、审批与插话仍可响应；只发送一次。
    void this.gateway.request("chat.send", { text: input, conv, turn, mode: "steer" }).then((reply) => {
      if (typeof reply === "string" && reply && !this.displayed.has(turn)) this.print(`agent：${reply}`);
    }).catch(() => this.print("消息结果未知或请求失败；不会重发，请检查 /history 或控制台。"));
  }
}

/** 保密状态只放行无正文命令和已显示列表中的数字编号。 */
function managementInput(input: string): boolean {
  const [command, ...args] = input.trim().split(/\s+/);
  return (!args.length && ["/quit", "/exit", "/help", "/reconnect", "/stop", "/sessions", "/new", "/history", "/approvals"].includes(command))
    || (args.length === 1 && /^\d+$/.test(args[0]) && ["/use", "/approve", "/deny"].includes(command));
}

/** 在 readline 收到输入时固定保护状态，不因排队期间秘密输入结束而重新放行。 */
export class TerminalInputQueue {
  private chat: TerminalChat;
  private pending = Promise.resolve();
  constructor(chat: TerminalChat) { this.chat = chat; }
  enqueue(input: string): Promise<void> {
    const blockedAtInput = this.chat.secretBlocked;
    // 正文立即拒绝，不把保密值放入等待其他命令完成的队列。
    if (blockedAtInput && !managementInput(input)) return this.chat.line(input, true);
    const job = this.pending.then(() => this.chat.line(input, blockedAtInput));
    this.pending = job.catch(() => {});
    return job;
  }
}

export async function runTui(home: string, port: number, conv?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("chat/tui 需要交互终端；请直接运行 quetzal tui，或用 quetzal open 打开控制台。");
  let muted = true;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true, historySize: 0, prompt: "你> " });
  let chat: TerminalChat;
  const gateway = new LocalGateway(home, port, (event, data) => chat.event(event, data), () => chat.disconnected());
  const print = (text: string, stream = false) => { process.stdout.write(`${gateway.safe(text)}${stream ? "" : "\n"}`); if (!muted && !stream) rl.prompt(true); };
  chat = new TerminalChat(gateway, print, (blocked) => {
    if (blocked) {
      muted = true;
      rl.write(null, { ctrl: true, name: "u" }); // 保密/断线时丢弃尚未提交的输入，不写入历史。
      readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
    } else muted = false;
  }, () => rl.close(), conv);
  const inputQueue = new TerminalInputQueue(chat);
  rl.on("line", (line) => {
    void inputQueue.enqueue(line).catch((e) => print(e instanceof Error ? e.message : "终端操作失败"))
      .then(() => { if (!muted) rl.prompt(); });
  });
  rl.on("SIGINT", () => { void chat.line("/stop").catch(() => print("停止请求未送达，请在控制台检查。")); });
  const terminate = () => rl.close(); process.once("SIGTERM", terminate);
  const closed = new Promise<void>((resolve) => rl.once("close", () => { gateway.close(); resolve(); }));
  try { await chat.start(); if (!muted) rl.prompt(); await closed; }
  finally { gateway.close(); rl.close(); output.destroy(); process.removeListener("SIGTERM", terminate); }
}
