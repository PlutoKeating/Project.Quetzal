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
│   │   └── tokens.generated.css 由 scripts/gen-tokens.ts 生成（不入库）
│   ├── i18n/core.ts             i18n 内核：defineMessages / useMessages / 语言检测与记忆 / 路径切换
│   ├── components/              跨页面组件（顶栏、页脚、语言切换、Markdown 渲染……）
│   ├── lib/                     与界面无关的逻辑（预渲染清单、GitHub Releases 客户端、文档清单……）
│   └── routes/<page>/           每个页面一个目录：route.tsx + i18n.ts（中英文案，键必须一致）
├── content/docs/{zh,en}/        文档教程的 Markdown 正文
├── public/                      原样复制的静态文件（favicon、robots.txt）
├── scripts/                     gen-tokens（生成主题变量）、lint-tokens（禁止硬编码）、postbuild（404.html、sitemap）
├── react-router.config.ts       ssr:false + 预渲染清单（app/lib/prerender.ts）
├── wrangler.jsonc               Cloudflare Workers 静态资源配置
└── docs/                        本目录：README / ARCHITECTURE / DEVOPS
```

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
