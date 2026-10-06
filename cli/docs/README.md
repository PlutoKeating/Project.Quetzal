# cli · npm 包 `@plutokeating/quetzal`（Linux 安装器）与一键安装脚本

把运行基座装到一台 Linux 机器上有两层：使用者看到的是一行 `curl -fsSL https://quetzal.plutokeating.beer/install | bash`（本目录的 `install.sh`，见下文），它补齐依赖、注册守护、写桌面快捷方式，内部调用的是 npm 包 `npx @plutokeating/quetzal`。与 Quetzal App 的安装器（Android）对应：App 把内置的运行基座装进 Termux 交给 runit，这个包把内置的运行基座装进 `~/.quetzal` 交给 systemd 用户服务。版本目录、配置、健康检查与回滚的约定完全相同，所以同一套文档与控制台都适用。包里还带着**网页控制台**（控制台的 Flutter Web 构建），随运行基座放进版本目录，由网关托管，装完在浏览器里打开。

TypeScript / Node.js 22.13+（内置 `node:sqlite` 不再需要标志），零运行时依赖：包里只有打包好的 `dist/quetzal.mjs`（命令行）与 `dist/runtime/`（运行基座 `main.cjs`、Linux 身体适配器 `linux.mjs`、`VERSION`、网页控制台 `web/`，约 25 MB）。`package.json` 声明 `os: ["linux", "win32"]`：Windows 上由安装包安装（见下文「Windows」），这个包的命令行在 Windows 上只做运维。

## 使用者看到的

```bash
npx @plutokeating/quetzal                 # 安装（或升级到包里内置的版本），注册 systemd 用户服务并启动；失败自动切回上一版；第一次装好且有桌面时打开网页控制台（--no-open 不打开）
npx @plutokeating/quetzal open            # 在浏览器里打开网页控制台 http://127.0.0.1:<端口>/；没有桌面时打印地址与 ssh 端口转发的命令
npx @plutokeating/quetzal --lan           # 同上，并让网关对局域网开放（HTTPS / WSS，端口 7789，自签名证书；明文仍只在 127.0.0.1）：手机上的 Quetzal App 直接填这台机器的地址连接
npx @plutokeating/quetzal status          # 版本、服务、健康、网关地址、局域网的 https 地址与证书指纹、网页控制台地址
npx @plutokeating/quetzal logs -f         # 服务日志（journald）
npx @plutokeating/quetzal rollback        # 切回上一版并重启
npx @plutokeating/quetzal uninstall       # 移除服务；--purge 连家目录（配置、记忆、对话）一起删
npx @plutokeating/quetzal run             # 没有 systemd 的机器（容器、未开 systemd 的 WSL）：前台运行，交给自己的守护者
```

装好之后的一切（模型、身份、授权、飞书、灵魂仓库、对话）都在网页控制台里完成，这个包不提供任何配置命令。同一台机器的浏览器打开即登录（网关的 `GET /auth/local`）；手机上的 Quetzal App 连这台机器时才需要配对码：App 里只填这台机器的地址（自动用 `https://…:7789`），先核对 App 显示的证书指纹与 `quetzal status` 里的一致；配对码连同证书短指纹通过 Linux 适配器的 `notify`（`notify-send`）弹桌面通知，并写进服务日志，没有桌面的机器从 `quetzal logs` 里看。用浏览器从别的机器打开 `https://<地址>:7789/` 会提示证书不受信任（自签名），在警告页核对指纹后再继续。

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
| 依赖 | `git`、`curl`、`tar`、CA 证书缺了用包管理器装（root 直装，否则 `sudo` / `doas`；`sudo -n` 不行时让它自己向 `/dev/tty` 要密码）。Node.js 22.13+ 且带 npm：PATH 上有就用；nvm 里有（非交互 shell 没加载）就用；都没有则装 nvm（固定版本；安装脚本先下载到 `~/.quetzal/nvm-install.sh`，核对写死在脚本里的 sha256 再执行，GitHub 与 gitee 镜像内容相同，不一致就拒绝）并 `nvm install 22`（nvm 下载 Node 时自己核对 SHASUMS256）；龙芯（loongarch64）、riscv64、armv6l 这些 nvm 不认识、官方不出二进制的架构，从 Node.js 的 unofficial-builds 直接下载最新的 v22 到 `~/.quetzal/node/<版本>/`（按同一发布目录的 `SHASUMS256.txt` 核对 sha256；unofficial-builds 不出 GPG 签名，只能核对哈希）（`node/current` 指向它，`QUETZAL_NODE_ARCH` 可强制标签，测试用 `x64-musl`）；musl 用 `apk add nodejs npm`，NixOS 让用户自备。直连 nodejs.org 5 秒不通自动切 npmmirror（nvm 的 `NVM_NODEJS_ORG_MIRROR`、gitee 的 nvm 镜像、npm registry） |
| 运行基座 | `npm install -g --prefix ~/.quetzal/npm @plutokeating/quetzal@<版本>`（独立前缀，不碰用户的全局 npm，卸载只需删目录），再用那个 node 执行 `dist/quetzal.mjs install --home … --no-open [--lan]`；写 `~/.local/bin/quetzal` 垫片（绝对路径的 node 与 quetzal.mjs，任何 shell 都能用），`~/.local/bin` 不在 PATH 时追加到 `.profile` / `.bashrc` / `.zshrc` / fish |
| 守护 | 有 systemd 用户实例：由 npm 包注册的服务（`Restart=always`，`RestartSec=3`），脚本再确认 `is-enabled` 与 `/health`，并把 `loginctl enable-linger` 做到位（先不加 sudo，再 `sudo -n`，最后向终端要密码）。没有：`~/.quetzal/bin/quetzal-supervise`（POSIX sh 守护循环：flock 或 pid 文件保证单实例，退出 3 秒后重启，日志 `logs/runtime.log` 超 10 MB 轮转一份；看到 `state/supervise.off` 就暂停拉起而不退出——控制台「高级 › 运行」页的守护开关靠它），用 `setsid` / `nohup` 拉起，开机靠 `crontab @reboot`（有 crontab 时）与 `~/.config/autostart/quetzal-runtime.desktop`（有桌面时）；都没有则明说要手动拉起。不装任何服务框架 |
| 桌面 | 有桌面才做：先下载同版本的**原生控制台**（`quetzal-<版本>-linux-<x64|arm64>-console.tar.gz`，Flutter Linux 桌面版；先走官网的镜像源 `https://quetzal.plutokeating.beer/dl/<tag>/<文件名>`，失败再直连 GitHub Release）到 `~/.quetzal/console/<版本>/` 并指 `console/current`。安装前**验证发版签名**：下载同一 Release 的 `SHA256SUMS` 与 `SHA256SUMS.sig`（先镜像源后 GitHub，信任根是签名而不是来源），用已装好的 node 以写死在脚本里的 Ed25519 公钥验签名、确认 `commit <提交> v<版本>` 行的标签就是这个版本，再核对压缩包的 sha256，任何一步不过都不装（没有签名清单的旧版本因此不装原生控制台）。能不能跑起来用 `readelf -d/-V`（或 `objdump -p`）只读解析 ELF，看依赖库（包里 `lib/` 自带的除外）在不在 `ldconfig -p` / 常见库目录、要求的 glibc 版本够不够——不再用会执行目标程序的 `ldd`；两个工具都没有就不查；musl 系统不装（原生控制台是 glibc 构建）。没有这个资产、下载或校验失败只提示，不致命；图标取自 `current/web/icons/Icon-{512,192}.png` 存为 `xyz.quetzal.console.png`；启动器 `~/.local/bin/quetzal-console`：服务没在跑先拉起，有原生控制台就 exec 它，否则 Chromium 系浏览器（含 Flatpak）`--app` 独立窗口，再否则 `xdg-open` / firefox；桌面项 `~/.local/share/applications/xyz.quetzal.console.desktop`（文件名与 `StartupWMClass` 都是 GTK 应用 id `xyz.quetzal.console`，原生窗口在 Wayland 的 app_id 与 X11 的 WM_CLASS 都是它），刷新缓存。浏览器退路的窗口配不上图标（任务栏显示浏览器图标，已知限制） |
| 界面 | 双语：`LANGUAGE` / `LC_ALL` / `LC_MESSAGES` / `LANG` 以 `zh` 开头（简体、繁体）为中文，否则英文，`--lang` 可强制。颜色按 `-t 1`、`NO_COLOR`、`TERM`、`COLORTERM` 分 truecolor / 256 色 / 无色；UTF-8 locale 才用 ✓ ✗ ▸ 与半格字符画的光团（与 App 图标同一颗球，颜色按 favicon 的径向渐变逐像素算），否则退回 ASCII。长步骤转圈，输出全部进 `~/.quetzal/install.log`（家目录写不进时用 `mktemp` 建的临时文件，不用固定文件名），失败打印最后 25 行。生成的垫片、守护循环、启动器、crontab 与桌面项里的路径一律正确转义（sh 单引号、桌面项 Exec 的双引号与 `%%`、crontab 的 `\%`），家目录带空格或引号也能用 |

卸载（`--uninstall`）：停掉并删除 systemd 单元（含守护开关的覆盖片段）或守护循环、crontab 项、自启动项、桌面项与图标（新旧两种名字）、两个垫片、`~/.quetzal/npm` 与 `~/.quetzal/console`；`--purge` 删整个家目录；nvm、Node、git 不动。

命令沙箱（`ensure_sandbox` 与 `ensure_landlock`，参考 DeepSeek Harness 的「先 bubblewrap、不行用 Landlock」）：
1. 用包管理器装 bubblewrap（Debian / Ubuntu / Fedora / RHEL 系 / Arch / Alpine / openSUSE 的包名都是 `bubblewrap`），实际建一次沙箱；
2. 建不了且是 AppArmor 限制了非特权用户命名空间（Ubuntu 23.10 起，`kernel.apparmor_restrict_unprivileged_userns=1`）：用管理员权限把 bwrap 复制到 `/usr/local/lib/quetzal/bwrap`，只给它装 `/etc/apparmor.d/quetzal-bwrap`（先装严格版：子进程拿不到能力；装不上退回简单版），不动系统的 bwrap、不关全局限制；每次重跑安装时，系统的 bwrap 升级过就跟着更新这份副本；
3. 还不行（内核禁止了非特权用户命名空间、在容器里）且 `/sys/kernel/security/lsm` 里有 `landlock`：从同版本的发布资产下载 `quetzal-<版本>-landrun-linux-<架构>.tar.gz`，按签名过的 `SHA256SUMS` 核对后装到 `QUETZAL_HOME/bin/landrun`（不需要管理员权限）；
4. 再不行：用包管理器装 proot（只有 Debian / Ubuntu 的官方源里有）。

都不可用时安装照常完成，但会醒目地提示：运行基座会拒绝执行她的命令，直到补上沙箱或在控制台明确允许不隔离运行。从控制台发起的升级在后台无终端运行，需要输密码的步骤会跳过（2 需要管理员权限），这时退到 Landlock。卸载时一并移除专用的 bwrap 与 AppArmor 配置。

验证：`bash -n`、shellcheck（`docker run --rm -v "$PWD/install.sh:/s.sh:ro" koalaman/shellcheck:stable -s bash /s.sh`），以及在干净容器里以管道喂给 bash（`cat install.sh | docker run -i --rm debian:bookworm-slim bash -c 'cat >/tmp/i.sh; apt-get update -qq && apt-get install -y -qq curl ca-certificates; cat /tmp/i.sh | bash -s -- --no-open'`）跑通 debian-slim（root、无 git）、ubuntu（非 root + sudo + 假桌面）、fedora、archlinux、alpine（musl）、alpine + `QUETZAL_NODE_ARCH=x64-musl`（unofficial-builds 直接下载 Node 的路径，与龙芯共用）。systemd 与桌面集成只能在真机验证。

## Windows（setup.exe、install.ps1、winget）

Windows 10 1809 起，x64 与 arm64。三种装法，做的事相同：

```powershell
irm https://quetzal.plutokeating.beer/install.ps1 | iex     # 首选：PowerShell 里一行
```

或从下载页取 `quetzal-<版本>-windows-<x64|arm64>-setup.exe` 双击安装；winget 清单已备好（见下文），还没有提交到 winget 官方仓库。不需要管理员身份运行，中途 Windows 请求一次管理员权限。

目录（`docs/WINDOWS_DECISIONS.md` 4.1）：`ROOT = %LOCALAPPDATA%\Quetzal`，`home\` 是 `QUETZAL_HOME`；`runtime\<版本>\`（`main.cjs`、`windows.mjs`、`windows-body.mjs`、`windows-supervise.mjs`、`srt.mjs`、`quetzal.mjs`、`VERSION`、`web\`、`srt-win\srt-win.exe`、`node_modules\`）与指针 `runtime\current.txt` / `previous.txt`（一行版本号，代替 Linux 的符号链接）；`console\<版本>\quetzal-console.exe` 与 `console\current.txt`；`node.txt`（运行基座用的 node.exe）；`bin\quetzal.cmd`（命令行，`bin` 加进用户 PATH）、`bin\quetzal-supervise.ps1`（守护启动器）；`uninstall.exe`；`install.log`（安装日志）。

### setup.exe 做什么（`windows/setup/quetzal.nsi`）

| 步骤 | 做法 |
|---|---|
| 检查 | Windows 10 build 17763 以上；安装包架构与真实 CPU 一致（arm64 机器上不装 x64 版）；简繁中文系统显示中文，其余英文 |
| 正在运行的 Quetzal | 按进程路径与命令行找守护、运行基座、身体助手、控制台；问过用户（静默安装时由 `/CLOSEAPPS` 表示同意）后先写 `home\state\quit` 让守护进程连同运行基座退出、结束计划任务，15 秒后还在的强制结束 |
| 文件 | 以用户身份装进 ROOT（上面的目录）；`bin\` 里的两个文件每个版本都一样 |
| 依赖 | 以用户身份查找：Node.js 22.13+ 且架构与安装包一致（ARM 上的 x64 Node 加载不了 arm64 的网状层组件）、Git、Python 3（跳过 `WindowsApps` 里的应用商店占位程序）。缺的才把内嵌的官方安装包解出来 |
| 一次提权 | `quetzal-machine.ps1` 以管理员运行一次：缺的 Node.js 24 / Git / Python 3.14 **机器范围**静默安装（沙箱用户才读得到；安装前按 `deps.json` 再核对一次 SHA-256）；`srt-win.exe install --proxy-port-range 60080-60089`（sandbox-runtime 0.0.78 的 `installArgs`：建 `srt-sandbox` 账户与 WFP 规则，代理端口段用它的默认值；配置不同（退出码 13）时加 `--force` 重装）；注册计划任务 `\Quetzal\Runtime-Boot`（开机、安装用户、S4U 不存密码、失败每分钟重启、无时限、电池也跑）与 `\Quetzal\Runtime-Logon`（登录、交互），两者都执行 `powershell.exe -WindowStyle Hidden -File ROOT\bin\quetzal-supervise.ps1`。S4U 注册失败只留登录任务，记进 `install.log` 与 `machine.json`。机器级步骤都已就绪（`machine.json` 里同一用户、同一 ROOT、同一个 `srt-win.exe`、沙箱装好过）时升级不再提权 |
| 切换 | `previous.txt` ← `current.txt` ← 新版本，`console\current.txt` 跟着走；`config\quetzal.json` 没有 `body` 时写机型名（`Win32_ComputerSystem.Model` 或 BIOS 的 `SystemProductName`，去掉厂商占位值，规整为 `^[a-z0-9][a-z0-9-]{0,39}$`，Windows 保留名加 `-pc`；拿不到用计算机名） |
| 启动与健康检查 | 先跑开机任务（S4U），不行跑登录任务，再不行直接拉起启动器；40 秒内 `GET http://127.0.0.1:<端口>/health` 的版本相符才算成功，否则指针退回上一版并重启（退出码 20）；成功后只留当前与上一版 |
| 桌面 | 开始菜单「Quetzal」与「卸载 Quetzal」；`HKCU\…\Run` 的 `Quetzal` = `"<控制台>" --background`（登录时只起托盘，托盘看护身体助手）；通知用的 AppUserModelID `xyz.quetzal.console`（`HKCU\Software\Classes\AppUserModelId`）；按用户的「应用」卸载项 |

守护启动器 `quetzal-supervise.ps1` 读 `node.txt` 与 `current.txt`，从注册表重建 PATH（刚装的 Git / Python 也找得到），清掉 `state\quit`，以 `QUETZAL_ROOT`、`QUETZAL_HOME` 前台运行 `"<node>" ROOT\runtime\<当前>\windows-supervise.mjs`，退出码原样返回（非 0 时开机任务一分钟后重启它）。路径稳定，所以升级不必重新注册任务。

参数：`/S` 静默、`/CLOSEAPPS` 同意关闭正在运行的 Quetzal、`/OPEN` 装完打开控制台窗口（静默时默认只起托盘）、`/ELEVATE` 强制重做机器级步骤、`/UPGRADE` 从控制台发起的升级（在会话 0 里需要提权时不弹 UAC，退出码 14「需要在这台电脑上运行一次安装」）。退出码：0 成功，3 正在运行且没同意关闭，4 关不掉，5 系统或架构不符，13 没有可用的 Node.js，14 见上，20 新版本不健康已退回，21 不健康且没有上一版，70 内部错误。

卸载（开始菜单、「设置 › 应用」或 `quetzal uninstall`）：关掉进程，再提权一次删除计划任务并执行 `srt-win uninstall`（移除 `srt-sandbox` 账户与 WFP 规则），删用户 PATH 里的 `bin`、Run 项、AUMID、快捷方式与程序文件；问要不要删数据（`home\`，默认保留，静默时 `/PURGE`）。Node.js、Git、Python 保留。

### install.ps1（官网的 `/install.ps1`）

源文件是 `windows/install.src.ps1`（中文直接写），`node windows/gen-install-ps1.mjs` 生成纯 ASCII 的 `install.ps1`（中文字符串换成运行时解码的 UTF-8 base64，Windows PowerShell 5.1 按 ANSI 代码页读脚本）；官网构建时由 `website/scripts/postbuild.mjs` 复制为 `/install.ps1`。兼容 Windows PowerShell 5.1；整段逻辑在函数里，最后一行才调用。步骤：

1. 系统版本、真实 CPU 架构（注册表 `Session Manager\Environment` 与 WMI `Win32_Processor`，ARM 上的 x64 模拟进程也认得出 arm64）。
2. 智能应用控制（`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` 的 `VerifiedAndReputablePolicyState`：1 开、2 评估、0 关）：开着就说明原因（它会拦下还没有代码签名的控制台、`srt-win.exe`、网状层的 `.node`），打开「应用和浏览器控制」设置页，等用户关掉后自动继续；评估模式只提示。
3. 版本：`QUETZAL_VERSION`，否则官网的 `/api/releases/latest`，不通再问 GitHub API。
4. 发版清单：`SHA256SUMS` 与 `SHA256SUMS.sig`，先官网镜像源 `/dl/<标签>/`、再直连 GitHub Release（与 `install.sh` 相同；信任根是签名）。Ed25519 验签在 PowerShell 里按 RFC 8032 用 `System.Numerics.BigInteger` 实现（.NET Framework 没有 Ed25519），公钥与 `install.sh` 同一个；再确认 `commit <提交> <标签>` 行，取出 setup.exe 的 SHA-256。
5. 下载 setup.exe，`Get-FileHash` 相符才以 `/S` 运行（交互时加 `/OPEN`；Quetzal 正在运行时先问，`QUETZAL_YES=1` 不问）。

环境变量（`iex` 不能传参数）：`QUETZAL_VERSION`、`QUETZAL_LANG=zh|en`、`QUETZAL_YES=1`；控制台发起的升级设 `QUETZAL_UPGRADE=1`（静默、不提问、允许关闭正在运行的 Quetzal、传 `/UPGRADE`）与 `QUETZAL_UPGRADE_ID`，输出追加到 `home\logs\upgrade.log`：开头 `== 升级 <编号> 开始 <时间>（目标 <版本>）`，每步一行以 ▸ ✓ ! ✗ 开头，结尾 `== 升级 <编号> 退出码 <n>`（运行基座的 `parseUpgradeLog` 读它）。交互运行时不调用 `exit`（会关掉用户的窗口）。

### 内嵌依赖与构建

`windows/deps.lock.json` 锁定 Node.js 24 LTS、Git for Windows、Python 3.14 的 x64 与 arm64 官方安装包（nodejs.org 的 `.msi`、github.com/git-for-windows 的 `.exe`、python.org 的 `.exe`）与 NSIS，写明下载地址、SHA-256、大小与哈希的出处。`node windows/fetch-deps.mjs <x64|arm64> <目录>`（`--tool nsis` 取 NSIS）只接受官方 https 主机，大小或哈希不符就失败。升级某一项：改 `version`、`file`、`url`、`sha256`、`size` 与 `source`，哈希从官方的 `SHASUMS256.txt` / 发布说明 / python.org 的发布文件记录取，再运行一次 `fetch-deps.mjs` 实际下载核对。

`node windows/build-setup.mjs --version … --arch … --runtime <runtime/dist> --srt-win … --mesh … --web … --cli <quetzal.mjs> --console <解开的控制台> --deps … --makensis … --out …` 把各部分放进暂存目录（布局即安装后的布局），再 `makensis` 编译。发版工作流的 `windows` job 在 `windows-latest`（x64）与 `windows-11-arm`（arm64）上完成全部步骤，并静默装一遍、看状态、再卸载作为不阻断的冒烟测试。

安装包与其中的程序暂未做 Authenticode 代码签名：从下载页下载的 setup.exe 会被 SmartScreen 提示，开着智能应用控制的电脑会拦（install.ps1 下载的文件没有网络来源标记，SmartScreen 不拦）。

### winget

`windows/winget/` 是 `PlutoKeating.Quetzal` 的清单模板（用户范围的 nullsoft 安装包，`/CLOSEAPPS`，x64 与 arm64）。发版后：`node windows/winget/make-manifests.mjs --version X.Y.Z --sums SHA256SUMS --sig SHA256SUMS.sig --out <目录>`（哈希只取自验过签名的清单），`winget validate` 后由所有者向 `microsoft/winget-pkgs` 提交。

### 命令行

安装后终端里的 `quetzal`（`bin\quetzal.cmd` → `"<node.txt>" runtime\<current.txt>\quetzal.mjs`）：`status`（版本、两个计划任务、健康、网关、局域网）、`open`（原生控制台，没有就用浏览器打开网页版）、`run`（前台运行，调试用）、`logs [-f]`（`home\logs\runtime.log`）、`start` / `stop` / `restart`（计划任务与 `state\quit`）、`rollback`（互换两个指针）、`uninstall [--purge]`（打开卸载程序）。`install` 在 Windows 上提示改用 setup.exe 或 install.ps1。

## 开发

| 命令 | 作用 |
|---|---|
| `npm test` | 单元测试（版本目录布局、systemd 单元文件与路径转义；`install.sh` 的发版签名校验、sha256 核对、引用转义与 ELF 依赖检查——去掉最后一行后 `source` 进 bash 单独调用函数，这两组在 Windows 上跳过；Windows 的版本指针、schtasks 输出解析与日志；依赖锁与下载核对、安装包构建的纯函数、winget 清单；`install.ps1` 与源文件一致且纯 ASCII，有 `powershell.exe` 或 `pwsh` 时再跑 PowerShell 测试：Ed25519 的 RFC 8032 测试向量与发版签名格式、升级日志首尾行、setup 辅助脚本的纯逻辑） |
| `node windows/gen-install-ps1.mjs` | 改了 `windows/install.src.ps1` 之后重新生成 `install.ps1` |
| `npm run build` | 类型检查 → `tool/bundle-runtime.sh`（构建 `../runtime` 并把 `main.cjs`、`linux.mjs`、版本号放进 `dist/runtime/`；再调用 `../console/tool/build-web.sh` 构建网页控制台放进 `dist/runtime/web/`，需要 Flutter，`FLUTTER=<路径>` 可指定，`QUETZAL_NO_WEB=1` 跳过）→ esbuild 打包 `dist/quetzal.mjs` |
| `npm pack` | 本地打包验证：`npx ./quetzal-<版本>.tgz status` |

版本号必须与 `runtime/package.json`、`console/pubspec.yaml` 一致，`tool/bundle-runtime.sh` 与发版工作流都会校验。发布由 `.github/workflows/release.yml` 在推送 `v<版本>` 标签时完成：npm 包在独立的 job 里构建，经 artifact 交给只做发布的 job，Release 创建成功后才发布（GitHub Packages 总是发布；npmjs.com 需要仓库 Secrets 里的 `NPM_TOKEN`，带 `--provenance`，缺少时跳过）。Release 的 `SHA256SUMS` 覆盖全部资产并带 `commit <提交> <标签>` 行，由仓库 Secret `RELEASE_SIGNING_KEY` 签名为 `SHA256SUMS.sig`。

源码地图见 [ARCHITECTURE.md](ARCHITECTURE.md)。
