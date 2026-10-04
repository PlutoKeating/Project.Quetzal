# cli · npm 包 `@plutokeating/quetzal`（Linux 安装器）与一键安装脚本

把运行基座装到一台 Linux 机器上有两层：使用者看到的是一行 `curl -fsSL https://quetzal.plutokeating.beer/install | bash`（本目录的 `install.sh`，见下文），它补齐依赖、注册守护、写桌面快捷方式，内部调用的是 npm 包 `npx @plutokeating/quetzal`。与 Quetzal App 的安装器（Android）对应：App 把内置的运行基座装进 Termux 交给 runit，这个包把内置的运行基座装进 `~/quetzal` 交给 systemd 用户服务。版本目录、配置、健康检查与回滚的约定完全相同，所以同一套文档与控制台都适用。包里还带着**网页控制台**（控制台的 Flutter Web 构建），随运行基座放进版本目录，由网关托管，装完在浏览器里打开。

TypeScript / Node.js 22.13+（内置 `node:sqlite` 不再需要标志），零运行时依赖：包里只有打包好的 `dist/quetzal.mjs`（命令行）与 `dist/runtime/`（运行基座 `main.cjs`、Linux 身体适配器 `linux.mjs`、`VERSION`、网页控制台 `web/`，约 25 MB）。`package.json` 声明 `os: ["linux"]`，其他系统上 npm 直接拒绝安装。

## 使用者看到的

```bash
npx @plutokeating/quetzal                 # 安装（或升级到包里内置的版本），注册 systemd 用户服务并启动；失败自动切回上一版；第一次装好且有桌面时打开网页控制台（--no-open 不打开）
npx @plutokeating/quetzal open            # 在浏览器里打开网页控制台 http://127.0.0.1:<端口>/；没有桌面时打印地址与 ssh 端口转发的命令
npx @plutokeating/quetzal --lan           # 同上，并让网关对局域网开放：手机上的 Quetzal App 直接填这台机器的地址连接
npx @plutokeating/quetzal status          # 版本、服务、健康、网关地址、网页控制台地址
npx @plutokeating/quetzal logs -f         # 服务日志（journald）
npx @plutokeating/quetzal rollback        # 切回上一版并重启
npx @plutokeating/quetzal uninstall       # 移除服务；--purge 连家目录（配置、记忆、对话）一起删
npx @plutokeating/quetzal run             # 没有 systemd 的机器（容器、未开 systemd 的 WSL）：前台运行，交给自己的守护者
```

装好之后的一切（模型、身份、授权、飞书、灵魂仓库、对话）都在网页控制台里完成，这个包不提供任何配置命令。同一台机器的浏览器打开即登录（网关的 `GET /auth/local`）；手机上的 Quetzal App 连这台机器时才需要配对码，它通过 Linux 适配器的 `notify`（`notify-send`）弹桌面通知，并写进服务日志，没有桌面的机器从 `quetzal logs` 里看。

## 一键安装脚本 `install.sh`

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash                   # 安装 / 升级
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --lan       # 选项：--lan --no-open --no-desktop --home DIR --version X --cn|--no-cn --lang zh|en
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall # 卸载（--purge 连家目录）
```

纯 bash（4+），不进 npm 包（`files` 只有 `dist`），官网构建时由 `website/scripts/postbuild.mjs` 原样复制为 `/install`（镜像：GitHub raw 的 `cli/install.sh`）。整段逻辑包在 `main` 里、最后一行才调用，下载中断只会报语法错误不会跑半截；所有子命令的标准输入显式接 `/dev/null`（需要密码的 `sudo` 接 `/dev/tty`），不会吃掉管道里的脚本本身。

它按「路人机器可能什么都没有」来写，每个外部命令都先探测再用：

| 步骤 | 做法 |
|---|---|
| 这台机器 | `/etc/os-release`、`uname -m`、包管理器（apt / dnf / yum / pacman / zypper / apk / xbps，都没有则只提示）、musl（`ld-musl-*` 或 `ldd`）、systemd 用户实例（`systemctl --user show-environment`）、桌面（`DISPLAY` / `WAYLAND_DISPLAY` / `XDG_CURRENT_DESKTOP` / `xsessions`）、WSL、容器、root |
| 依赖 | `git`、`curl`、`tar`、CA 证书缺了用包管理器装（root 直装，否则 `sudo` / `doas`；`sudo -n` 不行时让它自己向 `/dev/tty` 要密码）。Node.js 22.13+ 且带 npm：PATH 上有就用；nvm 里有（非交互 shell 没加载）就用；都没有则装 nvm（固定版本）并 `nvm install 22`；龙芯（loongarch64）、riscv64、armv6l 这些 nvm 不认识、官方不出二进制的架构，从 Node.js 的 unofficial-builds 直接下载最新的 v22 到 `~/quetzal/node/<版本>/`（`node/current` 指向它，`QUETZAL_NODE_ARCH` 可强制标签，测试用 `x64-musl`）；musl 用 `apk add nodejs npm`，NixOS 让用户自备。直连 nodejs.org 5 秒不通自动切 npmmirror（nvm 的 `NVM_NODEJS_ORG_MIRROR`、gitee 的 nvm 镜像、npm registry） |
| 运行基座 | `npm install -g --prefix ~/quetzal/npm @plutokeating/quetzal@<版本>`（独立前缀，不碰用户的全局 npm，卸载只需删目录），再用那个 node 执行 `dist/quetzal.mjs install --home … --no-open [--lan]`；写 `~/.local/bin/quetzal` 垫片（绝对路径的 node 与 quetzal.mjs，任何 shell 都能用），`~/.local/bin` 不在 PATH 时追加到 `.profile` / `.bashrc` / `.zshrc` / fish |
| 守护 | 有 systemd 用户实例：由 npm 包注册的服务（`Restart=always`，`RestartSec=3`），脚本再确认 `is-enabled` 与 `/health`，并把 `loginctl enable-linger` 做到位（先不加 sudo，再 `sudo -n`，最后向终端要密码）。没有：`~/quetzal/bin/quetzal-supervise`（POSIX sh 守护循环：flock 或 pid 文件保证单实例，退出 3 秒后重启，日志 `logs/runtime.log` 超 10 MB 轮转一份；看到 `state/supervise.off` 就暂停拉起而不退出——控制台「服务」页的守护开关靠它），用 `setsid` / `nohup` 拉起，开机靠 `crontab @reboot`（有 crontab 时）与 `~/.config/autostart/quetzal-runtime.desktop`（有桌面时）；都没有则明说要手动拉起。不装任何服务框架 |
| 桌面 | 有桌面才做：先从 GitHub Release 下载同版本的**原生控制台**（`quetzal-<版本>-linux-<x64|arm64>-console.tar.gz`，Flutter Linux 桌面版）到 `~/quetzal/console/<版本>/` 并指 `console/current`（`ldd` 有缺失的旧发行版放弃；没有这个资产或下载失败只提示，不致命）；图标取自 `current/web/icons/Icon-{512,192}.png` 存为 `xyz.quetzal.console.png`；启动器 `~/.local/bin/quetzal-console`：服务没在跑先拉起，有原生控制台就 exec 它，否则 Chromium 系浏览器（含 Flatpak）`--app` 独立窗口，再否则 `xdg-open` / firefox；桌面项 `~/.local/share/applications/xyz.quetzal.console.desktop`（文件名与 `StartupWMClass` 都是 GTK 应用 id `xyz.quetzal.console`，原生窗口在 Wayland 的 app_id 与 X11 的 WM_CLASS 都是它），刷新缓存。浏览器退路的窗口配不上图标（任务栏显示浏览器图标，已知限制） |
| 界面 | 双语：`LANGUAGE` / `LC_ALL` / `LC_MESSAGES` / `LANG` 以 `zh` 开头（简体、繁体）为中文，否则英文，`--lang` 可强制。颜色按 `-t 1`、`NO_COLOR`、`TERM`、`COLORTERM` 分 truecolor / 256 色 / 无色；UTF-8 locale 才用 ✓ ✗ ▸ 与半格字符画的光团（与 App 图标同一颗球，颜色按 favicon 的径向渐变逐像素算），否则退回 ASCII。长步骤转圈，输出全部进 `~/quetzal/install.log`，失败打印最后 25 行 |

卸载（`--uninstall`）：停掉并删除 systemd 单元（含守护开关的覆盖片段）或守护循环、crontab 项、自启动项、桌面项与图标（新旧两种名字）、两个垫片、`~/quetzal/npm` 与 `~/quetzal/console`；`--purge` 删整个家目录；nvm、Node、git 不动。

验证：`bash -n`、shellcheck（`docker run --rm -v "$PWD/install.sh:/s.sh:ro" koalaman/shellcheck:stable -s bash /s.sh`），以及在干净容器里以管道喂给 bash（`cat install.sh | docker run -i --rm debian:bookworm-slim bash -c 'cat >/tmp/i.sh; apt-get update -qq && apt-get install -y -qq curl ca-certificates; cat /tmp/i.sh | bash -s -- --no-open'`）跑通 debian-slim（root、无 git）、ubuntu（非 root + sudo + 假桌面）、fedora、archlinux、alpine（musl）、alpine + `QUETZAL_NODE_ARCH=x64-musl`（unofficial-builds 直接下载 Node 的路径，与龙芯共用）。systemd 与桌面集成只能在真机验证。

## 开发

| 命令 | 作用 |
|---|---|
| `npm test` | 单元测试（版本目录布局、systemd 单元文件） |
| `npm run build` | 类型检查 → `tool/bundle-runtime.sh`（构建 `../runtime` 并把 `main.cjs`、`linux.mjs`、版本号放进 `dist/runtime/`；再调用 `../console/tool/build-web.sh` 构建网页控制台放进 `dist/runtime/web/`，需要 Flutter，`FLUTTER=<路径>` 可指定，`QUETZAL_NO_WEB=1` 跳过）→ esbuild 打包 `dist/quetzal.mjs` |
| `npm pack` | 本地打包验证：`npx ./quetzal-<版本>.tgz status` |

版本号必须与 `runtime/package.json`、`console/pubspec.yaml` 一致，`tool/bundle-runtime.sh` 与发版工作流都会校验。发布由 `.github/workflows/release.yml` 在推送 `v<版本>` 标签时完成（仓库 Secrets 里提供 `NPM_TOKEN`；缺少时跳过 npm 发布，只出 GitHub Release）。

源码地图见 [ARCHITECTURE.md](ARCHITECTURE.md)。
