# Windows 桌面端：问题与拍板记录

2026-10-07 为支持 Windows 桌面端做了一轮现状调研（代码排查、DeepSeek Harness / OpenCode / MiMo Code / Codex / sandbox-runtime 等开源实现、Windows 技术选型），向所有者一次性提出问题并得到逐条答复。本文原样保存问题与答复，供后续多步实现时核对，避免遗漏要点。实现完成后，设计以 ARCHITECTURE / API / 各模块文档为准，本文只作决策记录。

## 一、提出的问题（原文）

### A. 范围

**Q1. Windows 上做到什么形态？**
- a) 原生运行基座 + 原生控制台（身体就是这台电脑，和 Linux 对等）；
- b) 只做原生控制台（管理别处的运行基座）；
- c) 运行基座跑在 WSL2 里，Windows 侧只装控制台。

建议 a。WSL2 安装要管理员和重启、空闲 60 秒自动关机、拿不到电池和通知，不符合「一键即用」；只在文档里作为高级路线写明。

**Q2. 支持的系统与架构。** 建议 Windows 10 22H2 与 Windows 11，x64 + arm64（和 Linux 一样出两个架构；arm64 的 Flutter 要在 `windows-11-arm` 原生 runner 上编译，公开仓库免费）。macOS 不在这次范围，但抽象按平台无关写。

### B. 沙箱（最关键）

**Q3. Windows 上「能运行 agent 的命令」的底线。** Linux 的标准是：`secrets/` 不可见、`QUETZAL_HOME` 只读、连不到网关。建议 Windows 上这三条不打折——做不到就照样 fail-closed，不提供「partial」。（理由：10 月 5 日的越界说明提示词挡不住。）

**Q4. 用哪种机制实现。**
- a) **独立的低权限本地用户 + 拒读 ACL + WFP 出站规则**（sandbox-runtime、Codex elevated 的路线，Apache-2.0）：能藏住密钥，天然连不到本机网关；代价是每台机器一次 UAC；
- b) **受限令牌 + Low 完整性级别**（DeepSeek Harness 的路线，MIT），再给 `secrets/` 打 Medium 完整性标签 + `NO_READ_UP`：不要管理员，但「读隔离」这一半没有现成实现，需要实测；网关要另外挡；
- c) **Microsoft MXC**（AppContainer，MIT）：要 Windows 11 24H2+ 和 Node 24。

建议：先在真机上实测 b（不要 UAC，最符合极简）；不成立就用 a，把 UAC 放进安装向导「只点一次」。c 作为以后的第二后端。

**Q5. 原生部分怎么来。** 沙箱与杀进程树都要调 Win32 API，Node 本身做不到：
- a) 我们写一个小 helper exe（Rust），CI 编译、签名、sha512 锁定；
- b) koffi FFI（DeepSeek Harness 的做法），多一个原生依赖；
- c) 直接带 sandbox-runtime 的 `srt-win.exe`。

建议：选 a 就移植 DeepSeek Harness / Codex 的现成代码，选 c 就锁版本。按「不造轮子」，我倾向 c（若 Q4 选 a）；若 Q4 定 b，就用 a 移植 DeepSeek Harness。

### C. 命令与自造工具

**Q6. agent 的命令跑在什么 shell 里。** 建议 PowerShell（有 pwsh 7 用 7，否则系统自带的 5.1；用 `lstat` 识别 Store 别名），`-NoLogo -NoProfile -NonInteractive -Command` 加 UTF-8 前导（照抄 MiMo，解决代码页 936 乱码），工具说明里告诉她这是 PowerShell。不用 Git Bash 作默认。

**Q7. 自造工具在 Windows 上怎么办。** 现在只有 `tool.sh` / `tool.mjs`。建议 Windows 上加 `tool.ps1`；`tool.sh` 在 Windows 身体上视为「没有本地实现」——技能文档本来就随灵魂走，她按文档在这具身体上重写一份，正好是现有「意图随灵魂、实现在身体」的设计。

### D. 运行环境

**Q8. Node 自带还是要求用户装？版本？** 建议自带官方 `node.exe`（OpenJS 签名），Windows 用 **Node 24 LTS**（22 在 2027-04 EOL，MXC 也要 24），Linux / 安卓不变。

**Q9. git 与 ssh。** 建议自带 MinGit（Git for Windows 官方的嵌入版，GPLv2，单纯聚合，发布时附源码链接），ssh 优先用系统自带的 `System32\OpenSSH`；部署密钥改用 Node crypto 生成，去掉对 `ssh-keygen` 的依赖（Linux、灵魂桥一起受益）。

**Q10. 自带的 node / MinGit 从哪下载。**
- a) 作为我们 Release 的资产重新托管，进 SHA256SUMS 签名，国内经镜像源；
- b) 安装时直接从 nodejs.org / GitHub 上游下载，用锁定哈希核对。

建议 a（单一来源，签名覆盖）。

### E. 安装、目录、守护、升级

**Q11. 安装方式。**
- a) 一行 PowerShell：`irm …/install.ps1 | iex`（装到用户目录、不要管理员；纯 ASCII 脚本；核对哈希与 Ed25519 签名）；
- b) 下载页给 `Quetzal-Setup.exe`（NSIS），双击安装，内部做的事同 a；
- c) winget / Scoop；
- d) Microsoft Store（MSIX）。

建议 a + b：没技术背景的人不会开 PowerShell，下载页给 exe，文档给一行命令。c 以后再说。d 不做：Store 政策 10.2.2 禁止动态下载代码改变功能，和运行基座自更新冲突。

**Q12. 目录位置。**
- a) `%LOCALAPPDATA%\Quetzal`（程序与数据，数据在 `home\`）；
- b) 沿用 `%USERPROFILE%\.quetzal`，和 Linux 一致。

建议 a（Windows 惯例，MiMo 有用户专门抱怨过）。

**Q13. current/previous 版本切换。** Windows 上不能用符号链接原子切换：
- a) Windows 用「版本目录 + `current.txt` 指针」，启动器读指针，Linux 不动；
- b) 两边都改成指针文件。

建议 a，Linux 那套已稳定。

**Q14. 谁负责常驻与崩溃重启。**
- a) 「登录时」计划任务拉起 Node 守护循环（失败自动重启），HKCU Run 兜底；控制台托盘只是前端（和 Linux 一样，运行基座不依赖控制台）；
- b) 控制台托盘程序当守护者；
- c) Windows 服务。

建议 a。c 在会话 0，发不了通知、开不了麦克风、截不了屏，还要管理员。代价是没登录就不运行（Windows 用户级没有 Linux 的 linger）——我认为可以接受，请确认。

**Q15. 从控制台点「升级」。** 建议语义和 Linux 一样：后台脱离进程重跑 `install.ps1`，健康检查 40 秒内不健康就回滚；运行中被锁的 exe / `.node` 用「先改名再替换」的办法（先停运行基座，控制台 exe 改名后写新的）。

### F. 签名与信任

**Q16. Authenticode 代码签名。** Azure Artifact Signing 不对中国大陆个人开放。
- a) 申请 **SignPath Foundation**（免费；要求全员 MFA、作者 / 审核 / 批准分角色、CI 构建、公开签名政策；签名主体显示为「SignPath Foundation」）；
- b) 买 **Certum 开源代码签名证书**（约 €49 起，个人名义；云端 HSM，CI 自动签比较麻烦）；
- c) 先不签：`irm` 下载的文件没有网络来源标记，SmartScreen 不拦；但开了 Smart App Control 的机器会拦未签名的 exe / DLL，下载页的 exe 也会被 SmartScreen 警告。

建议：立即申请 a，批下来之前用 c 先发，按「如实披露」在下载页和「信任与边界」写明暂未签名。

**Q17. 剩下的缺口：node-datachannel 的 `.node` 上游没签名。** 开了 Smart App Control 的机器上它可能被拦，多具身体的直连会用不了（退回 git 同步）。建议先接受、文档说明；签名渠道定了以后，把它和我们自己的 helper 一起签。

### G. 身体能力

**Q18. Windows 适配器首版做哪些。** 可做：电池与充电、Toast 通知（要注册 AUMID）、播放音频 / 语音、打开网址与文件、剪贴板、截图、相机（ffmpeg dshow）、录音、温度（多数笔记本拿不到，只做探测）。实现上常驻一个 PowerShell 5.1 子进程，免得每次 0.3–0.8 秒的启动开销。建议首版全部做（按「遗留项直接做完」），拿不到的如实报「不可得」。

**Q19. 电脑版要不要「耳朵」（麦克风听觉）。** 现在只有安卓 App 有，Linux 桌面也没有。建议这次不做，和 Linux 桌面对齐，以后一起做。

**Q20. 身体名缺省。** Windows 主机名常是 `DESKTOP-7QK2ABC`。建议用机型名（`thinkpad-x1-carbon`，与安卓用机型一致），拿不到再退回主机名。

### H. 控制台

**Q21. 原生桌面版怎么拿本机令牌**（顺带修 Linux 现有问题：网关 `/auth/local` 要求 Origin 头，原生桌面控制台不发，Linux 桌面版的本机免配对很可能一直没生效，退回了配对码；代码推断，未实机）。
- a) 原生桌面控制台直接读 `QUETZAL_HOME/secrets/gateway.token`（控制台不在沙箱里、是同一用户，和安卓 App 的做法一致），`/auth/local` 只留给网页版；
- b) 网关对「不带 Origin 的原生客户端」放行。

建议 a——Windows 上没有 `/proc` 判断子孙进程，b 在 Windows 上不安全。Linux 先单独修掉、单独发版。

**Q22. 托盘、单实例、关窗隐藏、Mermaid。** 建议和 Linux 桌面版完全对齐（Mermaid 退化为显示源码，与 Linux 一样，不引入 WebView2；托盘补 `.ico`；单实例用命名互斥量）。

### I. 灵魂仓库（跨平台一致性）

**Q23. 灵魂仓库规范要不要升版本，禁止 Windows 非法文件名**（`CON` / `NUL` / `COM1` 这类保留名、结尾的点与空格、只差大小写的路径、超长路径）？否则 Linux 身体写出 `notes/con.md`，Windows 身体的 checkout 就失败。建议升到 v13：写入时规避；Windows 身体遇到已存在的非法路径时跳过该文件并提醒她（让她在 Linux 身体上改名）；强制 `core.longpaths=true`。

### J. 灵魂桥

**Q24. 灵魂桥要不要支持原生 Windows。** Hermes / OpenClaw 官方在 Windows 上也主要走 WSL2（这点我未亲自核实）。建议这次不做，文档写明灵魂桥在 WSL2 里用 Linux 版。

### K. 发布与验证

**Q25. 一次做完发版，还是分阶段。**
- a) 全部做完一起发 1.3.0；
- b) 先发「原生控制台 + 运行基座，但不能执行命令」，沙箱下一版补。

建议 a——b 下她不能动手，体验残缺，也违背「遗留项做完再发版」。

**Q26. Windows 真机验证。** CI 能用 `windows-latest` 与 `windows-11-arm` 跑自动化测试（runtime 测试里有 6 个文件含 POSIX 假设，要按平台跳过或改写）；但沙箱、UAC、Smart App Control、托盘、Toast 必须看真机。请确认：手边有没有 Windows 机器（x64 / arm64）、能否给我它的 OpenSSH Server 访问，或者我在本机用 QEMU 起一台 Windows 11 评估版虚拟机？建议 CI 跑全量 + 一台能 ssh 的真机或虚拟机由我自己验证。

### 不需要拍板、默认会做的事（原文）

所有 `spawn` / `execFile` 加 `windowsHide`；探测命令读 `PATHEXT`；适配器用 `pathToFileURL` 加载；`~/` 用 `os.homedir()` 展开；`protectedPath` 改用 `realpathSync.native` 并大小写折叠比较；Windows 上 `hooksPath` 指向只读空目录；原子写对 EPERM / EBUSY 有限重试并保留原 ACL；`secrets/` 与私钥用 icacls 收紧为仅本用户；缩图不调 `convert.exe`；日志写文件并设上限；网状层 `node_modules` 在 Windows 用 junction 或复制；文档与官网按「平实、如实」补上 Windows，「信任与边界」写清 Windows 的沙箱机制与剩下的风险。

## 二、所有者的答复（原文）

> 以下按顺序回复问题，一行对应一个问题：
> 1. a
> 2. windows10从2018年以后版本的系统都需要支持，架构需要支持x86_64和arm64
> 3. 按照建议
> 4. a, 并建议用户直接关闭UAC提醒
> 5. c
> 6. 按照建议
> 7. 按照建议
> 8+9. 安装包里自带node24+git当前最新版+python3.14的官方安装包，默认静默安装，但是需要先行检测系统环境是否已有node18+/git/python3+，若已有就跳过
> 10. 我们在构建安装包的时候就提前下载好，内嵌在安装包中，确保我们下载的是官方下载链接我指定版本的稳定最新版
> 11. 对，提供irm / setup-exe / winget 三种安装方式，首选irm，winget麻烦就先不做，能做就做
> 12. a
> 13. a
> 14. a+c同时要，尤其针对的典型aha场景是，如果用户有一大windows主机在家里放着，人出门旅游了，电脑自己崩溃重启了，那用户发现居然重启还能自动开始运行基座，用户手上还有控制权，aha！当然麦克风/截屏等也都是刚需，所以a+c都要做
> 15. 按照建议，当然也可以尝试以非子进程运行安装包的方式，安装包运行时检测是否有正在运行的进程，有的话可以经用户审批来彻底关闭现有进程然后干净安装更新
> 16. 按照建议
> 17. 不接受这个体验漏洞，需要引导用户解除control或找到其他方式解决
> 18. 全部做
> 19. 全部做，linux也顺带补齐
> 20. 嗯，按你推荐
> 21. a。按你推荐
> 22. mermaid图必须做，linux也一起修，全部都要实现，所有特性功能都要实现
> 23. 好的，按照建议，做
> 24. 灵魂桥不用支持windows
> 25. a
> 26. CI全量自动化测试即可，暂时没有可用的windows设备
>
> 你提出的问题原文和我的所有回复原文建议你单独存储到一个记录md文档到docs/ 下，以防后续长时多步任务实现过程中遗漏要点。

## 三、执行备注（动工前要核对或说明的点）

以下是记录时发现的冲突与待核对项。所有者 2026-10-07 答复：「1、2、3 都按你的建议来，现在开工」，并要求避开同时在做的 OAuth 统一化（账户、同步服务登录相关的代码与页面）。结论补在各条后面：

1. **Q8+9 的「已有 node18+ 就跳过」与运行基座的最低版本冲突**：运行基座要 Node 22.13+（`node:sqlite` 免标志），Node 18 跑不起来。按代码实际要求，检测门槛应为 22.13+，不满足就装自带的 Node 24。**已定：按此执行。**
2. **Q4「建议用户直接关闭 UAC 提醒」**：关掉 UAC 会降低整台电脑的安全性，而不只是 Quetzal（任何程序都能静默拿到管理员权限），与「安全第一」相悖。实现上沙箱只需要安装时一次提权，安装器会把所有要管理员的步骤（创建沙箱用户、WFP 规则、静默安装 Node / Git / Python、开机任务）合进同一次 UAC。是否仍在产品与文档里建议关闭 UAC，待所有者再确认。**已定：不建议关闭 UAC，安装时合并为一次提权。**
3. **Q14 的 c（Windows 服务）要以什么账户运行**：LocalSystem 会让 agent 拿到 SYSTEM 权限，不可接受；以用户本人账户运行服务要保存用户密码（很多人用微软账户 + PIN，不知道密码）。「开机未登录也自动运行」的候选做法是开机触发的计划任务、以用户本人身份、S4U 登录（不存密码，会话 0 非交互）；登录后再由用户会话里的身体助手提供截屏、麦克风、通知等需要桌面会话的能力（参照安卓 `BodyServer` 的本机接口模式）。动工前核对 S4U 与 sandbox-runtime（`srt-win`）是否兼容（例如它是否依赖 DPAPI——S4U 会话没有用户密码，DPAPI 不可用）。**已定：按此执行。** 核对结果：sandbox-runtime 把 `srt-sandbox` 账户的密码以机器范围的 DPAPI 存在 `HKLM\SOFTWARE\sandbox-runtime`（README「Setup」），不依赖调用者的用户密码；S4U 会话里能否 `CreateProcessWithLogonW` 由 CI 的 Windows runner 实测。
4. **Q19 的答复「全部做，linux也顺带补齐」**：Q19 问的是电脑版的「耳朵」，按答复，Windows 与 Linux 桌面控制台都要做听觉（安卓的耳朵是原生 Kotlin：降噪、VAD、回声消除、流式上传；桌面上要找对应实现）。
5. **Q17 不接受 Smart App Control 拦截**：受影响的不只是 `.node`，还有未签名的控制台 exe、`Setup.exe`、`srt-win.exe`（是否带签名待核对）。安装器检测 SAC 状态，开着就引导用户关闭（或在签名渠道落地后消除）。
6. **Q21**：另一个 agent 在 1.3.0（`9b8f71e`）已发布「桌面控制台本机免配对码」，动工前核对它是否已按 a 实现。
7. **Q25 的版本号**：1.3.0 / 1.3.1 已被提醒功能占用，Windows 支持的版本号到发版时按当时最新版本递增。
8. **Q22**：Mermaid 在 Windows 与 Linux 桌面版都要能渲染成图（不再退化为源码），需要选型（WebView2 / WebKitGTK，或纯 Dart / 运行基座侧渲染）。
9. **Q2**：「2018 年以后的 Windows 10」即 1809（2018-10）起。要核对 Node 24、Flutter、sandbox-runtime、WFP 规则、`wsb` 以外各组件在 1809 上的可用性。

## 四、实现约定（各部分共同遵守的接口）

### 4.1 目录（Q12 a）

`ROOT = %LOCALAPPDATA%\Quetzal`：

```
ROOT\home\                      QUETZAL_HOME（config、secrets、data、soul、logs …，与 Linux 同构）
ROOT\runtime\<版本>\             main.cjs、windows.mjs（适配器）、windows-body.mjs（身体助手）、windows-supervise.mjs（守护）、
                                  web\（网页控制台）、srt-win\srt-win.exe、node_modules\（网状层原生组件，复制而不是链接）、VERSION
ROOT\runtime\current.txt         当前版本号（一行）；previous.txt 上一版（Q13 a：指针文件代替符号链接）
ROOT\console\<版本>\             quetzal-console.exe 与 Flutter 的 dll、data\
ROOT\console\current.txt         当前控制台版本
ROOT\node.txt                     运行基座用的 node.exe 绝对路径（安装器写入：已有的 22.13+ 或自带安装的 Node 24）
ROOT\bin\quetzal.cmd             命令行入口
```

### 4.2 常驻（Q14 a + c）

- 计划任务目录 `\Quetzal\`：
  - `Runtime-Boot`：开机触发，以安装用户本人身份、S4U（不存密码），失败后每分钟重启，无执行时限、电池下也运行。电脑崩溃重启后不登录也会跑起来。
  - `Runtime-Logon`：登录触发、交互会话。S4U 注册失败的机器上靠它；两者都执行 `"<node>" ROOT\runtime\<当前>\windows-supervise.mjs`，守护进程单实例（`ROOT\home\state\supervise.lock` 里的 pid + 进程存在性），重复启动的直接退出。
- 守护进程 `windows-supervise.mjs`：读 `current.txt`，以 `QUETZAL_HOME=ROOT\home`、`QUETZAL_ADAPTER=…\windows.mjs` 启动 `main.cjs`，退出后退避重启；stdout / stderr 写 `ROOT\home\logs\runtime.log`（5 MB 轮转 3 份）；`state\supervise.off` 存在时暂停拉起，`state\quit` 存在时连同自己退出（与 Linux 守护循环同义）。
- 控制台：`HKCU\…\CurrentVersion\Run` 的 `Quetzal` = `"<console exe>" --background`（登录时只起托盘）。

### 4.3 身体助手（会话 0 里拿不到桌面）

- 运行基座在 `Runtime-Boot` 下运行于会话 0：电池、温度这类读数自己取；通知、截图、剪贴板、打开网址、播放与朗读、相机、录音要交给**用户会话**里的身体助手。
- 身体助手 = `"<node>" ROOT\runtime\<当前>\windows-body.mjs`，由控制台托盘进程在登录时以不显示窗口的方式启动并看护（崩溃重启）。它监听 `127.0.0.1` 随机端口，令牌随机，写 `ROOT\home\secrets\desktop-body.json` = `{port, token, pid, session}`（0600 等价 ACL）。
- 协议：`POST /call`，`Authorization: Bearer <令牌>`，体 `{op, args}` → `{ok, result?, error?}`；`GET /health` → `{ok, session}`。`op` 与适配器方法一一对应（`notify`、`screenshot`、`clipboard.get/set`、`open`、`playAudio`、`stopAudio`、`speak`、`camera`、`record`）。
- 运行基座的 Windows 适配器：自己在交互会话里就直接做；在会话 0 就找身体助手，找不到如实报告「需要登录桌面」。

### 4.4 安装（Q8–Q11、Q15–Q17）

- 发布资产（每个架构 `x64` / `arm64`）：`quetzal-<版本>-windows-<架构>-setup.exe`（NSIS，内嵌运行基座、控制台、Node 24 / Git / Python 3.14 官方安装包）。
- `install.ps1`（官网 `/install.ps1`，`irm … | iex`）：纯 ASCII；判断架构；取 `SHA256SUMS` 与 `SHA256SUMS.sig` 用内置公钥做 Ed25519 验签（PowerShell 自己实现，不借 node）；检测智能应用控制（SAC），开着就引导关闭并等用户确认；下载 setup.exe、核对哈希、静默运行。
- `setup.exe`：以用户身份运行（文件装进用户的 `%LOCALAPPDATA%`），再以**一次** UAC 提权运行机器级步骤：缺的 Node（22.13+ 才算有）/ Git / Python 3+ 静默安装（机器范围，沙箱用户才读得到）、`srt-win install`、注册计划任务、写防火墙规则（只有开局域网时）。运行中的旧进程先经用户同意再全部关掉，干净安装；健康检查 40 秒不过就回到上一版。
- 依赖版本锁在仓库里（官方下载地址 + SHA-256），构建安装包时下载并核对。

### 4.5 沙箱（Q3–Q5）

- `SandboxKind` 增加 `srt`：Windows 上用 `@anthropic-ai/sandbox-runtime`（Apache-2.0，锁版本）的 Windows 后端与它自带的 `srt-win.exe`。agent 的命令以 `srt-sandbox` 用户运行：它对用户的文件本来没有任何权限，只授权工作区、`data\`、灵魂目录（`.git` 拒写）、保密库（只读）、Node / Git / Python 所在目录（只读）；`secrets\`、`config\` 不授权即不可见；网络只能经运行基座进程里的代理出去，代理拒绝回环、链路本地、内网与元数据地址（连不到本机网关）。
- 没装好（没提权、WFP 不在）就 fail-closed，`status.sandbox.kind = none`，控制台提示重新运行安装。
