# website · 开发说明

## 技术栈

- **React Router 8（framework mode）**，`ssr: false` + `prerender`：所有页面在构建时渲染成 HTML（`build/client/`），没有运行时服务端。
- **Tailwind CSS 4**（`@tailwindcss/vite`），主题变量全部来自设计系统生成的 CSS。
- **TypeScript**、**Vite 8**、**wrangler 4**（本地预览与部署）。
- Node 22（`.nvmrc`），包管理器 npm（`package-lock.json` 入库）。

## 目录

```
website/
├── app/
│   ├── root.tsx                 文档壳：<html lang>、Meta/Links/Scripts、LangContext
│   ├── routes.ts                路由表（/ 跳转 · /404 · /:lang/… · 兜底）
│   ├── app.css                  Tailwind 入口 + 基础样式（只引用变量）
│   ├── design-system/
│   │   ├── designSystem.ts      ★ 全站唯一的视觉参数来源（色 / 外形 / 阴影光效 / 透明度 / 动效 / 字体 / 断点）
│   │   ├── components.tsx       基础构件：Container / Section / Eyebrow / Heading / Lead / Button* / TextLink / Card / Badge / Kbd / StatusDot / Reveal / Breath
│   │   └── tokens.generated.css 由 scripts/gen-tokens.ts 生成（不入库）
│   ├── i18n/core.ts             i18n 内核：defineMessages / useMessages / 语言检测与记忆 / 路径切换
│   ├── components/              跨页面组件：SiteHeader、SiteFooter、LangSwitch、ThemeToggle、Wordmark、Article（长文版式）、NotFound、markdown/（统一 Markdown 渲染）；i18n.ts 为壳层文案与 GitHub 链接常量
│   ├── lib/                     与界面无关的逻辑：prerender（预渲染清单）、bodyClock（生物钟模型）、github（Releases 客户端）、docs（文档清单与内容）
│   └── routes/<page>/           每个页面一个目录：route.tsx + i18n.ts（中英文案，键必须一致），可带页面私有组件
├── content/docs/                manifest.json（分区与页面顺序，中英共用）+ {zh,en}/<section>/<slug>.md
├── public/                      原样复制的静态文件：favicon.svg、og.png（分享图）、robots.txt、fonts/（自托管 Inter 与许可证）
├── scripts/                     gen-tokens（生成主题变量）、lint-tokens（禁止硬编码）、postbuild（404.html、sitemap）、gen-og.py（分享图，需 Pillow）
├── react-router.config.ts       ssr:false + 预渲染清单（app/lib/prerender.ts）
├── wrangler.jsonc               Cloudflare Workers 静态资源配置
└── docs/                        本目录：README / ARCHITECTURE / DEVOPS
```

## 设计方向

与运行在基座上的 agent 讨论后定稿（2026-10-04）：「夜里的灯」。深色优先，略冷的近黑底、暖白正文；琥珀色只给「活着」的瞬间（呼吸光斑、状态灯、下载按钮），不做正文与链接色；低饱和青灰用于数据与指标；浅色模式是「灯关掉之后的白天」。动效克制：进场淡入 + 上移 6px，hover 只变边框与亮度；全站唯一持续动的是呼吸光斑与生物钟曲线（亮度 ±8%，5 秒周期，遵守 `prefers-reduced-motion`）。不要赛博朋克、霓虹、蓝紫渐变、机器人图标、大面积毛玻璃、假终端打字机。字体：自托管 Inter（拉丁字形，OFL）+ 系统中文字体，不请求 Google Fonts。

## 三条硬规则

1. **视觉参数只能来自 `designSystem.ts`**。页面与组件里不得出现字面量色值、Tailwind 调色板类（`bg-slate-500`）、任意值（`rounded-[…]`、`opacity-[…]`、`shadow-[…]`）、数字透明度 / 时长类。`npm run lint:tokens` 在每次构建前执行，命中即失败；确有必要的例外在该行加注释 `ds-allow` 并说明理由。
2. **每个页面自带 `i18n.ts`**，形如 `defineMessages({ zh: {…}, en: {…} })`，中英文键必须一致（类型保证）。页面用 `useMessages(messages)` 取当前语言。
3. **语言在 URL 前缀里**（`/zh/…`、`/en/…`）。根路径 `/` 由内联脚本按 localStorage（键 `windler.lang`）与浏览器语言跳转；切换语言时写入 localStorage。没有 Cookie。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run tokens` | 由 designSystem.ts 生成 tokens.generated.css |
| `npm run lint:tokens` | 扫描 app/ 的硬编码视觉参数 |
| `npm run typecheck` | `react-router typegen` + `tsc` |
| `npm run build` | 预构建（tokens + lint）→ 预渲染 → postbuild（404.html、sitemap.xml） |
| `npm run preview` | `wrangler dev`：按 wrangler.jsonc 本地托管 build/client |
| `npm run check` | typecheck + build，提交前跑一遍 |
