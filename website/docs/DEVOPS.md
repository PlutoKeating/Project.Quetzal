# website · 运维

本文记录官网的托管、构建、域名、回滚与安全边界。仓库是公开的：这里只写配置方式，不写任何账号、令牌、Zone ID、Account ID；需要本机保存的凭据放在被 gitignore 的 `.dev.vars` / `.env*`，或 Cloudflare 控制台里。

## 1. 现状

| 项目 | 值 |
|---|---|
| 托管 | Cloudflare **Workers**（静态资源模式，Workers Builds 连接 GitHub 仓库自动构建部署）。已于 2026-10-04 创建并连接 |
| Worker 名 | `quetzal`（控制台项目名与 `wrangler.jsonc` 的 `name` 必须一致，否则控制台会提示不一致并可能自动开 PR 修正） |
| 仓库 / 根目录 | Git 存储库 `PlutoKeating/Project.Quetzal`，根目录 `/website` |
| 构建 / 部署命令 | `npm run build` / `npx wrangler deploy` |
| 生产分支（分支控制） | `main`（推送即自动构建部署；预览基础也取自 `main`） |
| 预览 | 非 `main` 分支与 PR 自动生成预览地址（`<分支>-quetzal.<账号>.workers.dev`） |
| 生产域名 | `quetzal.plutokeating.beer`（自定义域，类型「生产」，区域 `plutokeating.beer`，已添加；DNS 与证书由 Cloudflare 自动维护） |
| Node | 22（`.nvmrc`） |
| 统计 / Cookie | 均无 |

## 2. 在 Cloudflare 创建项目（一次性，已完成）

控制台 → **Workers & Pages** → **Create** → **Workers** 标签 → **Import a repository** → 授权 GitHub 并选择 `PlutoKeating/Project.Quetzal`。当前生效的配置（控制台 → Worker `quetzal` → Settings → Build）：

| 字段 | 值 |
|---|---|
| 项目 / Worker 名 | `quetzal` |
| Git 存储库 | `PlutoKeating/Project.Quetzal` |
| 根目录 | `/website` |
| 构建命令 | `npm run build` |
| 部署命令 | `npx wrangler deploy` |
| 分支控制（生产分支） | `main` |
| 构建变量 | 无（Node 版本由 `.nvmrc` 决定；如需显式指定可加 `NODE_VERSION=22`） |
| Build watch paths | 建议 Include `website/**` 与 `cli/install.sh`，这样 runtime / console 的提交不会触发官网构建，而一键安装脚本的改动会（它由构建复制到 `/install`） |
| 非生产分支构建 | 开启即得到预览地址 |

生产的 workers.dev 地址为 `quetzal.<账号>.workers.dev`（账号子域不写在仓库里）。

## 3. 域名（已完成）

Settings → **Domains & Routes**（自定义域和路由）→ **Add** → Custom domain → `quetzal.plutokeating.beer`。现状：名称 `quetzal.plutokeating.beer`，类型「生产」，区域 `plutokeating.beer`。DNS 托管在同一账号的 Cloudflare，记录与证书自动创建维护。域名的增删改由仓库所有者操作，不在本仓库里记录任何 DNS 记录值。

`scripts/postbuild.mjs` 生成的 `sitemap.xml` 与 `public/robots.txt` 使用的站点地址默认为 `https://quetzal.plutokeating.beer`，预览环境可用构建变量 `SITE_ORIGIN` 覆盖。

## 4. 构建产物与请求路径

- `npm run build`：生成主题变量 → 设计系统检查 → `react-router build`（预渲染到 `build/client/`）→ `postbuild`（`404.html`、`sitemap.xml`、把 `../cli/install.sh` 原样复制为 `install`，并写 `_headers` 让 `/install` 以 `text/plain` 返回、缓存 5 分钟）。
- **`/install`**：Linux 一键安装脚本（`curl -fsSL https://quetzal.plutokeating.beer/install | bash`）。源码只有 `cli/install.sh` 一份；Workers Builds 的根目录是 `/website`，但克隆的是整个仓库，所以构建能读到 `../cli/install.sh`，缺了就构建失败。`html_handling = drop-trailing-slash` 下无扩展名的 `/install` 直接命中同名文件。镜像地址是 GitHub raw。
- `wrangler.jsonc`：`assets.directory = ./build/client`；`html_handling = auto-trailing-slash`（`/en/docs` 与 `/en/docs/` 都命中 `en/docs/index.html`）；`not_found_handling = 404-page`。
- `worker/index.ts`：只接管 `/dl/*` 与 `/api/*`（`wrangler.jsonc` 的 `run_worker_first`），其余路径仍由静态资源直接响应。
  - `/dl/<tag>/<资产名>`：GitHub Release 资产的镜像源（只镜像本仓库、符合命名的 APK / Linux 控制台包 / 校验值，不转发其他地址），Cloudflare 边缘缓存 7 天。App 的更新器、一键安装脚本、下载页都先走它，失败再直连 GitHub。流量经 Cloudflare（Workers 免费额度每天 10 万次请求，流量不计费）。
  - `/api/releases`、`/api/releases/latest`：GitHub 发布接口的镜像，边缘缓存 5 分钟，返回的 JSON 把 `browser_download_url` 改写为 `/dl/` 地址、原地址放在 `github_download_url`。匿名调用的 60 次 / 小时按 Cloudflare 出口 IP 计算，被所有访客共享；设置 Worker Secret **`GITHUB_TOKEN`**（`npx wrangler secret put GITHUB_TOKEN`，只读的细粒度令牌即可）可提高到 5000 次 / 小时。令牌只在 Cloudflare 里，不在仓库里。
- 没有 KV / D1。下载页的数据由访客浏览器请求同源的 `/api/releases`（开发服务器没有 Worker，退回 GitHub 公开 API），结果在 sessionStorage 缓存 10 分钟。

## 5. 本地验证与手动部署

```bash
cd website
npm ci
npm run check            # typecheck + build
npm run preview          # wrangler dev，按 wrangler.jsonc 本地托管 build/client
```

手动部署（通常不需要，Workers Builds 会自动做）：`npx wrangler login` 后 `npm run deploy`。登录态保存在本机 wrangler 配置目录，不在仓库里。

## 6. 回滚

- **控制台**：Worker → Deployments → 选择上一个版本 → Rollback（秒级，不需要重新构建）。
- **Git**：`git revert` 相关提交并推送 `main`，Workers Builds 重新构建部署。

## 7. 安全边界

- 仓库公开。禁止提交：Cloudflare API Token、Account ID、Zone ID、`.dev.vars`、`.env*`、wrangler 登录态。`website/.gitignore` 已忽略这些文件。
- `wrangler.jsonc` 只含 Worker 名、兼容日期与静态资源配置。
- 站点不设置 Cookie、不加载第三方统计与字体；外部请求只有 GitHub 公开 API 与 Cloudflare 托管本身。

## 8. 变更记录

- 2026-10-04：建立 `website/`，确定 Workers 静态资源托管方案（原计划 Cloudflare Pages，改为 Workers）。
- 2026-10-04：所有者在 Cloudflare 创建 Worker `quetzal` 并连接仓库（根目录 `/website`，分支 `main`），添加自定义域 `quetzal.plutokeating.beer`；`wrangler.jsonc` 的 `name` 随之改为 `quetzal`。
- 2026-10-05：新增 `/install`（Linux 一键安装脚本，构建时从 `cli/install.sh` 复制）与 `_headers`；Build watch paths 需加上 `cli/install.sh`。
- 2026-10-05：加入 Worker 脚本 `worker/index.ts`，作为 GitHub Release 下载（`/dl/*`）与发布接口（`/api/*`）的镜像源；可选 Secret `GITHUB_TOKEN`。前端与 App 的文案不描述下载来源。
