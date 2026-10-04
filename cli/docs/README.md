# cli · npm 包 `@plutokeating/quetzal`（Linux 安装器）

把运行基座装到一台 Linux 机器上的唯一方式：`npx @plutokeating/quetzal`。与 Quetzal App 的安装器（Android）对应：App 把内置的运行基座装进 Termux 交给 runit，这个包把内置的运行基座装进 `~/quetzal` 交给 systemd 用户服务。版本目录、配置、健康检查与回滚的约定完全相同，所以同一套文档与控制台都适用。

TypeScript / Node.js 22.13+（内置 `node:sqlite` 不再需要标志），零运行时依赖：包里只有打包好的 `dist/quetzal.mjs`（命令行）与 `dist/runtime/`（运行基座 `main.cjs`、Linux 身体适配器 `linux.mjs`、`VERSION`）。`package.json` 声明 `os: ["linux"]`，其他系统上 npm 直接拒绝安装。

## 使用者看到的

```bash
npx @plutokeating/quetzal                 # 安装（或升级到包里内置的版本），注册 systemd 用户服务并启动；失败自动切回上一版
npx @plutokeating/quetzal --lan           # 同上，并让网关对局域网开放：手机上的 Quetzal App 直接填这台机器的地址连接
npx @plutokeating/quetzal status          # 版本、服务、健康、网关地址
npx @plutokeating/quetzal logs -f         # 服务日志（journald）
npx @plutokeating/quetzal rollback        # 切回上一版并重启
npx @plutokeating/quetzal uninstall       # 移除服务；--purge 连家目录（配置、记忆、对话）一起删
npx @plutokeating/quetzal run             # 没有 systemd 的机器（容器、未开 systemd 的 WSL）：前台运行，交给自己的守护者
```

装好之后的一切（模型、身份、授权、飞书、灵魂仓库）都在 Quetzal App 里完成，这个包不提供任何配置命令。配对码通过 Linux 适配器的 `notify`（`notify-send`）弹桌面通知，并写进服务日志，没有桌面的机器从 `quetzal logs` 里看。

## 开发

| 命令 | 作用 |
|---|---|
| `npm test` | 单元测试（版本目录布局、systemd 单元文件） |
| `npm run build` | 类型检查 → `tool/bundle-runtime.sh`（构建 `../runtime` 并把 `main.cjs`、`linux.mjs`、版本号放进 `dist/runtime/`）→ esbuild 打包 `dist/quetzal.mjs` |
| `npm pack` | 本地打包验证：`npx ./quetzal-<版本>.tgz status` |

版本号必须与 `runtime/package.json`、`console/pubspec.yaml` 一致，`tool/bundle-runtime.sh` 与发版工作流都会校验。发布由 `.github/workflows/release.yml` 在推送 `v<版本>` 标签时完成（仓库 Secrets 里提供 `NPM_TOKEN`；缺少时跳过 npm 发布，只出 GitHub Release）。

源码地图见 [ARCHITECTURE.md](ARCHITECTURE.md)。
