// OpenClaw：工作区（默认 ~/.openclaw/workspace，可由 OPENCLAW_WORKSPACE_DIR / OPENCLAW_PROFILE 改变）
//   SOUL.md                    ↔ SOUL.md
//   MEMORY.md（自由 Markdown） ↔ memories/MEMORY.md：写回为列表，每条一个「- 」项；agent 自己写进来的段落或列表项会被当作新条目吸收
//   USER.md                    ↔ memories/USER.md（同上）
//   memory/YYYY-MM-DD*.md      → journal/<本身体>/（日记单向导出）
//   journal/<其他身体>/        → memory/bodies/<身体>/（只读镜像，OpenClaw 的 memory_search 可检索到）
//   memory/notes/*.md          ↔ notes/*.md（共享笔记双向）
// OpenClaw 拒绝软链接的 MEMORY.md，因此采用复制；引导文件每轮重新读取，写回后下一轮生效。
// 钩子：~/.openclaw/hooks/soul-bridge/（HOOK.md + handler.js），在启动、/new、/reset、压缩后触发同步。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { Framework } from "../types.ts";

const HEADER = "<!-- soul-bridge：以下条目与灵魂仓库双向同步。新增一条就写一个「- 」列表项；删除条目即删除对应项。 -->";

/** 把自由 Markdown 拆成条目：列表项（含缩进续行）或以空行分隔的段落；标题与注释行忽略。 */
export function readMarkdownEntries(text: string): string[] {
  const out: string[] = [];
  let cur: string[] | undefined;
  const flush = () => { if (cur?.length) out.push(cur.join("\n").trim()); cur = undefined; };
  for (const line of text.split("\n")) {
    if (/^\s*<!--.*-->\s*$/.test(line) || /^#{1,6}\s/.test(line)) { flush(); continue; }
    if (/^[-*]\s+/.test(line)) { flush(); cur = [line.replace(/^[-*]\s+/, "")]; continue; }
    if (!line.trim()) { flush(); continue; }
    if (cur && /^\s{2,}/.test(line)) { cur.push(line.replace(/^\s{2}/, "")); continue; }
    if (!cur) cur = [];
    cur.push(line);
  }
  flush();
  return out.filter(Boolean).filter((e, i, a) => a.indexOf(e) === i);
}

export const renderMarkdownEntries = (title: string) => (entries: string[]) =>
  `# ${title}\n\n${HEADER}\n\n${entries.map((e) => "- " + e.replace(/\n/g, "\n  ")).join("\n")}\n`;

const hookDir = () => path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"), "hooks", "soul-bridge");
const run = (cmd: string, args: string[]) => new Promise<boolean>((r) => execFile(cmd, args, { timeout: 120_000 }, (e) => r(!e)));

export const openclaw: Framework = {
  id: "openclaw",
  label: "OpenClaw",
  defaultHome: () => process.env.OPENCLAW_WORKSPACE_DIR
    ?? path.join(os.homedir(), process.env.OPENCLAW_PROFILE ? `.openclaw-${process.env.OPENCLAW_PROFILE}` : ".openclaw", "workspace"),
  mappings: (home, body) => [
    { id: "soul", kind: "text", native: path.join(home, "SOUL.md"), soul: "SOUL.md" },
    { id: "memory", kind: "entries", native: path.join(home, "MEMORY.md"), soul: "memories/MEMORY.md", read: readMarkdownEntries, render: renderMarkdownEntries("MEMORY") },
    { id: "user", kind: "entries", native: path.join(home, "USER.md"), soul: "memories/USER.md", limit: 4000, read: readMarkdownEntries, render: renderMarkdownEntries("USER") },
    { id: "journal-out", kind: "files-out", nativeDir: path.join(home, "memory"), soulDir: `journal/${body}`, match: /^\d{4}-\d{2}-\d{2}.*\.md$/ },
    { id: "journal-in", kind: "files-in", soulRoot: "journal", nativeDir: path.join(home, "memory", "bodies"), exclude: body },
    { id: "notes", kind: "files-both", nativeDir: path.join(home, "memory", "notes"), soulDir: "notes" },
  ],
  guessName: (home) => {
    try { return fs.readFileSync(path.join(home, "IDENTITY.md"), "utf8").match(/name[^:：]*[:：]\s*(.+)/i)?.[1].trim(); } catch { return undefined; }
  },
  async installHooks(_home, cmd) {
    fs.mkdirSync(hookDir(), { recursive: true });
    fs.writeFileSync(path.join(hookDir(), "HOOK.md"), `---
name: soul-bridge
description: "把人格与记忆同步到灵魂仓库（soul-bridge）"
metadata: { "openclaw": { "events": ["gateway:startup", "command:new", "command:reset", "session:compact:after", "gateway:shutdown"], "requires": { "bins": ["git", "node"] } } }
---
`);
    fs.writeFileSync(path.join(hookDir(), "handler.js"), `import { spawn } from "node:child_process";
// 后台触发同步，不阻塞 OpenClaw
export default () => { spawn(${JSON.stringify(cmd[0])}, ${JSON.stringify(cmd.slice(1))}, { detached: true, stdio: "ignore" }).unref(); };
`);
    const ok = await run("openclaw", ["hooks", "enable", "soul-bridge"]);
    return ok ? "已安装并启用 OpenClaw 钩子" : `已写入钩子目录 ${hookDir()}；请在 OpenClaw 配置中启用 hooks.internal.entries["soul-bridge"]`;
  },
  async removeHooks() {
    await run("openclaw", ["hooks", "disable", "soul-bridge"]);
    fs.rmSync(hookDir(), { recursive: true, force: true });
  },
  async afterExport() { await run("openclaw", ["memory", "index"]); },
};
