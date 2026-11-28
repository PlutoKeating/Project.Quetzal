# website/

Quetzalcoatl 的官网与发布镜像。构建产物是静态 HTML + 一个 Cloudflare Worker；没有任何运行时服务端。

## 结构

- `app/`：React Router（`ssr: false` + 预渲染）页面。
  - `lib/pages.ts`：站点地图的唯一真源（路由表、预渲染清单、文档侧栏与文档总览都读它）；
    `lib/moved.json` 是已删除页面的去向，构建时写进 `_redirects`。
  - `routes/`：每页一个目录，`route.tsx` 是版面，`i18n.ts` 是文案（`zh` / `en`，结构必须一致）。
  - `components/`：页面骨架（`SiteShell`）、文档三栏（`DocShell`）、内容块（`Blocks`）。
  - `diagrams/`：全部 SVG 图。每张图有宽、窄两版，按容器宽度切换。
  - `i18n/hub.ts`：全站唯一一处提到官方 Hub 的句子。
  - `site.css`：版面胶水（见下面「视觉语言」）。
- `worker/`：Cloudflare Worker。`/dl/<tag>/<asset>` 在转发 GitHub 资产的同时计算 SHA-256，
  与发布 JSON 的 `digest` 不符就让流出错且不缓存；`/api/releases[/latest]` 镜像 GitHub 并按 npm 版本封顶；
  `/install` 与 `/install.ps1` 来自构建时烘焙的 `../scripts/install.sh` / `install.ps1`。
- `scripts/gen-install-bundle.mjs`：把安装脚本嵌入 Worker（`worker/generated/`，已 gitignore）。
- `scripts/postbuild.mjs`：404、`/install` 静态兜底、`_headers`、`_redirects`、逐页 CSP、canonical、sitemap，
  以及对每个产物页面的骨架断言。
- `shared/releases.ts`：Worker 与下载页共用的版本比较、封顶与资产命名规则。

## 视觉语言

唯一的视觉语言是 `../packages/design-system`（「五彩斑斓的黑」）。官网不另存副本：

- 样式：`app/root.tsx` 直接引入设计系统的 `styles.css`（tokens 与全部 `.qz-*` 组件）。
- 字体与光学脚本：构建时由 Vite 从设计系统目录取进产物，`postbuild` 逐字节比对。
- `app/site.css` 只放设计系统尚未提供的「怎么摆」：只用 `--qz-*` token、只定义 `.site-*` 类、
  不出现颜色字面量、不改写任何 `.qz-*` 组件。
- 图里的颜色一律引用 token；`diagrams.md` 规定而尚无 token 的两个值集中在 `app/diagrams/kit.tsx`。

页面骨架：`.qz-optical-horizon` 与 `.qz-grain` 是 `<body>` 最前面的两个子元素，内容包在 `.qz-page` 里；
文档页是阅读模式（地平线加 `is-reading`，三栏：`.qz-sidenav` / `.qz-prose` / `.qz-toc`）。

### 缺口（应回写进设计系统的东西）

`site.css` 里的每一类都对应设计系统的一个缺口，稳定后应搬回 `packages/design-system` 并从这里删掉：

- 文档三栏的外壳：栅格、侧栏与目录的吸顶、窄屏时侧栏收成菜单、上一页与下一页。
- 阅读模式的导航栏（阅读刻度的 token 已有，没有使用它们的组件类）。
- 图的宽窄两版切换，以及图与栅格连成一体时的无留白变体。
- 长文之外的行内代码样式（现在行内代码只在 `.qz-prose` 里有样式）。
- 图的两个颜色 token：画布边界线 `rgba(255,255,255,0.08)` 与偏离路径 `#737373`。
- Quetzalcoatl 自己的产品标记（现在的 favicon 是一个临时的字母形）。

## 本地

```bash
npm ci
npm run dev        # 预渲染站点的开发服务器
npm test           # Worker、页面不变量与源码不变量（vitest）
npm run build      # 输出到 build/client
npm run preview    # wrangler dev（本地 Worker + 静态资源）
npm run check      # typecheck + test + build
```

## 部署

```bash
npm run build
npx wrangler deploy
```

需要 Cloudflare 凭据（`wrangler login` 或 `CLOUDFLARE_API_TOKEN`，不要写进仓库）。自定义域名在
Cloudflare 控制台的 Settings → Domains & Routes 添加，不写进 `wrangler.jsonc`。

可选 Secret：

```bash
npx wrangler secret put GITHUB_TOKEN   # 提高 GitHub API 限额；不设也能工作
```

`sitemap.xml` 与 canonical 使用 `SITE_ORIGIN`（默认 `https://quetzal.plutokeating.beer`）：

```bash
SITE_ORIGIN=https://example.com npm run build
```

## 不变量

- `wrangler.jsonc` 的 `run_worker_first` 必须列出 Worker 接管的每个路径（`/dl/*`、`/api/*`、`/install`、
  `/install.ps1`）。新增类似路径时同时改这里与 `scripts/postbuild.mjs` 的静态兜底。
- 站点不加载任何第三方脚本、字体或 CDN；CSP 由 Worker 响应头与每页 `<meta>` 两层组成，
  每页内联脚本的 sha256 在 `postbuild` 里注入并断言，漏一个就让构建失败。
- `/api/releases/latest` 只从同时带 `SHA256SUMS` 与 `SHA256SUMS.sig` 的发布里挑，
  避免安装器默认装到一个没有签名条目的版本。
- 文案只写本次发版确实有的功能；`app/site.test.tsx` 逐页检查（不出现已删除的功能、每页至多一个白色主按钮、
  两种语言结构一致、站内链接都指向存在的页面）。
