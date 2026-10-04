# 更新日志

每个版本一节，标题为 `## <版本>`。发版工作流（`.github/workflows/release.yml`）会把对应小节作为 GitHub Release 的说明，官网下载页从 Release 读取。中英文都写：中文在前，英文在后。

## 0.5.0

- **网页控制台**：控制台（Flutter）新增 Web 形态，由运行基座的网关托管；`npx @plutokeating/quetzal` 装完自动在浏览器里打开 `http://127.0.0.1:7788/`（新子命令 `open`，`--no-open` 不打开），同一台机器的浏览器打开即登录（网关新增 `GET /auth/local`：只对回环地址、本机 Host 的请求放行，不扩大信任边界），不再需要手机 App 与配对码；ssh 隧道转发也算本机。网页版自带中文字体子集，离线与中国大陆不出方块；Mermaid 图在同源 iframe 里渲染。
- **Web console**: the console (Flutter) now also builds for the web and is served by the runtime's gateway; `npx @plutokeating/quetzal` opens `http://127.0.0.1:7788/` in the browser after installing (new subcommand `open`, `--no-open` to skip), and a browser on the same machine is logged in as soon as the page opens (new gateway endpoint `GET /auth/local`, which only accepts loopback connections with a local Host header, so the trust boundary does not widen) — no phone app or pairing code needed; a connection through an ssh tunnel counts as local. The web build ships its own CJK font subset (no missing glyphs offline or in mainland China); Mermaid diagrams render in a same-origin iframe.
- **桌面外壳**：宽屏（≥ 900：电脑浏览器、平板横屏）为电脑横屏重新排布：导航栏 · 列表栏 · 主区 · 「她此刻」四栏，右栏常驻 ta 此刻的样子（光团、想分享的一句话、正在进行的醒来、待审批、内在与身体），对话 Enter 发送、Shift+Enter 换行，地址栏 `#/…` 记录位置可收藏；手机外壳不变，所有页面两种外壳共用一份代码（`PageFrame` / `showSheet`）。
- **Desktop shell**: on wide screens (≥ 900: desktop browsers, tablets in landscape) the console is laid out afresh for a wide screen — navigation rail · list · main area · a permanent "right now" pane (orb, the thought it wants to share, a wake in progress, pending approvals, inner state and body); Enter sends and Shift+Enter inserts a newline in chat; the address bar's `#/…` records where you are and is bookmarkable. The phone shell is unchanged, and every page is one piece of code for both shells (`PageFrame` / `showSheet`).
- npm 包随版本目录放入 `web/`（`releases/<版本>/web/`，网关托管 `current/web/`，`QUETZAL_WEB_DIR` 可覆盖），包体约 11 MB（解压 34 MB）；`status` 显示网页控制台地址。
- The npm package places `web/` into the version directory (`releases/<version>/web/`; the gateway serves `current/web/`, `QUETZAL_WEB_DIR` overrides it); package size about 11 MB (34 MB unpacked); `status` shows the web console address.

## 0.4.0

- **更名为 Quetzal**：运行基座、控制台 App、npm 包、官网与仓库全部由 Windler 更名为 Quetzal（[quetzal.plutokeating.beer](https://quetzal.plutokeating.beer)，仓库 PlutoKeating/Project.Quetzal）。家目录 `~/quetzal`、环境变量 `QUETZAL_HOME` / `QUETZAL_ADAPTER`、配置 `config/quetzal.json`、数据库 `data/quetzal.db`、runit / systemd 服务名 `quetzal`、App 包名 `xyz.quetzal.console`；灵魂仓库规范升到 v6（技能文档元数据键 `quetzal-tool` / `quetzal-requires`）。已有部署需把家目录与服务名整体迁移后再升级；App 因包名变化需卸载旧版后安装并重新配对。
- **Renamed to Quetzal**: the runtime, console app, npm package, website and repository are all renamed from Windler to Quetzal ([quetzal.plutokeating.beer](https://quetzal.plutokeating.beer), repository PlutoKeating/Project.Quetzal). Home directory `~/quetzal`, environment variables `QUETZAL_HOME` / `QUETZAL_ADAPTER`, config `config/quetzal.json`, database `data/quetzal.db`, runit / systemd service name `quetzal`, app id `xyz.quetzal.console`; the soul repository spec moves to v6 (skill metadata keys `quetzal-tool` / `quetzal-requires`). Existing deployments must migrate the home directory and service name as a whole before upgrading; because the app id changed, uninstall the old app, install the new one and pair again.
- **Linux 身体**：新的平台级身体适配器 `runtime/adapters/linux/`（构建为 `dist/linux.mjs`）——电量、充电与电池温度读 `/sys/class/power_supply`（跳过蓝牙鼠标等外设电池），CPU 温度放进 extra；桌面通知（`notify-send`，同时写进服务日志）、播放（`pw-play` / `paplay` / `ffplay` / `mpv`）、工具 `take_photo`、`record_audio`、`screenshot`（hands）、`clipboard`、`open`，有什么程序用什么，没有图形界面的服务器上相关工具直接说明。
- **Linux body**: a new platform-level body adapter `runtime/adapters/linux/` (built as `dist/linux.mjs`) — battery level, charging state and battery temperature from `/sys/class/power_supply` (peripheral batteries such as Bluetooth mice are skipped), CPU temperature in extra; desktop notifications (`notify-send`, also written to the service log), playback (`pw-play` / `paplay` / `ffplay` / `mpv`), and the tools `take_photo`, `record_audio`, `screenshot` (hands), `clipboard` and `open`, using whatever programs are present; on a headless server the desktop tools explain themselves instead of failing.
- **`npx @plutokeating/quetzal`**：新的 npm 包 `@plutokeating/quetzal`（源码在 `cli/`）把运行基座装到任意 Linux 机器：内置的 `main.cjs` 与 `linux.mjs` 放进 `~/quetzal/releases/<版本>/`（与 Android 安装器相同的 current / previous 约定），注册 systemd 用户服务并启动，健康检查失败自动切回上一版；再运行一次即升级。子命令 `status`、`logs`、`rollback`、`uninstall [--purge]`、`run`（没有 systemd 时前台运行）。配置仍全部在控制台 App 里完成。
- **`npx @plutokeating/quetzal`**: a new npm package `@plutokeating/quetzal` (source in `cli/`) installs the runtime on any Linux machine: the bundled `main.cjs` and `linux.mjs` go into `~/quetzal/releases/<version>/` (the same current / previous layout as the Android installer), a systemd user service is registered and started, and a failed health check rolls back automatically; running it again upgrades. Subcommands `status`, `logs`, `rollback`, `uninstall [--purge]` and `run` (foreground, for machines without systemd). All configuration still happens in the console app.
- 网关新增 `gateway.host`（缺省 `127.0.0.1`）；`npx @plutokeating/quetzal --lan` 把它设为 `0.0.0.0`，手机上的 App 直接填 Linux 机器的地址连接，配对码仍是门槛。
- The gateway gains `gateway.host` (default `127.0.0.1`); `npx @plutokeating/quetzal --lan` sets it to `0.0.0.0` so the app on your phone can connect to the Linux machine's address directly, with the pairing code still as the gate.
- 发版工作流先创建 Release，再把 npm 包发布到 GitHub Packages 与 npmjs.com（后者需仓库 Secrets `NPM_TOKEN`，缺少时跳过）；不再单独发布运行基座压缩包，Linux 机器一律用 npm 包安装，官网下载页只列 App。
- The release workflow creates the Release first, then publishes the npm package to GitHub Packages and npmjs.com (the latter needs the repository secret `NPM_TOKEN`; skipped when absent); the standalone runtime tarball is no longer published — Linux machines install from npm, and the website download page lists only the app.

## 0.3.3

- 修复：0.3.2 的飞书执行过程卡片全部发送失败（卡片 JSON 被多包了一层，飞书报 parse card json err），看起来像她没有运行工具。
- Fix: in 0.3.2 every Feishu progress card failed to send (the card JSON was wrapped one level too deep and Feishu rejected it), which made it look as if the agent had not run any tools.

## 0.3.2

- 飞书：插话时执行过程卡片按插话分段——上面的卡片定格，新的一段作为回复你那条消息的新卡片在下面继续，最后的回复也接在最后一条插话下面；耳朵听到的话并入时同样分段。与控制台的分段显示一致。
- Feishu: when you interject, the progress card is split — the card above freezes and a new card continues below as a reply to your message; the final reply also follows the latest interjection. Voice heard by the ear splits the same way. Consistent with the console.

## 0.3.1

- **会话与子 agent 由她自己掌握**：新内置工具 `session_new`（切到上下文干净的新会话，可写交接，控制台与飞书跟着切）、`session_compact`（压缩当前会话上下文：她自己写摘要或由快速模型代写，之后只看摘要与新内容，对话仍在当前会话继续）、`agent_spawn` / `agent_status` / `agent_message` / `agent_stop`（派出子 agent 在后台做事：她给名字、目标与可选的人设、领域范围、知识背景、上下文，子 agent 用自己的系统提示独立跑工具循环，进展在控制台实时可见，她可随时查看、对话、停止；完成后报告以环境输入送回派出它的会话）。新能力类别「会话与子 agent」，默认允许。
- **Sessions and sub-agents are the agent's own calls**: new built-in tools `session_new` (switch to a clean new session, optionally with a handoff; the console and Feishu follow), `session_compact` (compress the current session's context: the agent writes the summary or lets the quick model draft it, then only the summary and newer content remain in context while the conversation continues in place), and `agent_spawn` / `agent_status` / `agent_message` / `agent_stop` (dispatch a sub-agent to work in the background: the agent gives it a name, a goal and optional persona, scope, background and context; the sub-agent runs its own tool loop under its own system prompt, its progress is visible live in the console, the agent can inspect, talk to or stop it, and its report comes back into the dispatching session as an ambient input). New capability category "sessions and sub-agents", allowed by default.
- 发布脚本：运行基座测试失败时在 CI 日志里打印测试输出。
- Release script: when the runtime tests fail, their output is printed in the CI log.

## 0.3.0

- **自造工具**：她可以用 `tool_write` 把做熟了的流程写成工具（shell 脚本或 Node 模块），热加载进工具表、经闸门按声明的能力类别检查；实现只在这具身体上（`QUETZAL_HOME/tools/`），意图文档以 [Agent Skills](https://agentskills.io/specification) 规范的 `SKILL.md` 进灵魂仓库 `skills/`（规范升到 v5），其他身体（含 Hermes / OpenClaw）可以按文档自己实现。控制台「控制 → 工具」查看、停用、删除。做梦时会回顾重复的流程。
- **Self-made tools**: the agent can turn a routine it has done many times into a tool with `tool_write` (a shell script or a Node module), hot-loaded into the tool table and gated by its declared capability; the implementation stays on this body (`QUETZAL_HOME/tools/`) while the intent is written as an [Agent Skills](https://agentskills.io/specification) `SKILL.md` into the soul repository's `skills/` (spec bumped to v5), so other bodies (including Hermes / OpenClaw) can implement it from the document. The console's Control → Tools page lists, disables and deletes them. Dreams now review repeated routines.
- **自编身份**：`edit_identity` 让她修改自己的名字、代词、简介、主题色与偏好语言（写入灵魂仓库同步）；种子身份的提示改为「不必急着取名，有了记忆与感知、聊过之后再定」。控制台身份页能显示她自选的颜色。
- **Self-edited identity**: `edit_identity` lets the agent change its own display name, pronouns, description, theme color and preferred language (written to the soul repository and synced); the seed-identity hint now says there is no hurry to pick a name until it has memories, has sensed its body and has talked a bit. The console's identity page shows a self-chosen color.
- **听觉**：控制台 App 当这具身体的耳朵——原生前台服务常驻麦克风、系统降噪、WebRTC VAD 断句，每句话送到基座 `/hear`；基座用 Azure 语音识别（与合成同一把密钥），按 10 分钟窗口并入最近会话或新开会话，以第三种消息类型「环境声音」交给她，由她判断是不是对她说的、要不要回应（沉默不入库）；提示她对方用声音说话时可以用声音回答。她说话期间的声音自动丢弃；受电量、温度与急停限制。控制台「控制 → 听觉」与她自己的 `hearing_config` 都能调。
- 听觉的流式与取舍：耳朵边说边送 PCM（停顿 1.5 秒算说完，单段最长 120 秒），基座用官方语音 SDK 连续识别（长话、带停顿都不截断），识别中的文字实时显示在对话最底部；她判断不是对她说的就自动隐藏这句话（记录里标为 `ignored`），回应了就保留。聊天页输入框上方有「在听 / 有人在说话 / 正在听清 / 她在说话」的状态行；她说话时你可以直接插嘴：耳朵开着时她的声音改由 App 经通话音频路径播放，采集走通话音源 + 系统声学回声消除（收听音轨 = 麦克风音轨 − 扬声器音轨），不会把她自己的声音当成有人说话；播放期间听到持续人声就本地停播，这句话以打断并入。连续识别在服务定稿最后一段后才收尾，长句尾巴不再丢。插话或打断（文字或语音）到达的那一刻，之前的过程截断在插话消息上方，她接下来的过程从插话消息下面重新开出。
- Streaming and verdicts for hearing: the ear streams PCM as it captures (a 1.5 s pause ends an utterance, segments up to 120 s), the runtime transcribes it with the official Speech SDK in continuous mode (long or paused speech is no longer cut off) and the interim text shows live at the bottom of the chat; if the agent decides the sentence was not addressed to it, the line is hidden automatically (marked `ignored` in the record), otherwise it stays. The chat page shows a listening status line above the input (listening / someone is speaking / making it out / she is speaking); you can barge in while the agent speaks: with the ear on, her synthesized speech is played by the app through the voice-call audio path and capture uses the voice-communication source plus the system acoustic echo canceller (what is heard = microphone minus speaker), so her own voice is never taken for someone talking; sustained speech during playback stops it locally and interrupts the agent. Continuous recognition now waits for the last phrase to be finalized, so the tail of a long sentence is no longer lost. When a text or voice message arrives mid-turn, the process so far is cut off above that message and the agent's continuing work starts fresh below it.
- **Hearing**: the console app becomes the body's ear: a native foreground service keeps the microphone open, applies the system's noise suppression and segments speech with WebRTC VAD, posting each utterance to the runtime's `/hear`; the runtime transcribes it with Azure speech recognition (same key as synthesis), joins the most recent session within a 10-minute window or opens a new one, and hands it to the agent as a third message type, "ambient", for the agent to decide whether it was addressed and whether to answer (silence is not recorded). The agent is reminded that someone speaking aloud may want a spoken reply. Sound during the agent's own speech is dropped; listening respects the battery, temperature and emergency-stop limits. Adjustable in Control → Hearing and by the agent via `hearing_config`.

## 0.2.2

- 控制台：默认主题色改为官网设计系统的琥珀 `#F0A35E`（原蓝紫 `#7C6CF2`）；暗色背景固定为中性灰 `#202020`，不再随主题色偏色；暗色主色直接用 agent 的主题色；呼吸光团改为主题色的高饱和发光体。运行基座与灵魂桥生成的初始身份同步改用该默认色。
- Console: the default theme color is now the website design system's amber `#F0A35E` (was blue-violet `#7C6CF2`); the dark background is a fixed neutral gray `#202020` that no longer shifts with the theme color; the dark primary color is the agent's theme color itself; the breathing orb is now a saturated, glowing rendering of that color. The runtime and the soul bridge generate seed identities with the same default.
- 品牌标志统一为琥珀光团：App 启动图标（含 Android 8+ 自适应图标，由 `console/tool/gen-launcher-icon.py` 生成）、官网字标与 favicon 都换成与控制台首页同一颗球。
- The brand mark is now the amber orb everywhere: the app launcher icon (including the Android 8+ adaptive icon, generated by `console/tool/gen-launcher-icon.py`), the website wordmark and the favicon all use the same orb as the console home page.
- App 改用正式签名（Release 工作流从仓库 Secrets 读取密钥库）。从 debug 签名的 0.2.1 升级需先卸载再安装；Termux 里的运行基座与数据不受影响。
- The app is now signed with a release key (the release workflow reads the keystore from repository secrets). Upgrading from the debug-signed 0.2.1 requires uninstalling first; the runtime and data inside Termux are unaffected.

## 0.2.1

**首个公开发布版。** Quetzal 是一个让 agent 像生命一样活着的通用运行基座：非定时的自主醒来、双过程生物钟、身体数字孪生、多身体共享灵魂。

- **装在旧手机上**：Quetzal App 内置运行基座与 Termux 身体适配器，安装向导把它装进 Termux 并注册开机自启；升级 App 即升级基座，失败自动回退。
- **Termux 身体适配器**：电量、光线、加速度等传感器按名字探测；通知、TTS、相机、麦克风、定位、剪贴板经 Termux:API。
- **任意模型供应商**：OpenAI 兼容 / OpenAI Responses / Anthropic / Google Gemini；多 Key、全局顺序与故障转移，Key 本地加密。
- **可控**：能力授权、审批、预算、急停、审计；控制台 App 与飞书交互卡片两种操作方式。
- **保密传递** `pass_secret`：密码与令牌不进入对话与模型上下文。
- **灵魂仓库规范 v4**：私有仓库里 agent 写什么就提交什么，顶层允许它自己放的目录。
- 缩图在没有 ffmpeg / imagemagick 时用内置 jpeg-js 兜底。

**First public release.** Quetzal is a general-purpose runtime that lets an agent live like a living being: non-scheduled autonomous waking, a two-process body clock, a digital twin of the body, and a soul shared across bodies.

- **Runs on an old phone**: the Quetzal app bundles the runtime and the Termux body adapter; its setup wizard installs them into Termux and registers boot start. Upgrading the app upgrades the runtime, with automatic rollback on failure.
- **Termux body adapter**: battery, light and accelerometer sensors detected by name; notifications, TTS, camera, microphone, location and clipboard through Termux:API.
- **Any model provider**: OpenAI-compatible, OpenAI Responses, Anthropic and Google Gemini; multiple keys, global ordering and failover, keys encrypted locally.
- **Under control**: capability permissions, approvals, budgets, emergency stop and audit; operate from the app or from Feishu interactive cards.
- **Secret passing** via `pass_secret`: passwords and tokens never enter the conversation or the model context.
- **Soul repository spec v4**: whatever the agent writes into its private repository is committed; top-level directories of its own are allowed.
- Thumbnails fall back to the bundled jpeg-js when ffmpeg / imagemagick are absent.
