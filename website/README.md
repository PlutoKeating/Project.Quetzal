# website/

Quetzalcoatl 的官网与发布镜像。构建产物是静态 HTML + 一个 Cloudflare Worker；没有任何运行时服务端。

## 结构

- `app/`：React Router（`ssr: false` + 预渲染）页面。文案在每页的 `i18n.ts`（`zh` / `en`），
  设计令牌只在 `app/design-system/designSystem.ts`。
- `worker/`：Cloudflare Worker。`/dl/<tag>/<asset>` 在转发 GitHub 资产的同时计算 SHA-256，
  与发布 JSON 的 `digest` 不符就让流出错且不缓存；`/api/releases[/latest]` 镜像 GitHub 并按 npm 版本封顶；
  `/install` 与 `/install.ps1` 来自构建时烘焙的 `../scripts/install.sh` / `install.ps1`。
- `scripts/gen-install-bundle.mjs`：把安装脚本嵌入 Worker（`worker/generated/`，已 gitignore）。
- `scripts/postbuild.mjs`：404、`/install` 静态兜底、`_headers`、逐页 CSP、canonical、sitemap。
- `shared/releases.ts`：Worker 与下载页共用的版本比较、封顶与资产命名规则。

## 本地

```bash
npm ci
npm run dev        # 预渲染站点的开发服务器
npm test           # Worker / 设计系统单测（vitest）
npm run build      # 输出到 build/client
npm run preview    # wrangler dev（本地 Worker + 静态资源）
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
