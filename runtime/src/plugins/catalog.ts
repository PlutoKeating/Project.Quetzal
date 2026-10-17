// 推荐目录：基座内置的一份精选 MCP 服务器清单（只放公开、有名的项目，注明许可与来源），给控制台「插件」页一键安装、给她推荐。
// 安装方式照各项目 README 里的官方写法（npx / uvx / 远程地址）；装的时候仍经控制台确认，启动仍经闸门 mcp_start.<id>，工具调用缺省每次询问。
// 许可与地址于 2026-10-17 核对 npm / PyPI / 项目仓库；第三方项目的行为与安全由各自维护者负责，安装前请看来源。

/** 安装时要填的值：env 进环境变量，header 进请求头，arg 追加到命令参数；secret 为真时存进 secrets/（0600），不进配置。 */
export interface CatalogInput { key: string; label: string; target: "env" | "header" | "arg"; name?: string; secret?: boolean; required?: boolean; format?: string; placeholder?: string }
export type CatalogServer =
  | { transport: "stdio"; runner: "npx" | "uvx"; package: string; args: string[]; env?: Record<string, string> }
  | { transport: "http" | "sse"; url: string; oauth: boolean };
export interface CatalogEntry {
  id: string; name: string; description: string; keywords: string[];
  category: "browser" | "email" | "calendar" | "dev" | "knowledge" | "files" | "thinking";
  license: string; source: string; maintainer: string;
  server: CatalogServer; inputs?: CatalogInput[];
  outward?: string; // 对外操作（发邮件、改日历、提交表单……）的提醒：这些工具调用按闸门把关
  setup?: string; // 第一次用之前要做的事（登录、授权文件）
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "playwright", name: "Playwright 浏览器", category: "browser", maintainer: "微软（官方）", license: "Apache-2.0", source: "https://github.com/microsoft/playwright-mcp",
    description: "用真实浏览器打开网页、点击、输入、填写并提交网页表单、截图与读取页面结构（无障碍树，不需要看图的模型）。",
    keywords: ["浏览器", "网页", "表单", "填写", "提交", "报名", "预约", "登录网站", "截图", "自动化", "browser", "form", "web"],
    server: { transport: "stdio", runner: "npx", package: "@playwright/mcp@latest", args: ["--headless", "--isolated"] },
    outward: "提交表单、下单、发帖这类对外操作：提交前先把要填的内容给对方过目，得到同意再点提交；工具调用缺省每次询问。",
    setup: "第一次用时如果提示缺浏览器，让她调用它的 browser_install 工具安装。去掉 --headless 可以看到浏览器窗口（需要桌面）。",
  },
  {
    id: "filesystem", name: "文件系统", category: "files", maintainer: "MCP 官方参考实现", license: "MIT / Apache-2.0", source: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    description: "在指定目录里读写、搜索、移动文件。只能访问你填的目录。",
    keywords: ["文件", "目录", "读写文件", "整理文件", "files", "filesystem"],
    server: { transport: "stdio", runner: "npx", package: "@modelcontextprotocol/server-filesystem", args: [] },
    inputs: [{ key: "dir", label: "允许访问的目录（绝对路径）", target: "arg", required: true, placeholder: "/home/me/Documents" }],
  },
  {
    id: "git", name: "Git 仓库", category: "dev", maintainer: "MCP 官方参考实现", license: "MIT", source: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    description: "查看与操作本地 git 仓库：状态、差异、日志、提交、分支。",
    keywords: ["git", "代码仓库", "提交", "分支", "diff", "代码"],
    server: { transport: "stdio", runner: "uvx", package: "mcp-server-git", args: [] },
    inputs: [{ key: "repo", label: "仓库路径（可留空，调用时再指定）", target: "arg", name: "--repository", placeholder: "/home/me/project" }],
  },
  {
    id: "sequential_thinking", name: "分步思考", category: "thinking", maintainer: "MCP 官方参考实现", license: "MIT / Apache-2.0", source: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    description: "把复杂问题拆成可修订、可分支的思考步骤。",
    keywords: ["思考", "规划", "拆解", "推理", "thinking", "plan"],
    server: { transport: "stdio", runner: "npx", package: "@modelcontextprotocol/server-sequential-thinking", args: [] },
  },
  {
    id: "github", name: "GitHub", category: "dev", maintainer: "GitHub（官方）", license: "MIT", source: "https://github.com/github/github-mcp-server",
    description: "GitHub 官方的远程 MCP：仓库、issue、PR、代码搜索、Actions。用你的个人访问令牌（PAT）。",
    keywords: ["github", "issue", "pull request", "pr", "代码", "仓库", "开源"],
    server: { transport: "http", url: "https://api.githubcopilot.com/mcp/", oauth: false },
    inputs: [{ key: "token", label: "GitHub 个人访问令牌（PAT）", target: "header", name: "Authorization", format: "Bearer {}", secret: true, required: true }],
    outward: "开 issue、评论、合并 PR 这类对外操作：工具调用缺省每次询问。",
  },
  {
    id: "context7", name: "Context7 文档", category: "knowledge", maintainer: "Upstash", license: "MIT", source: "https://github.com/upstash/context7",
    description: "查询各种编程库与框架的最新文档和示例。",
    keywords: ["文档", "编程", "api", "库", "框架", "docs", "library"],
    server: { transport: "http", url: "https://mcp.context7.com/mcp", oauth: false },
  },
  {
    id: "notion", name: "Notion", category: "knowledge", maintainer: "Notion（官方托管）", license: "服务条款", source: "https://developers.notion.com/docs/mcp",
    description: "Notion 官方的远程 MCP：搜索、读取、创建与编辑页面和数据库。OAuth 登录。",
    keywords: ["notion", "笔记", "文档", "知识库", "数据库", "页面"],
    server: { transport: "http", url: "https://mcp.notion.com/mcp", oauth: true },
    outward: "创建、修改、删除页面属于对外操作：工具调用缺省每次询问。",
  },
  {
    id: "linear", name: "Linear", category: "dev", maintainer: "Linear（官方托管）", license: "服务条款", source: "https://linear.app/docs/mcp",
    description: "Linear 官方的远程 MCP：查找、创建、更新 issue 与项目。OAuth 登录。",
    keywords: ["linear", "issue", "任务", "项目管理", "工单"],
    server: { transport: "http", url: "https://mcp.linear.app/mcp", oauth: true },
    outward: "创建、更新 issue 属于对外操作：工具调用缺省每次询问。",
  },
  {
    id: "sentry", name: "Sentry", category: "dev", maintainer: "Sentry（官方托管）", license: "服务条款", source: "https://docs.sentry.io/product/sentry-mcp/",
    description: "Sentry 官方的远程 MCP：查看错误、事件与性能问题。OAuth 登录。",
    keywords: ["sentry", "报错", "错误监控", "崩溃", "异常"],
    server: { transport: "http", url: "https://mcp.sentry.dev/mcp", oauth: true },
  },
  // ---------- 邮件（原 #24）
  {
    id: "email", name: "邮件（IMAP / SMTP）", category: "email", maintainer: "社区（Wh1isper）", license: "BSD-3-Clause", source: "https://github.com/Wh1isper/mcp-email-server",
    description: "任意支持 IMAP / SMTP 的邮箱（QQ、163、Outlook、Gmail 应用专用密码等）：列出、搜索、阅读邮件，发送邮件。",
    keywords: ["邮件", "邮箱", "email", "imap", "smtp", "收信", "发信", "回邮件"],
    server: { transport: "stdio", runner: "uvx", package: "mcp-email-server@latest", args: ["stdio"] },
    setup: "装好后先在这台机器上运行一次 uvx mcp-email-server@latest ui，在打开的本机页面里填邮箱地址与密码（或应用专用密码）。",
    outward: "发送、回复、删除邮件属于对外操作：发送前先把收件人与正文给对方过目；工具调用缺省每次询问。",
  },
  {
    id: "google_workspace", name: "Google Workspace（Gmail · 日历 · 云端硬盘）", category: "email", maintainer: "社区（taylorwilsdon）", license: "MIT", source: "https://github.com/taylorwilsdon/google_workspace_mcp",
    description: "Gmail 收发与搜索、Google 日历的查看与修改、云端硬盘与文档。用你自己在 Google Cloud 建的 OAuth 客户端。",
    keywords: ["gmail", "google", "谷歌", "日历", "calendar", "邮件", "云端硬盘", "drive", "文档"],
    server: { transport: "stdio", runner: "uvx", package: "workspace-mcp", args: ["--tool-tier", "core"] },
    inputs: [
      { key: "client_id", label: "Google OAuth 客户端 ID", target: "env", name: "GOOGLE_OAUTH_CLIENT_ID", required: true },
      { key: "client_secret", label: "Google OAuth 客户端密钥", target: "env", name: "GOOGLE_OAUTH_CLIENT_SECRET", secret: true, required: true },
    ],
    setup: "第一次调用 Gmail 或日历工具时，它会给出一个 Google 授权链接，在浏览器里登录同意即可。",
    outward: "发送邮件、创建或修改日历事件属于对外操作：工具调用缺省每次询问。",
  },
  {
    id: "outlook", name: "Microsoft 365 / Outlook（邮件 · 日历）", category: "email", maintainer: "社区（Softeria）", license: "MIT", source: "https://github.com/Softeria/ms-365-mcp-server",
    description: "Outlook 邮件、日历、联系人、OneDrive 等 Microsoft 365 服务（个人账号与工作账号）。",
    keywords: ["outlook", "microsoft", "微软", "365", "邮件", "日历", "calendar", "onedrive", "teams"],
    server: { transport: "stdio", runner: "npx", package: "@softeria/ms-365-mcp-server", args: ["--preset", "outlook"] },
    setup: "第一次用时让她调用它的登录工具（设备码登录），按提示在浏览器里输入代码；或在这台机器上运行一次 npx @softeria/ms-365-mcp-server --login。",
    outward: "发送邮件、创建或修改日历事件属于对外操作：工具调用缺省每次询问。",
  },
  // ---------- 日历（原 #25）
  {
    id: "google_calendar", name: "Google 日历", category: "calendar", maintainer: "社区（nspady）", license: "MIT", source: "https://github.com/nspady/google-calendar-mcp",
    description: "查看、搜索、创建、修改 Google 日历事件，查空闲时间，多个日历。",
    keywords: ["日历", "日程", "calendar", "google", "会议", "约", "空闲时间", "提醒"],
    server: { transport: "stdio", runner: "npx", package: "@cocal/google-calendar-mcp", args: [] },
    inputs: [{ key: "credentials", label: "OAuth 凭据文件 gcp-oauth.keys.json 的绝对路径", target: "env", name: "GOOGLE_OAUTH_CREDENTIALS", required: true, placeholder: "/home/me/gcp-oauth.keys.json" }],
    setup: "第一次用之前在这台机器上运行一次 npx @cocal/google-calendar-mcp auth（带同样的 GOOGLE_OAUTH_CREDENTIALS），在浏览器里授权。",
    outward: "创建、修改、删除事件属于对外操作（可能给别人发邀请）：工具调用缺省每次询问。",
  },
  {
    id: "caldav", name: "CalDAV 日历", category: "calendar", maintainer: "社区（dominik1001）", license: "MIT", source: "https://github.com/dominik1001/caldav-mcp",
    description: "任意 CalDAV 日历（iCloud、Nextcloud、Fastmail、自建 Radicale 等）：列出与创建事件。",
    keywords: ["日历", "caldav", "icloud", "nextcloud", "日程", "calendar"],
    server: { transport: "stdio", runner: "npx", package: "caldav-mcp", args: [] },
    inputs: [
      { key: "base_url", label: "CalDAV 服务器地址", target: "env", name: "CALDAV_BASE_URL", required: true, placeholder: "https://caldav.icloud.com" },
      { key: "username", label: "用户名", target: "env", name: "CALDAV_USERNAME", required: true },
      { key: "password", label: "密码（或应用专用密码）", target: "env", name: "CALDAV_PASSWORD", secret: true, required: true },
    ],
    outward: "创建、删除事件属于对外操作：工具调用缺省每次询问。",
  },
];

export const catalogEntry = (id: string) => CATALOG.find((e) => e.id === id);

/** 按关键词找：查询里的词出现在名字、说明、关键词里，或条目的关键词出现在查询里（中文不分词，「填网页表单」也认得出「表单」），按命中多少排序。 */
export function searchCatalog(query: string): CatalogEntry[] {
  const q = query.toLowerCase();
  const words = q.split(/[\s,，、;；/]+/).filter(Boolean);
  if (!words.length) return CATALOG;
  const score = (e: CatalogEntry) => { const hay = [e.id, e.name, e.description, ...e.keywords].join(" ").toLowerCase(); return words.filter((w) => hay.includes(w)).length + e.keywords.filter((k) => q.includes(k.toLowerCase())).length; };
  return CATALOG.map((e) => [e, score(e)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([e]) => e);
}
