// 常驻的 Windows PowerShell 5.1 子进程：每次启动 powershell.exe 要 0.3–0.8 秒，采样、通知、剪贴板这些常用操作走同一个进程。
//   协议：一行一个请求「Q '<编号>' '<base64(UTF-8 脚本)>'」，一行一个回答「<编号> OK|ERR <base64(UTF-8 输出)>」。脚本以 base64 传，不经过任何引号转义。
//   用 5.1 而不是 pwsh 7：PowerShell 7 去掉了 WinRT 投影，Toast、摄像头都要 WinRT。
//   一次调用超时就结束这个进程，下一次调用重新起。不弹窗口。
import { spawn, execFile, type ChildProcess } from "node:child_process";
import path from "node:path";

export const powershell = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** PowerShell 单引号字符串。 */
export const psq = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

// 「-Command -」模式：PowerShell 从标准输入逐行读命令并执行（node-powershell 等也是这样做）。第一行定义处理函数，之后每个请求一行「Q '<编号>' '<base64>'」
const PRELUDE = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);function Q($id,$b){try{$c=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));$o=& ([scriptblock]::Create($c)) 2>&1|Out-String -Width 4096;$s='OK'}catch{$o=$_.Exception.Message;$s='ERR'};[Console]::Out.WriteLine($id+' '+$s+' '+[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$o)));[Console]::Out.Flush()}";

export class PsHost {
  private p?: ChildProcess;
  private buf = "";
  private seq = 0;
  private waiting = new Map<string, { resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private ensure(): ChildProcess {
    if (this.p && this.p.exitCode === null && !this.p.killed) return this.p;
    const p = spawn(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.buf = "";
    p.stdout!.setEncoding("ascii");
    p.stdout!.on("data", (d: string) => {
      this.buf += d;
      let n;
      while ((n = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, n).trim(); this.buf = this.buf.slice(n + 1);
        const [id, state, b64 = ""] = line.split(" ");
        const w = this.waiting.get(id);
        if (!w) continue;
        this.waiting.delete(id); clearTimeout(w.timer);
        const text = Buffer.from(b64, "base64").toString("utf8").replace(/\r\n/g, "\n").trimEnd();
        state === "OK" ? w.resolve(text) : w.reject(new Error(text || "PowerShell 出错"));
      }
    });
    const fail = (why: string) => { for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(why)); } this.waiting.clear(); if (this.p === p) this.p = undefined; };
    p.on("exit", () => fail("PowerShell 退出了"));
    p.on("error", (e) => fail(`PowerShell 起不来：${e.message}`));
    p.stdin!.on("error", () => {});
    p.stdin!.write(PRELUDE + "\n");
    this.p = p;
    return p;
  }

  /** 执行一段脚本，返回它的输出（文本）。脚本出错（抛异常）时拒绝。 */
  run(script: string, timeoutMs = 20_000): Promise<string> {
    const p = this.ensure();
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没有结果`)); this.stop(); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      p.stdin!.write(`Q '${id}' '${Buffer.from(script, "utf8").toString("base64")}'\n`);
    });
  }

  stop() { try { this.p?.kill(); } catch { /* 已退出 */ } this.p = undefined; }
}

/** 单独起一个 PowerShell 进程执行（录音、拍照这类要等很久的，不占住常驻进程）。 */
export function runOnce(script: string, timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$ProgressPreference = 'SilentlyContinue'\n${script}`)],
      { timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true }, (e: any, out, err) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out || err || e?.message || "") }));
  });
}
