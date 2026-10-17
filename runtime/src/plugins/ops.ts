// 控制台「插件」页的网关方法（并入 ops.ts）：MCP 来源的增删、启停、同步方式、OAuth 登录，插件的预览 / 安装 / 卸载，插件目录与推荐。
// 都只给持网关令牌的控制台用；她的工具里没有这些（她只能 plugin_recommend）。修改类操作都写审计。
import * as mcp from "../mcp/runtime.ts";
import * as plugins from "./index.ts";

const s = (v: unknown) => (typeof v === "string" ? v : "");

export const pluginOps = {
  "mcp.list": () => mcp.listSources(),
  "mcp.detail": (a: { id: string }) => mcp.sourceDetail(s(a.id)),
  /** server：来源配置（同 config/mcp.json 的一项，id 可省）；secrets：要存进 secrets/ 的凭据（stdio 为环境变量名、远程为请求头名 → 值），只存不回。 */
  "mcp.add": (a: { server: Record<string, unknown>; secrets?: Record<string, string> }, actor: string) => mcp.addSource(a.server && typeof a.server === "object" ? a.server : {}, actor, a.secrets && typeof a.secrets === "object" ? a.secrets : {}),
  "mcp.update": (a: { id: string; enabled?: boolean; sync?: boolean }, actor: string) => mcp.updateSource(s(a.id), { ...(typeof a.enabled === "boolean" ? { enabled: a.enabled } : {}), ...(typeof a.sync === "boolean" ? { sync: a.sync } : {}) }, actor),
  "mcp.remove": (a: { id: string }, actor: string) => mcp.removeSource(s(a.id), actor),
  "mcp.restart": (a: { id: string }) => mcp.restartSource(s(a.id)),
  "mcp.login": (a: { id: string }, actor: string) => mcp.login(s(a.id), actor),
  /** 控制台不在这具身体上时：浏览器最后停在 http://127.0.0.1:<端口>/mcp/oauth/callback?… 打不开，把这个地址粘贴回来。 */
  "mcp.loginFinish": async (a: { url: string }, actor: string) => {
    let u: URL;
    try { u = new URL(s(a.url).trim()); } catch { throw new Error("粘贴的不是网址"); }
    return { id: await mcp.finishLogin(u.searchParams, actor) };
  },
  "mcp.logout": (a: { id: string }, actor: string) => mcp.logout(s(a.id), actor),

  plugins: () => plugins.overview(),
  "plugins.catalog": (a: { query?: string }) => plugins.searchCatalog(s(a.query)),
  "plugins.preview": (a: { source?: string; catalog?: string; marketplace?: string; plugin?: string }) => plugins.preview({ source: s(a.source) || undefined, catalog: s(a.catalog) || undefined, marketplace: s(a.marketplace) || undefined, plugin: s(a.plugin) || undefined }),
  "plugins.install": (a: { plan: string; inputs?: Record<string, Record<string, string>>; skip?: { mcp?: string[]; skills?: string[] }; enable?: boolean; replace?: boolean }, actor: string) => plugins.install(a, actor),
  "plugins.cancel": (a: { plan: string }) => plugins.cancel(s(a.plan)),
  "plugins.uninstall": (a: { name: string; keepSkills?: boolean }, actor: string) => plugins.uninstall({ name: s(a.name), keepSkills: a.keepSkills === true }, actor),
  "plugins.marketplace.add": (a: { source: string }, actor: string) => plugins.addMarketplace(s(a.source), actor),
  "plugins.marketplace.refresh": (a: { name: string }, actor: string) => plugins.refreshMarketplace(s(a.name), actor),
  "plugins.marketplace.remove": (a: { name: string }, actor: string) => plugins.removeMarketplace(s(a.name), actor),
  "plugins.dismiss": (a: { id: string }) => plugins.dismiss(s(a.id)),
};
