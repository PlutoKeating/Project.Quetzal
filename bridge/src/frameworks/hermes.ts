// Hermes Agent（NousResearch）：$HERMES_HOME（默认 ~/.hermes）
//   SOUL.md              ↔ SOUL.md
//   memories/MEMORY.md   ↔ memories/MEMORY.md（§ 分隔，上限取 config.yaml 的 memory_char_limit，默认 2200）
//   memories/USER.md     ↔ memories/USER.md（上限 user_char_limit，默认 1375）
// Hermes 只在会话开始时读取记忆快照，外部改动在下一个会话生效；写回必须保持 § 格式且不超上限，否则 Hermes 下次写入会拒绝。
// 钩子：config.yaml 的 shell hooks —— memory 工具调用后、会话收尾时触发同步。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEntries, joinEntries } from "../../../runtime/src/memory/entries.ts";
import type { Framework } from "../types.ts";

const BEGIN = "# >>> soul-bridge >>>", END = "# <<< soul-bridge <<<";
const cfg = (home: string) => path.join(home, "config.yaml");
const limit = (home: string, key: string, d: number) => {
  const m = (fs.existsSync(cfg(home)) ? fs.readFileSync(cfg(home), "utf8") : "").match(new RegExp(`^\\s*${key}:\\s*(\\d+)`, "m"));
  return m ? Number(m[1]) : d;
};

export const hermes: Framework = {
  id: "hermes",
  label: "Hermes Agent",
  defaultHome: () => process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes"),
  mappings: (home) => [
    { id: "soul", kind: "text", native: path.join(home, "SOUL.md"), soul: "SOUL.md" },
    { id: "memory", kind: "entries", native: path.join(home, "memories", "MEMORY.md"), soul: "memories/MEMORY.md", limit: limit(home, "memory_char_limit", 2200), read: parseEntries, render: (e) => joinEntries(e) },
    { id: "user", kind: "entries", native: path.join(home, "memories", "USER.md"), soul: "memories/USER.md", limit: limit(home, "user_char_limit", 1375), read: parseEntries, render: (e) => joinEntries(e) },
  ],
  guessName: (home) => {
    try { return fs.readFileSync(path.join(home, "SOUL.md"), "utf8").match(/^#\s+(.+)$/m)?.[1].trim(); } catch { return undefined; }
  },
  async installHooks(home, cmd) {
    const c = cmd.map((x) => (/[\s"']/.test(x) ? `'${x}'` : x)).join(" ");
    const block = `${BEGIN}
  post_tool_call:
    - matcher: "^memory$"
      command: "${c}"
      timeout: 60
  on_session_finalize:
    - command: "${c}"
      timeout: 60
${END}`;
    const text = fs.existsSync(cfg(home)) ? fs.readFileSync(cfg(home), "utf8") : "";
    if (text.includes(BEGIN)) return "Hermes 钩子已存在";
    if (/^hooks:/m.test(text)) {
      // 已有 hooks 段：把我们的条目插到 hooks: 下面（以标记包裹，便于卸载）
      fs.writeFileSync(cfg(home), text.replace(/^hooks:[^\n]*\n/m, (h) => h + block + "\n"));
    } else fs.writeFileSync(cfg(home), text + (text.endsWith("\n") || !text ? "" : "\n") + "hooks:\n" + block + "\n");
    return "已在 config.yaml 注册 Hermes 钩子（memory 工具调用后、会话收尾时同步）。Hermes 第一次触发时会请求确认，同意即可。";
  },
  async removeHooks(home) {
    if (!fs.existsSync(cfg(home))) return;
    const text = fs.readFileSync(cfg(home), "utf8");
    fs.writeFileSync(cfg(home), text.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), "").replace(/^hooks:\n(?=\S|$)/m, ""));
  },
};
