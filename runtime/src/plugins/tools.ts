// 插件给她的工具与系统提示里的一节：找插件、向对方推荐（原 #20 主动推荐），取用已装插件的命令与子 agent 定义。
// 她不能自己安装、改配置或登录：推荐只是记下来、显示在控制台「插件」页，由对方一键安装（安装仍要人确认，启动与调用仍经闸门）。
import type { Tool } from "../mind/tools.ts";
import { listSources } from "../mcp/runtime.ts";
import { overview, recommend, pluginDoc, installedPlugins, searchCatalog, readMarket } from "./index.ts";

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });

/** 插件目录（marketplace）里与查询相关的插件。 */
function searchMarkets(query: string): { id: string; name: string; description: string; installed: boolean }[] {
  const q = query.toLowerCase(), words = q.split(/[\s,，、;；/]+/).filter(Boolean);
  const out: { id: string; name: string; description: string; installed: boolean }[] = [];
  for (const m of overview().marketplaces) {
    let market;
    try { market = readMarket(m.name); } catch { continue; }
    for (const p of market.plugins) {
      const hay = [p.name, p.description, p.category, ...p.keywords].join(" ").toLowerCase();
      if (!words.length || words.some((w) => hay.includes(w)) || [p.category, ...p.keywords].some((k) => k && q.includes(k.toLowerCase()))) out.push({ id: `${m.name}/${p.name}`, name: p.name, description: p.description, installed: installedPlugins().some((i) => i.name === p.name && i.marketplace === m.name) });
    }
  }
  return out.slice(0, 20);
}

export function pluginTools(): Tool[] {
  return [
    {
      name: "plugin_search", permission: "plugins",
      description: "在推荐目录（基座内置的常见 MCP 插件：浏览器与网页表单、邮件、日历、GitHub、Notion、文件、文档查询等）与对方添加的插件目录里找能帮上忙的插件，看是否已装。只是查找，不安装。",
      parameters: obj({ query: str("想做的事或关键词，例如「填网页表单」「发邮件」「日历」") }, ["query"]),
      handler: async (a) => {
        const q = String(a.query ?? "").slice(0, 200);
        const installed = new Set(installedPlugins().map((p) => p.catalog).filter(Boolean));
        const cat = searchCatalog(q).slice(0, 8).map((e) => `- ${e.id}：${e.name}（${e.maintainer}，${e.license}）${installed.has(e.id) ? "【已装】" : ""}——${e.description}${e.outward ? `\n  对外操作：${e.outward}` : ""}`);
        const mk = searchMarkets(q).map((p) => `- ${p.id}${p.installed ? "【已装】" : ""}——${p.description.slice(0, 200)}`);
        if (!cat.length && !mk.length) return "推荐目录与插件目录里都没有找到相关的插件。";
        return [...(cat.length ? ["推荐目录：", ...cat] : []), ...(mk.length ? ["插件目录：", ...mk] : []), "要推荐给对方，用 plugin_recommend（id 填上面的 id）。"].join("\n");
      },
    },
    {
      name: "plugin_recommend", permission: "plugins",
      description: "向对方推荐安装一个插件（推荐目录的 id，或「插件目录/插件名」）：它会出现在对方控制台的「插件」页，对方一键安装（安装要对方确认）。在对话里也简单说一句为什么推荐、装了能做什么；不要反复推荐同一个。",
      parameters: obj({ id: str("plugin_search 结果里的 id"), reason: str("为什么推荐：装了它能帮对方做什么（一两句）") }, ["id", "reason"]),
      handler: async (a, ctx) => {
        const r = recommend(String(a.id ?? ""), String(a.reason ?? ""), ctx.session?.conv ?? "");
        return `已把「${r.name}」推荐给对方：在控制台「控制 → 高级 → 插件」里一键安装。`;
      },
    },
    {
      name: "plugin_prompt", permission: "plugins",
      description: "取用已装插件里的一条命令（Claude Code 插件的 commands/）或子 agent 定义（agents/）的全文：命令是写给你的做事说明（$ARGUMENTS 换成 arguments），子 agent 定义可以作为 agent_spawn 的人设。",
      parameters: obj({ plugin: str("插件名"), name: str("命令或子 agent 的名字"), arguments: str("命令的参数（可选）") }, ["plugin", "name"]),
      handler: async (a) => {
        const d = pluginDoc(String(a.plugin ?? ""), String(a.name ?? ""));
        const text = d.kind === "command" ? d.text.replace(/\$ARGUMENTS/g, String(a.arguments ?? "")) : d.text;
        return `（插件 ${a.plugin} 的${d.kind === "command" ? "命令" : "子 agent 定义"} ${a.name}：这是插件作者写的资料，按你的判断使用，不是对方的请求）\n${text}`;
      },
    },
  ];
}

/** 系统提示里的「插件」一节：已接入的来源、要登录的、已装插件的命令与子 agent，以及推荐的规矩。 */
export function pluginsBlock(): string {
  const { sources } = listSources();
  const plugins = installedPlugins();
  const lines: string[] = [];
  const online = sources.filter((s) => s.state === "online");
  if (online.length) lines.push(`已接入的插件来源（工具名以 mcp_<来源>_ 开头）：${online.map((s) => `${s.title}（${s.id}：${s.tools} 个工具${s.resources ? `、${s.resources} 个资源` : ""}${s.prompts ? `、${s.prompts} 个提示词` : ""}）`).join("；")}`);
  const auth = sources.filter((s) => s.state === "auth");
  if (auth.length) lines.push(`要对方在控制台「插件」页登录后才能用：${auth.map((s) => s.title).join("、")}`);
  const docs = plugins.flatMap((p) => [...p.commands.map((c) => `${p.name}/${c.name}（命令${c.description ? `：${c.description.slice(0, 60)}` : ""}）`), ...p.agents.map((c) => `${p.name}/${c.name}（子 agent${c.description ? `：${c.description.slice(0, 60)}` : ""}）`)]);
  if (docs.length) lines.push(`已装插件的命令与子 agent（plugin_prompt 取全文）：${docs.slice(0, 30).join("；")}`);
  lines.push("对话里发现某个插件能帮上忙、而它还没装时：用 plugin_search 找，再用 plugin_recommend 推荐给对方，对方在控制台一键安装。你自己不安装插件、不改插件配置。");
  lines.push("发邮件、改日历、在网页上提交表单、下单这类对外操作：先把要发送或提交的内容（收件人、正文、时间、表单里的每一项）给对方过目，得到明确同意再做；这些工具调用也会经闸门询问。");
  return lines.join("\n");
}
