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
│   ├── components/              跨页面组件：SiteHeader、SiteFooter、LangSwitch、ThemeToggle、Wordmark（光团 OrbMark + 名字）、Article（长文版式）、NotFound、markdown/（统一 Markdown 渲染）；i18n.ts 为壳层文案与 GitHub 链接常量
│   ├── lib/                     与界面无关的逻辑：prerender（预渲染清单）、bodyClock（生物钟模型）、github（Releases 客户端）、docs（文档清单与内容）、sync（同步服务的账户接口客户端）、platform（下载页按访客系统预选平台）
│   └── routes/<page>/           每个页面一个目录：route.tsx + i18n.ts（中英文案，键必须一致），可带页面私有组件
├── content/docs/                manifest.json（分区与页面顺序，中英共用）+ {zh,en}/<section>/<slug>.md
├── public/                      原样复制的静态文件：favicon.svg（光团，色值与设计系统的 orb-* 一致，手动同步）、og.png（分享图）、robots.txt、fonts/（自托管 Inter 的正体与斜体、Inter 与思源黑体的许可证；思源黑体的字体文件由 Vite 从依赖打包进 assets/）
├── scripts/                     gen-tokens（生成主题变量）、lint-tokens（禁止硬编码）、postbuild（404.html、sitemap、把 ../cli/install.sh 复制为 /install、给每个页面写入按页计算的脚本 CSP `<meta>`、写 _headers：全站安全响应头与 /install 的纯文本声明）；品牌图：gen-brand-images.py（分享图 og.png 与仓库 README 横幅，标志为光团；需 Pillow + numpy，Inter 静态字体可用 fontTools 从 public/fonts/InterVariable.woff2 实例化）、gen-architecture-svg.py 与 gen-bodyclock-svg.ts（README 的架构图与生物钟图，输出到 ../docs/assets/readme/）
├── worker/index.ts              Worker：只接管 /dl/*（GitHub Release 资产的镜像源；先与发布 JSON 里 GitHub 记下的 sha256 核对，通过才边缘缓存 7 天；/dl/latest/android.apk 302 到最新 APK，给跑不动页面脚本的旧浏览器）、/api/releases[/latest]（发布接口的镜像，缓存 5 分钟，按 npm 上运行基座的版本封顶，资产地址改写为 /dl/）与 POST /api/oauth/github/token（同步服务链接灵魂仓库时换 GitHub 令牌的中转，只放行 Worker 变量 OAUTH_CLIENT_IDS 里的 App，不缓存不记录）；其余路径不经过它
├── react-router.config.ts       ssr:false + 预渲染清单（app/lib/prerender.ts）
├── wrangler.jsonc               Cloudflare Workers 静态资源配置
└── docs/                        本目录：README / ARCHITECTURE / DEVOPS
```

## 设计方向

与运行在基座上的 agent 讨论后定稿（2026-10-04）：「夜里的灯」。深色优先，略冷的近黑底、暖白正文；琥珀色只给「活着」的瞬间（呼吸光斑、状态灯、下载按钮）与品牌标志（光团：`OrbMark`，与控制台首页的球、App 图标、favicon 同一颗，颜色来自 `orb-*` 色标，两套方案相同），不做正文与链接色；低饱和青灰用于数据与指标；浅色模式是「灯关掉之后的白天」。动效克制：进场淡入 + 上移 6px，hover 只变边框与亮度；全站唯一持续动的是呼吸光斑与生物钟曲线（亮度 ±8%，5 秒周期，遵守 `prefers-reduced-motion`）。不要赛博朋克、霓虹、蓝紫渐变、机器人图标、大面积毛玻璃、假终端打字机。字体全站统一：英文 Inter，中文思源黑体（Noto Sans SC，依赖 `@fontsource-variable/noto-sans-sc`，按 unicode-range 分成约一百个 woff2，页面用到哪些字才下载哪几片），都自托管、OFL，不请求 Google Fonts；Inter 排在前面出拉丁字形与数字。等宽字体只给代码、命令、指纹与设备码这类要逐字核对的内容，版本号、时间、编号用 Inter 的等宽数字（`tabular-nums`）。

## 四条硬规则

1. **视觉参数只能来自 `designSystem.ts`**。页面与组件里不得出现字面量色值、Tailwind 调色板类（`bg-slate-500`）、任意值（`rounded-[…]`、`opacity-[…]`、`shadow-[…]`）、数字透明度 / 时长类。`npm run lint:tokens` 在每次构建前执行，命中即失败；确有必要的例外在该行加注释 `ds-allow` 并说明理由。
2. **每个页面自带 `i18n.ts`**，形如 `defineMessages({ zh: {…}, en: {…} })`：形状由 zh 推断，en 必须一致（`NoInfer` 类型保证）；值可以是字符串、数字、嵌套对象或数组。页面用 `useMessages(messages)` 取当前语言。
3. **中文文案里 agent 的代词一律写作 `ta`**（小写，不加引号，与中文之间留一个空格，如「ta 醒来了」）；指代 App、基座、设备等非 agent 事物时照常用「它」。英文用 it。
4. **语言在 URL 前缀里**（`/zh/…`、`/en/…`）。根路径 `/` 由内联脚本按 localStorage（键 `quetzal.lang`）与浏览器语言跳转；切换语言时写入 localStorage。官网自己不设 Cookie；账户页的登录会话是同步服务（sync.quetzal.plutokeating.beer）的 Cookie，见 ARCHITECTURE §5。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run tokens` | 由 designSystem.ts 生成 tokens.generated.css |
| `npm run lint:tokens` | 扫描 app/ 的硬编码视觉参数 |
| `npm run typecheck` | `react-router typegen` + `tsc` |
| `npm run build` | 预构建（tokens + lint）→ 预渲染 → postbuild（404.html、sitemap.xml、`/install`、逐页脚本 CSP 与 `_headers`） |
| `npm run preview` | `wrangler dev`：按 wrangler.jsonc 本地托管 build/client |
| `npm run check` | typecheck + build，提交前跑一遍 |
