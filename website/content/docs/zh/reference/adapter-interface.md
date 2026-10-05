---
title: 适配器接口
description: BodyAdapter、RawSample、AdapterTool、Hands 的完整类型，加载方式与约束，以及安卓、Termux、Linux 适配器的能力清单。
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

/** 预留：操控屏幕与其他应用。 */
interface Hands {
  screenshot(): Promise<string>;         // 返回图片路径
  describeScreen(): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  type(text: string): Promise<void>;
  openApp(id: string): Promise<void>;
}

interface BodyAdapter {
  name: string;
  describe: string;                      // 一句话描述这具身体，写进 agent 的自我认知
  init?(): Promise<void>;
  sample(): Promise<RawSample>;
  notify?(title: string, text: string): Promise<void>;   // 本地系统通知
  speak?(text: string): Promise<void>;
  playAudio?(file: string): Promise<void>;               // 播放音频文件（语音合成的结果）
  tools?: AdapterTool[];
  hands?: Hands;
  supervision?: { status(): Promise<SupervisionState>; set(enabled: boolean): Promise<void> };
  upgrade?(): Promise<string>;  // 从控制台升级：后台重跑安装  // 守护开关：开机自启 + 退出后自动重启
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

## 采样如何使用

- `startSenses` 周期调用 `sample()`，间隔自适应 2–10 分钟，不调用模型。
- 读数与操作系统信息一起进入身体孪生，派生身体感受，与上次比较产生 sense 事件，影响驱动力并触发重新抽样。
- `extra` 原样进入 ta 看到的「身体」段落。

## 安卓适配器（`runtime/adapters/android/`，构建为 `dist/android.mjs`）

Quetzal App 内置运行基座时用它：身体能力由 App 自己的原生代码提供，经本机的**身体接口**交给运行基座（127.0.0.1 的随机端口，只认令牌；端口与令牌在 `QUETZAL_HOME/secrets/body.json`，agent 的命令在沙箱里看不到）。

| 能力 | 实现（App 侧） |
|---|---|
| `sample()` | 电池广播（电量 / 充电 / 体温 / 健康 / 充电方式）、光线与加速度传感器（各读一次，没有就不报）、是否亮屏 |
| `notify()` | 系统通知，点开进入 App |
| `playAudio()` / `stopAudio()` | 系统媒体播放器 |
| 工具 | `take_photo`（Camera2 无预览拍照）、`record_audio`（系统录音）、`location`（网络定位；给了精确定位时加 GPS；都定不到时返回最近一次已知位置并说明是多久以前的）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device） |
| 守护 | App 前台服务的开关：开机与 App 升级后自启、退出后重启（`kind: loop`） |
| 文件路径 | 拍照、录音的输出与播放的输入都只能在 `QUETZAL_HOME` 之内 |

相机、麦克风、定位需要用户在 App 里授予系统权限（安装向导第二步）；没授权时工具报错，ta 会请你去允许。它同样是**平台级**适配器：任意安卓手机，一切靠探测。

## Termux 适配器（`runtime/adapters/termux/`，构建为 `dist/termux.mjs`）

1.0.x 按 Termux 方式安装时使用，保留以兼容旧安装；新安装用上面的安卓适配器。

| 能力 | 实现 |
|---|---|
| `sample()` | `termux-battery-status`（电量 / 充电 / 体温 / 健康）、`termux-sensor`（光照与运动，传感器按名字探测，没有就不报） |
| `notify()` | 系统通知，带「打开 Quetzal」按钮（`QUETZAL_CONSOLE_ACTIVITY`，默认 `xyz.quetzal.console/.MainActivity`） |
| `playAudio()` | `termux-media-player` |
| 工具 | `take_photo`（camera）、`record_audio`（microphone）、`location`（location）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device） |
| `speak` | 不提供（很多手机没有系统 TTS）；说话由运行基座的 `voice_speak` 完成 |
| 媒体位置 | `QUETZAL_HOME/data/media/` |

它是**平台级**适配器：任意安卓手机 + Termux:API，一切靠探测，不含任何具体机型的实现。

## Linux 适配器（`runtime/adapters/linux/`，构建为 `dist/linux.mjs`）

随 npm 包 `@plutokeating/quetzal` 安装（`npx @plutokeating/quetzal`），同样是平台级：任意 Linux 电脑或服务器，一切靠探测。

| 能力 | 实现 |
|---|---|
| `sample()` | `/sys/class/power_supply`：电量 / 充电 / 健康（跳过蓝牙鼠标等外设电池；「Not charging」且外接电源在线算充电），电池自身温度（`temp`，笔记本少有）；`extra`：CPU 温度（`/sys/class/thermal`，不当作体温）、电源来源。台式机与服务器没有电池就只有 extra |
| `describe` | 发行版（`/etc/os-release`）、是否笔记本、有没有桌面、摄像头（`/dev/video0`）与声卡（`/proc/asound/cards`） |
| `notify()` | 有桌面时 `notify-send`；同时写到标准输出（服务日志），没有桌面的机器从 `quetzal logs` 看配对码 |
| `playAudio()` / `stopAudio()` | `pw-play` / `paplay` / `ffplay` / `mpv`，WAV 还可 `aplay`；后台播放，立即返回 |
| 工具 | `take_photo`（camera：`ffmpeg` 读 `/dev/video0`）、`record_audio`（microphone：`arecord` / `pw-record` / `parecord` / `ffmpeg`，WAV）、`screenshot`（hands：Wayland 下 `grim` / `gnome-screenshot` / `spectacle`，X11 下 `scrot` / `gnome-screenshot` / `spectacle` / `import`）、`clipboard`（device：`wl-clipboard` / `xclip` / `xsel`）、`open`（device：`xdg-open`） |
| 从控制台升级 `upgrade()` | 后台重跑 `curl -fsSL …/install \| bash -s -- --no-open`：有 systemd 用 `systemd-run --user` 起临时单元（脱离 quetzal 服务的 cgroup，否则重启服务时会把自己杀掉），没有用 `setsid`；日志 `~/.quetzal/logs/upgrade.log` |
| 守护开关 `supervision` | systemd 用户服务 `quetzal.service`（关 = `systemctl --user disable` + 覆盖片段 `quetzal.service.d/quetzal-off.conf` 写 `Restart=no`，daemon-reload 后立即生效）；没有 systemd 时是一键安装脚本的守护循环 `~/.quetzal/bin/quetzal-supervise`（关 = 标志文件 `state/supervise.off` 让循环暂停拉起 + 删 crontab `@reboot` 与桌面自启动项）；两者都没有（手动部署）则 `available=false` |
| `speak` | 不提供；说话由运行基座的 `voice_speak` 完成 |
| 媒体位置 | `QUETZAL_HOME/data/media/` |

没有图形界面的服务器上，截图、剪贴板、打开网址这些工具会直接说明「这台电脑没有图形界面」，不报错。写一个新适配器见 [自定义身体适配器](/docs/advanced/custom-adapter)。
