# 更新日志

每个版本一节，标题为 `## <版本>`。发版工作流（`.github/workflows/release.yml`）会把对应小节作为 GitHub Release 的说明，官网下载页从 Release 读取。中英文都写：中文在前，英文在后。

## 0.3.0

- **自造工具**：她可以用 `tool_write` 把做熟了的流程写成工具（shell 脚本或 Node 模块），热加载进工具表、经闸门按声明的能力类别检查；实现只在这具身体上（`WINDLER_HOME/tools/`），意图文档以 [Agent Skills](https://agentskills.io/specification) 规范的 `SKILL.md` 进灵魂仓库 `skills/`（规范升到 v5），其他身体（含 Hermes / OpenClaw）可以按文档自己实现。控制台「控制 → 工具」查看、停用、删除。做梦时会回顾重复的流程。
- **Self-made tools**: the agent can turn a routine it has done many times into a tool with `tool_write` (a shell script or a Node module), hot-loaded into the tool table and gated by its declared capability; the implementation stays on this body (`WINDLER_HOME/tools/`) while the intent is written as an [Agent Skills](https://agentskills.io/specification) `SKILL.md` into the soul repository's `skills/` (spec bumped to v5), so other bodies (including Hermes / OpenClaw) can implement it from the document. The console's Control → Tools page lists, disables and deletes them. Dreams now review repeated routines.
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

**首个公开发布版。** Windler 是一个让 agent 像生命一样活着的通用运行基座：非定时的自主醒来、双过程生物钟、身体数字孪生、多身体共享灵魂。

- **装在旧手机上**：Windler App 内置运行基座与 Termux 身体适配器，安装向导把它装进 Termux 并注册开机自启；升级 App 即升级基座，失败自动回退。
- **Termux 身体适配器**：电量、光线、加速度等传感器按名字探测；通知、TTS、相机、麦克风、定位、剪贴板经 Termux:API。
- **任意模型供应商**：OpenAI 兼容 / OpenAI Responses / Anthropic / Google Gemini；多 Key、全局顺序与故障转移，Key 本地加密。
- **可控**：能力授权、审批、预算、急停、审计；控制台 App 与飞书交互卡片两种操作方式。
- **保密传递** `pass_secret`：密码与令牌不进入对话与模型上下文。
- **灵魂仓库规范 v4**：私有仓库里 agent 写什么就提交什么，顶层允许它自己放的目录。
- 缩图在没有 ffmpeg / imagemagick 时用内置 jpeg-js 兜底。

**First public release.** Windler is a general-purpose runtime that lets an agent live like a living being: non-scheduled autonomous waking, a two-process body clock, a digital twin of the body, and a soul shared across bodies.

- **Runs on an old phone**: the Windler app bundles the runtime and the Termux body adapter; its setup wizard installs them into Termux and registers boot start. Upgrading the app upgrades the runtime, with automatic rollback on failure.
- **Termux body adapter**: battery, light and accelerometer sensors detected by name; notifications, TTS, camera, microphone, location and clipboard through Termux:API.
- **Any model provider**: OpenAI-compatible, OpenAI Responses, Anthropic and Google Gemini; multiple keys, global ordering and failover, keys encrypted locally.
- **Under control**: capability permissions, approvals, budgets, emergency stop and audit; operate from the app or from Feishu interactive cards.
- **Secret passing** via `pass_secret`: passwords and tokens never enter the conversation or the model context.
- **Soul repository spec v4**: whatever the agent writes into its private repository is committed; top-level directories of its own are allowed.
- Thumbnails fall back to the bundled jpeg-js when ffmpeg / imagemagick are absent.
