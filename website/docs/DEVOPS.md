# website · 运维

本文记录官网的托管、构建、域名、回滚与安全边界。仓库是公开的：这里只写配置方式，不写任何账号、令牌、Zone ID、Account ID；需要本机保存的凭据放在被 gitignore 的 `.dev.vars` / `.env*`，或 Cloudflare 控制台里。

## 1. 现状

| 项目 | 值 |
|---|---|
| 托管 | Cloudflare **Workers**（静态资源模式，Workers Builds 连接 GitHub 仓库自动构建部署）。已于 2026-10-04 创建并连接 |
| Worker 名 | `windler`（控制台项目名与 `wrangler.jsonc` 的 `name` 必须一致，否则控制台会提示不一致并可能自动开 PR 修正） |
| 仓库 / 根目录 | Git 存储库 `PlutoKeating/Project.Windler`，根目录 `/website` |
| 构建 / 部署命令 | `npm run build` / `npx wrangler deploy` |
| 生产分支（分支控制） | `main`（推送即自动构建部署；预览基础也取自 `main`） |
| 预览 | 非 `main` 分支与 PR 自动生成预览地址（`<分支>-windler.<账号>.workers.dev`） |
| 生产域名 | `windler.plutokeating.beer`（自定义域，类型「生产」，区域 `plutokeating.beer`，已添加；DNS 与证书由 Cloudflare 自动维护） |
| Node | 22（`.nvmrc`） |
| 统计 / Cookie | 均无 |

## 2. 在 Cloudflare 创建项目（一次性，已完成）

控制台 → **Workers & Pages** → **Create** → **Workers** 标签 → **Import a repository** → 授权 GitHub 并选择 `PlutoKeating/Project.Windler`。当前生效的配置（控制台 → Worker `windler` → Settings → Build）：

| 字段 | 值 |
|---|---|
| 项目 / Worker 名 | `windler` |
| Git 存储库 | `PlutoKeating/Project.Windler` |
| 根目录 | `/website` |
| 构建命令 | `npm run build` |
| 部署命令 | `npx wrangler deploy` |
| 分支控制（生产分支） | `main` |
| 构建变量 | 无（Node 版本由 `.nvmrc` 决定；如需显式指定可加 `NODE_VERSION=22`） |
| Build watch paths | 建议 Include `website/**`，这样 runtime / console 的提交不会触发官网构建 |
| 非生产分支构建 | 开启即得到预览地址 |

生产的 workers.dev 地址为 `windler.<账号>.workers.dev`（账号子域不写在仓库里）。

## 3. 域名（已完成）

Settings → **Domains & Routes**（自定义域和路由）→ **Add** → Custom domain → `windler.plutokeating.beer`。现状：名称 `windler.plutokeating.beer`，类型「生产」，区域 `plutokeating.beer`。DNS 托管在同一账号的 Cloudflare，记录与证书自动创建维护。域名的增删改由仓库所有者操作，不在本仓库里记录任何 DNS 记录值。

`scripts/postbuild.mjs` 生成的 `sitemap.xml` 与 `public/robots.txt` 使用的站点地址默认为 `https://windler.plutokeating.beer`，预览环境可用构建变量 `SITE_ORIGIN` 覆盖。

## 4. 构建产物与请求路径

- `npm run build`：生成主题变量 → 设计系统检查 → `react-router build`（预渲染到 `build/client/`）→ `postbuild`（`404.html`、`sitemap.xml`）。
- `wrangler.jsonc`：`assets.directory = ./build/client`；`html_handling = auto-trailing-slash`（`/en/docs` 与 `/en/docs/` 都命中 `en/docs/index.html`）；`not_found_handling = 404-page`。
- 没有 Worker 脚本、没有 KV / D1 / 环境密钥。下载页的数据由访客浏览器直接请求 GitHub 公开 API（匿名，每 IP 每小时 60 次），结果在 sessionStorage 缓存 10 分钟。

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
- 2026-10-04：所有者在 Cloudflare 创建 Worker `windler` 并连接仓库（根目录 `/website`，分支 `main`），添加自定义域 `windler.plutokeating.beer`；`wrangler.jsonc` 的 `name` 随之改为 `windler`。
