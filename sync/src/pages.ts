// 网页：首页、设备绑定、账户管理。服务端渲染，没有脚本；样式内联并带 CSP nonce。
// 文案中英两份（按 ?lang= 或 Accept-Language）；中文里 agent 的代词写作 ta。配色取自官网设计系统「夜里的灯」（这里内联一份，不依赖官网代码）。
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type Lang = "zh" | "en";
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function pickLang(query: string | undefined, accept: string | undefined): Lang {
  if (query === "zh" || query === "en") return query;
  const first = (accept ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("zh") || !first ? "zh" : "en";
}

const T = {
  zh: {
    title: "Quetzal 同步服务",
    tagline: "把同一个 agent 的几具身体连在一起。",
    intro: "Quetzal 是开源的 agent 运行基座。一个 agent 可以同时住在几部手机、几台电脑上；这个服务帮这些身体互相找到、直接连起来，连不上时替它们中转。",
    login: "登录",
    loginDisabled: "这个服务还没有配置登录（缺少 OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET），暂时不能登录。",
    storesTitle: "这里保存什么",
    stores: [
      "你的账号编号、用户名、显示名与邮箱（登录时从身份服务读一次，不保存它发的任何令牌）。",
      "你绑定的 agent：名字与 id；每具身体：名字、类型、版本、节点公钥、最近在线时间。",
      "登录会话与绑定码：只存哈希，会话按期过期（无论怎么续期最长 90 天），绑定码 15 分钟作废。",
    ],
    notStoresTitle: "不保存什么",
    notStores: [
      "记忆、人格、对话：它们在你自己的私有 git 仓库与身体之间直接传输，经中转时也是端到端加密的，这里看不到。",
      "IP 地址与网络端点：只在身体在线时用于建立连接与内存里的限流，不落盘、不写日志（TURN 中转服务器也不记日志）。",
    ],
    account: "账户",
    logout: "退出登录",
    agents: "你的 agent",
    noAgents: "还没有绑定任何 agent。在 Quetzal 控制台的「灵魂同步 → 多具身体」里点「绑定」，按提示到这里输入绑定码。",
    bodies: "身体",
    online: "在线",
    offline: "离线",
    lastSeen: "最近在线",
    kind: { runtime: "运行基座", bridge: "灵魂桥（只读）", console: "控制台登录：批准后这具身体上的 App 能管理你的整个账户" } as Record<string, string>,
    version: "版本",
    key: "公钥指纹",
    boundAt: "这具身体绑定于",
    removeBody: "解绑",
    removeAgent: "删除这个 agent",
    removeAgentHint: "只删除这里的登记与它所有身体的绑定，不会动 ta 的灵魂仓库。",
    deleteAccount: "删除账户",
    deleteAccountHint: "删除你的账户、所有 agent 登记与身体绑定，立即生效，不可恢复。",
    confirm: "我确认",
    deviceTitle: "绑定一具身体",
    deviceHint: "输入身体上显示的 8 位绑定码。",
    code: "绑定码",
    next: "下一步",
    badCode: "绑定码不对或已过期。请在身体上重新开始绑定。",
    tooMany: "尝试太多次了，请稍后再试。",
    confirmTitle: "确认绑定",
    confirmHint: "请核对身体上显示的公钥指纹与这里一致，再批准。",
    agent: "agent",
    body: "身体",
    replaces: "这个 agent 已经有一具同名的身体，批准后原来的绑定立即失效。",
    newAgent: "这个 agent 第一次绑定到你的账户。",
    approve: "批准",
    deny: "拒绝",
    approved: "已批准。身体会在几秒内完成绑定，你可以关掉这个页面。",
    denied: "已拒绝。身体那边会收到提示。",
    errors: {
      decided: "这个绑定码已经处理过了。",
      too_many_agents: "你的账户下 agent 数量已达上限。",
      too_many_bodies: "这个 agent 的身体数量已达上限。先解绑不用的身体。",
      not_yours: "发起这个控制台登录的身体不在你的账户下，或者它在申请之后被解绑、重新绑定过。",
    } as Record<string, string>,
    back: "返回",
    switchLang: "English",
    footer: "Quetzal · 开源的 agent 运行基座 · 仅用于学习和研究",
    never: "从未",
  },
  en: {
    title: "Quetzal Sync",
    tagline: "Connecting the bodies of one agent.",
    intro: "Quetzal is an open-source runtime for agents. One agent can live on several phones and computers at once; this service helps those bodies find each other, connect directly, and relays for them when a direct connection is impossible.",
    login: "Sign in",
    loginDisabled: "Sign-in is not configured on this server yet (OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET missing).",
    storesTitle: "What is stored here",
    stores: [
      "Your account id, username, display name and email (read once from the identity provider at sign-in; none of its tokens are kept).",
      "The agents you bind: name and id; for each body: name, kind, version, node public key, last seen.",
      "Sign-in sessions and binding codes: hashes only; sessions expire (90 days at most, however often renewed), binding codes after 15 minutes.",
    ],
    notStoresTitle: "What is not stored",
    notStores: [
      "Memories, persona, conversations: they travel between your private git repository and the bodies directly; relayed traffic is end-to-end encrypted and invisible here.",
      "IP addresses and network endpoints: used only while a body is online to set up connections, and in memory for rate limiting; never written to disk or logs (the TURN relay keeps no logs either).",
    ],
    account: "Account",
    logout: "Sign out",
    agents: "Your agents",
    noAgents: "No agents yet. In the Quetzal console, open Soul sync → Bodies, choose \"Bind\" and enter the code here.",
    bodies: "Bodies",
    online: "online",
    offline: "offline",
    lastSeen: "Last seen",
    kind: { runtime: "runtime", bridge: "soul bridge (read-only)", console: "console sign-in: once approved, the app on this body can manage your whole account" } as Record<string, string>,
    version: "Version",
    key: "Key fingerprint",
    boundAt: "Body bound",
    removeBody: "Unbind",
    removeAgent: "Remove this agent",
    removeAgentHint: "Removes only the registration here and all its body bindings; the soul repository is untouched.",
    deleteAccount: "Delete account",
    deleteAccountHint: "Deletes your account, all agent registrations and body bindings immediately and permanently.",
    confirm: "I confirm",
    deviceTitle: "Bind a body",
    deviceHint: "Enter the 8-character code shown on the body.",
    code: "Code",
    next: "Continue",
    badCode: "The code is wrong or has expired. Start the binding again on the body.",
    tooMany: "Too many attempts. Try again later.",
    confirmTitle: "Confirm binding",
    confirmHint: "Check that the key fingerprint shown on the body matches the one here before approving.",
    agent: "Agent",
    body: "Body",
    replaces: "This agent already has a body with this name; approving revokes the old binding immediately.",
    newAgent: "This agent is being bound to your account for the first time.",
    approve: "Approve",
    deny: "Deny",
    approved: "Approved. The body will finish binding within seconds; you can close this page.",
    denied: "Denied. The body will be told.",
    errors: {
      decided: "This code has already been handled.",
      too_many_agents: "Your account has reached the agent limit.",
      too_many_bodies: "This agent has reached the body limit. Unbind unused bodies first.",
      not_yours: "The body asking for this console sign-in is not in your account, or it was unbound or re-bound after asking.",
    } as Record<string, string>,
    back: "Back",
    switchLang: "中文",
    footer: "Quetzal · open-source agent runtime · for learning and research only",
    never: "never",
  },
};
export const t = (lang: Lang) => T[lang];

const CSS = `
:root{--bg:#0e0f11;--surface:#17181c;--hover:#1d1e23;--border:rgb(232 228 221/.08);--border-strong:rgb(232 228 221/.18);--fg:#e8e4dd;--muted:#a9a49c;--subtle:#6f6b65;--accent:#f0a35e;--secondary:#7d8f8a;--success:#7fb08f;--danger:#c97c7c;--link:#cfd8d5}
@media (prefers-color-scheme:light){:root{--bg:#f7f3ec;--surface:#fdfbf8;--hover:#f1ece3;--border:rgb(44 38 32/.1);--border-strong:rgb(44 38 32/.22);--fg:#26221e;--muted:#625b53;--subtle:#8d857c;--accent:#a5623f;--secondary:#5f726d;--success:#3f7a53;--danger:#9c4b4b;--link:#4b6560}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
main{max-width:44rem;margin:0 auto;padding:3rem 1.75rem 4rem}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:2.5rem}
.brand{display:flex;align-items:center;gap:.6rem;font-weight:600;letter-spacing:.02em;color:var(--fg);text-decoration:none}
.orb{width:.9rem;height:.9rem;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ffd9a8,#ffb26e 45%,#c76f3a)}
h1{font-size:1.75rem;line-height:1.3;margin:0 0 .5rem;font-weight:600}h2{font-size:1.1rem;margin:2.25rem 0 .75rem;font-weight:600}
p,li{color:var(--muted)}a{color:var(--link)}ul{padding-left:1.2rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.25rem 1.25rem;margin:1rem 0}
.row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem}
.meta{font-size:.85rem;color:var(--subtle)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;word-break:break-all}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.35rem;background:var(--subtle)}.dot.on{background:var(--success)}
.btn{display:inline-block;border:1px solid var(--border-strong);background:var(--hover);color:var(--fg);border-radius:999px;padding:.55rem 1.1rem;font:inherit;font-size:.95rem;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--secondary)}.btn.primary{background:var(--accent);border-color:var(--accent);color:#1a120b}.btn.danger{color:var(--danger)}
.btn.small{padding:.3rem .8rem;font-size:.85rem}
input[type=text]{font:inherit;font-size:1.4rem;letter-spacing:.2em;text-transform:uppercase;padding:.6rem .9rem;border-radius:10px;border:1px solid var(--border-strong);background:var(--bg);color:var(--fg);width:12ch;max-width:100%}
.note{border-left:2px solid var(--accent);padding:.25rem 0 .25rem .9rem;color:var(--muted)}.err{border-left-color:var(--danger)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem;margin:0}dt{color:var(--subtle)}dd{margin:0;min-width:0}
form.inline{display:inline}footer{margin-top:4rem;font-size:.8rem;color:var(--subtle)}
label.check{display:flex;gap:.5rem;align-items:center;font-size:.9rem;color:var(--muted);margin:.75rem 0}
`;

export function layout(lang: Lang, nonce: string, title: string, content: Html, opts: { user?: string } = {}) {
  const s = t(lang);
  const other: Lang = lang === "zh" ? "en" : "zh";
  return html`<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${title} · ${s.title}</title><style nonce="${nonce}">${raw(CSS)}</style></head>
<body><main>
<header><a class="brand" href="/?lang=${lang}"><span class="orb"></span>Quetzal</a>
<span class="row">${opts.user ? html`<a class="meta" href="/account?lang=${lang}">${opts.user}</a>` : ""}<a class="meta" href="?lang=${other}">${s.switchLang}</a></span></header>
${content}
<footer>${s.footer}</footer>
</main></body></html>`;
}

export const ago = (lang: Lang, ts: number) => {
  if (!ts) return t(lang).never;
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";
};
