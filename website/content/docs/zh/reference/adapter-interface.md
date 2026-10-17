---
title: 适配器接口
description: BodyAdapter、RawSample、AdapterTool、Hands 的完整类型，加载方式与约束，以及安卓、Termux、Linux、Windows 适配器的能力清单。
---

## 类型

定义在 `runtime/src/body/adapter.ts`。适配器是一个独立构建的 ES 模块，**默认导出**一个 `BodyAdapter`。

```ts
/** 一次物理采样。字段全部可选：设备有什么就报什么。 */
interface RawSample {
  battery?: { level: number; charging: boolean; tempC?: number; health?: string };
  lux?: number;      // 环境光照
  motion?: number;   // 加速度偏离重力的幅度（m/s²）
  screenOn?: boolean;
  extra?: Record<string, string | number | boolean>;  // 设备特有读数，原样进入孪生
}

/** 适配器提供给 agent 的工具（动作）。handler 返回给模型看的文本。 */
interface AdapterTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  permission: string;                    // 闸门的能力类别：device、camera、microphone、location…
  handler: (args: Record<string, any>) => Promise<string>;
}

/** 屏幕上的一点。坐标一律是整屏截图的像素（原点在截图左上角），多显示器偏移与 DPI 由适配器换算。 */
interface ScreenPoint { x: number; y: number; ref?: string }   // ref：snapshot() 给这个元素的引用，按编号操作时原样交回

/** 无障碍树里的一个元素（包围盒为屏幕像素）。 */
interface ScreenElement {
  role: string;   // button、link、text、input、checkbox、radio、switch、combobox、slider、tab、menu、menuitem、list、item、image、toolbar、dialog、window、group、scroll、other
  name?: string; value?: string;                       // 可见文字 / 输入框里的文字（密码框不给）
  x: number; y: number; w: number; h: number; ref?: string;
  clickable?: boolean; editable?: boolean; scrollable?: boolean;
  enabled?: boolean; focused?: boolean; selected?: boolean; checked?: boolean;
}
interface ScreenSnapshot { width: number; height: number; app?: string; window?: string; elements: ScreenElement[]; note?: string }

/** 手：看屏幕、操作屏幕与其他应用。没有屏幕的身体不提供。出错时抛错，消息说清楚怎么才能做。 */
interface Hands {
  status(): Promise<{ ready: boolean; reason?: string; screenshot: boolean; tree: boolean; input: boolean; detail?: string }>;
  screenshot(maxEdge?: number): Promise<{ file: string; width: number; height: number }>;  // width / height 为屏幕像素
  snapshot(): Promise<ScreenSnapshot>;                                                       // 前台窗口的无障碍树
  click(at: ScreenPoint, opts?: { button?: "left" | "right" | "middle"; count?: number; holdMs?: number }): Promise<void>;
  drag(from: ScreenPoint, to: ScreenPoint, durationMs?: number): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", amount: number, at?: ScreenPoint): Promise<void>;
  type(text: string, at?: ScreenPoint): Promise<void>;
  key(keys: string[]): Promise<void>;          // ["ctrl", "c"]、["enter"]、["back"]：修饰键在前
  openApp(id: string): Promise<string>;        // 只打开已安装的应用
  windows?(): Promise<{ id: string; title: string; app?: string; focused?: boolean }[]>;
  focusWindow?(id: string): Promise<void>;
}

interface BodyAdapter {
  name: string;
  describe: string;                      // 一句话描述这具身体，写进 agent 的自我认知
  init?(): Promise<void>;
  sample(): Promise<RawSample>;
  notify?(title: string, text: string): Promise<void>;   // 本地系统通知
  speak?(text: string): Promise<void>;
  playAudio?(file: string): Promise<void>;               // 播放音频文件（语音合成的结果）
  stopAudio?(): Promise<void>;                           // 停止播放（对方插嘴时）
  tools?: AdapterTool[];
  hands?: Hands;
  supervision?: { status(): Promise<SupervisionState>; set(enabled: boolean): Promise<void> };  // 守护开关：开机自启 + 退出后自动重启
  quit?(): Promise<void>;                                // 退出（桌面托盘的「退出」）：这一次停掉后台服务
  upgrade?(version?: string): Promise<string>;           // 从控制台升级：后台重跑安装
  upgradeStatus?(): { running: boolean; exitCode?: number; step?: string /* … */ };  // 最近一次升级的状态
  deviceId?(): Promise<string | undefined>;              // 设备自身稳定的标识：核心只用它的哈希派生身体 uuid，原始值不外露
  onNetworkChange?(cb: (detail: string) => void): () => void; // 平台知道默认网络换了时立即通知，网状层据此马上检查连接（另有每 5 秒的轮询兜底）
}
```

## 加载

| 来源 | 说明 |
|---|---|
| 环境变量 `QUETZAL_ADAPTER` | 模块路径（安卓 App 与 Termux 部署用这个） |
| 配置 `adapter` | `config/quetzal.json` 里的路径 |
| 都没有 / 加载失败 | 回退到通用适配器 `generic`（无传感器，`sample()` 返回空对象） |

## 约束

- 适配器**只能 `import type`** 接口文件的类型，不得依赖核心的其他实现。
- `tools[].permission` 必须是闸门已知的能力类别，否则按「允许」处理。
- `notify` 是配对码与主动消息的本地出口；没有它，配对码只能从 `secrets/gateway.token` 读。
- `hands` 的操作由运行基座进程直接执行，不经过 agent 的命令沙箱：`openApp` 只打开已安装的应用，不能成为运行任意程序的出口。核心据 `hands` 提供 `screen_read`、`screen_capture`、`screen_click`、`screen_drag`、`screen_scroll`、`screen_type`、`screen_key`、`app_open`（有 `windows` / `focusWindow` 时再加 `window_list` / `window_focus`），全部归「操作屏幕与应用」，见 [操作屏幕](/docs/guide/screen)。
- `deviceId()` 返回的是敏感信息：适配器自己也不得写进日志或工具结果；取不到就返回 `undefined`（运行基座先用随机 uuid，之后再试，取到就换成设备派生的值）。见[多具身体 · 身体的 uuid](/docs/guide/multi-body)。

## 采样如何使用

- `startSenses` 周期调用 `sample()`，间隔自适应 2–10 分钟，不调用模型。
- 读数与操作系统信息一起进入身体孪生，派生身体感受，与上次比较产生 sense 事件，影响驱动力并触发重新抽样。
- `extra` 原样进入 ta 看到的「身体」段落。

## 安卓适配器（`runtime/adapters/android/`，构建为 `dist/android.mjs`）

Quetzal App 内置运行基座时用它。身体能力由 App 自己的原生代码提供，经本机的**身体接口**交给运行基座：接口在 127.0.0.1 的随机端口上，只认令牌；端口与令牌在 `QUETZAL_HOME/secrets/body.json`，agent 的命令在沙箱里看不到它。

| 能力 | 实现（App 侧） |
|---|---|
| `sample()` | 电池广播（电量 / 充电 / 体温 / 健康 / 充电方式）、光线与加速度传感器（各读一次，没有就不报）、是否亮屏 |
| `notify()` | 系统通知，点开进入 App |
| `playAudio()` / `stopAudio()` | 系统媒体播放器 |
| 工具 | `take_photo`（Camera2 无预览拍照）、`record_audio`（系统录音）、`location`（网络定位；给了精确定位时加 GPS；都定不到时返回最近一次已知位置并说明是多久以前的）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device） |
| 守护 | App 前台服务的开关：开机与 App 升级后自启、退出后重启（`kind: loop`） |
| 文件路径 | 拍照、录音的输出与播放的输入都只能在 `QUETZAL_HOME` 之内 |
| 设备标识 `deviceId()` | `Settings.Secure.ANDROID_ID`（身体接口 `GET /v1/device-id`）；恢复出厂设置、App 换签名会变 |
| 网络变化 `onNetworkChange()` | App 注册系统的默认网络回调，Wi-Fi 与移动数据之间切换、断网又连上时立即通知（身体接口 `POST /v1/network`，长轮询） |
| 手 `hands` | App 的无障碍服务 `HandsService`（用户在系统设置里开启「Quetzal 操作屏幕」）：节点树读屏、节点动作与手势（点击、长按、滑动）、在光标处输入、全局动作（返回、主页、最近任务、通知栏、锁屏）、按名字或包名打开应用、截图（Android 11+）；身体接口 `/v1/hands/…`。没开时各操作如实说明怎么开 |

相机、麦克风、定位需要用户在 App 里授予系统权限（安装向导第二步）；没授权时工具报错，ta 会请你去允许。它也是**平台级**适配器：适用于任意安卓手机，能力全部靠探测。

## Termux 适配器（`runtime/adapters/termux/`，构建为 `dist/termux.mjs`）

1.0.x 按 Termux 方式安装的身体使用它，为兼容这些旧安装而保留；新安装用上面的安卓适配器。

| 能力 | 实现 |
|---|---|
| `sample()` | `termux-battery-status`（电量 / 充电 / 体温 / 健康）、`termux-sensor`（光照与运动，传感器按名字探测，没有就不报） |
| `notify()` | 系统通知，带「打开 Quetzal」按钮（`QUETZAL_CONSOLE_ACTIVITY`，默认 `xyz.quetzal.console/.MainActivity`） |
| `playAudio()` | `termux-media-player` |
| 工具 | `take_photo`（camera）、`record_audio`（microphone）、`location`（location）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device） |
| `speak` | 不提供（很多手机没有系统 TTS）；说话由运行基座的 `voice_speak` 完成 |
| 媒体位置 | `QUETZAL_HOME/data/media/` |
| 设备标识 `deviceId()` | 尽力 `settings get secure android_id`，多数手机上 Termux 没有权限，取不到 |

它是**平台级**适配器：适用于任意安卓手机 + Termux:API，能力全部靠探测，不含任何具体机型的实现。

## Linux 适配器（`runtime/adapters/linux/`，构建为 `dist/linux.mjs`）

随 npm 包 `@plutokeating/quetzal` 安装（`npx @plutokeating/quetzal`）。它也是平台级适配器：适用于任意 Linux 电脑或服务器，能力全部靠探测。

| 能力 | 实现 |
|---|---|
| `sample()` | `/sys/class/power_supply`：电量 / 充电 / 健康（跳过蓝牙鼠标等外设电池；「Not charging」且外接电源在线算充电），电池自身温度（`temp`，笔记本少有）；`extra`：CPU 温度（`/sys/class/thermal`，不当作体温）、电源来源。台式机与服务器没有电池就只有 extra |
| `describe` | 发行版（`/etc/os-release`）、是否笔记本、有没有桌面、摄像头（`/dev/video0`）与声卡（`/proc/asound/cards`） |
| `notify()` | 有桌面时 `notify-send`；同时写到标准输出（服务日志），没有桌面的机器从 `quetzal logs` 看配对码 |
| `playAudio()` / `stopAudio()` | `pw-play` / `paplay` / `ffplay` / `mpv`，WAV 还可 `aplay`；后台播放，立即返回 |
| 工具 | `take_photo`（camera：`ffmpeg` 读 `/dev/video0`）、`record_audio`（microphone：`arecord` / `pw-record` / `parecord` / `ffmpeg`，WAV）、`clipboard`（device：`wl-clipboard` / `xclip` / `xsel`）、`open`（device：`xdg-open`） |
| 手 `hands` | 有桌面会话时才提供。读元素：AT-SPI（`python3` + gi 的 Atspi 2.0）；点击与输入：X11 用 `xdotool`，Wayland 用 `ydotool`（要 `ydotoold`）/ `wtype`（只按键与输入），都没有时对读到的元素退回 AT-SPI 的动作；截图：Wayland 下 `grim` / `gnome-screenshot` / `spectacle`，X11 下 `scrot` / `gnome-screenshot` / `spectacle` / `import`；窗口：X11 下 `wmctrl`；打开应用：只认 `.desktop`（`gtk-launch` / `gio launch` / `kioclient`）。服务里缺 `DISPLAY` 等环境变量时按 `XDG_RUNTIME_DIR` 与 `/tmp/.X11-unix` 补齐 |
| 从控制台升级 `upgrade()` | 后台重跑 `curl -fsSL …/install \| bash -s -- --no-open`：有 systemd 用 `systemd-run --user` 起临时单元（脱离 quetzal 服务的 cgroup，否则重启服务时会把自己杀掉），没有用 `setsid`；日志 `~/.quetzal/logs/upgrade.log` |
| 守护开关 `supervision` | systemd 用户服务 `quetzal.service`（关 = `systemctl --user disable` + 覆盖片段 `quetzal.service.d/quetzal-off.conf` 写 `Restart=no`，daemon-reload 后立即生效）；没有 systemd 时是一键安装脚本的守护循环 `~/.quetzal/bin/quetzal-supervise`（关 = 标志文件 `state/supervise.off` 让循环暂停拉起 + 删 crontab `@reboot` 与桌面自启动项）；两者都没有（手动部署）则 `available=false` |
| `speak` | 不提供；说话由运行基座的 `voice_speak` 完成 |
| 媒体位置 | `QUETZAL_HOME/data/media/` |
| 设备标识 `deviceId()` | `/etc/machine-id`，没有时 `/var/lib/dbus/machine-id`；重装系统会变 |

在没有图形界面的服务器上，剪贴板、打开网址这些工具直接回复「这台电脑没有图形界面」，不报错；也没有 `hands`，不出现操作屏幕的工具。

## Windows 适配器（`runtime/adapters/windows/`，构建为 `dist/windows.mjs`）

Windows 安装包与 `install.ps1` 装的就是它（见 [Windows](/docs/advanced/windows)）。它也是平台级适配器：适用于任意 Windows 10（1809 起）/ 11 电脑（x64、arm64），能力全部靠探测，只用系统自带的 PowerShell 5.1、.NET 与 WinRT，不另装程序。

开机任务里的运行基座在会话 0，看不到桌面。需要桌面的操作（通知、截图与操作屏幕、剪贴板、打开、播放、拍照、录音）交给用户桌面里的**身体助手** `windows-body.mjs`：控制台托盘在登录时启动它，它监听 127.0.0.1 的随机端口、只认随机令牌，端口与令牌在 `QUETZAL_HOME\secrets\desktop-body.json`。运行基座本身就在登录的桌面里时直接调用；两者都不行时，工具回复需要有人登录桌面。

| 能力 | 实现 |
|---|---|
| `sample()` | `SystemInformation.PowerStatus`（会话 0 里也能读）：笔记本报电量 / 充电；`extra`：电源来源，ACPI 热区可读时的温度（不当作体温）。台式机没有电池就只有 extra |
| `describe` | 系统版本（Win32_OperatingSystem）、是否笔记本、是否在登录的桌面里、摄像头与声卡（即插即用设备） |
| `notify()` | 桌面里弹 Toast 通知；没人登录时写到标准输出（服务日志） |
| `playAudio()` / `stopAudio()` | WPF 的 MediaPlayer，后台播放，立即返回 |
| 工具 | `take_photo`（camera：WinRT 的 MediaCapture，不行再试 `ffmpeg` 的 dshow）、`record_audio`（microphone：winmm 的 MCI，16 kHz 单声道 WAV，最多 120 秒）、`clipboard`（device）、`open`（device：只打开网址与普通文档、图片、音视频文件和文件夹，不打开程序与脚本） |
| 手 `hands` | 读元素：UI Automation（CacheRequest 取前台窗口的控件视图）；点击与输入：`SendInput` / `SetCursorPos`（每显示器 DPI 感知，任意 Unicode 文字）；截图：全部显示器，按需缩小存 JPEG；窗口：UI Automation 的顶层窗口，`SetForegroundWindow` 切换；打开应用：只认开始菜单里的（`Get-StartApps`）。以管理员身份运行的窗口、UAC、锁屏收不到模拟输入 |
| 从控制台升级 `upgrade()` | 后台重跑 `install.ps1`（下载签名核对过的安装包并静默安装）；有人登录时经身体助手启动；日志 `home\logs\upgrade.log`，格式与 Linux 相同 |
| 守护开关 `supervision` | 计划任务 `\Quetzal\Runtime-Boot` / `Runtime-Logon`（`kind: task`）；关 = 标志文件 `state\supervise.off` 让守护进程停止拉起，并尝试禁用这两个任务；没有安装器注册的任务时 `available=false` |
| `speak` | 不提供；说话由运行基座的 `voice_speak` 完成 |
| 媒体位置 | `QUETZAL_HOME\data\media\` |
| 设备标识 `deviceId()` | 注册表 `HKLM\SOFTWARE\Microsoft\Cryptography` 的 `MachineGuid`（`reg.exe query`）；重装 Windows 会变 |

写一个新适配器见 [自定义身体适配器](/docs/advanced/custom-adapter)。
