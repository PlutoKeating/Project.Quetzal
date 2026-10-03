---
title: 适配器接口
description: BodyAdapter、RawSample、AdapterTool、Hands 的完整类型，加载方式与约束，以及 Termux 适配器的能力清单。
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
}
```

## 加载

| 来源 | 说明 |
|---|---|
| 环境变量 `WINDLER_ADAPTER` | 模块路径（Termux 部署用这个） |
| 配置 `adapter` | `config/windler.json` 里的路径 |
| 都没有 / 加载失败 | 回退到通用适配器 `generic`（无传感器，`sample()` 返回空对象） |

## 约束

- 适配器**只能 `import type`** 接口文件的类型，不得依赖核心的其他实现。
- `tools[].permission` 必须是闸门已知的能力类别，否则按「允许」处理。
- `notify` 是配对码与主动消息的本地出口；没有它，配对码只能从 `secrets/gateway.token` 读。

## 采样如何使用

- `startSenses` 周期调用 `sample()`，间隔自适应 2–10 分钟，不调用模型。
- 读数与操作系统信息一起进入身体孪生，派生身体感受，与上次比较产生 sense 事件，影响驱动力并触发重新抽样。
- `extra` 原样进入 ta 看到的「身体」段落。

## Termux 适配器（`runtime/adapters/termux/`，构建为 `dist/termux.mjs`）

| 能力 | 实现 |
|---|---|
| `sample()` | `termux-battery-status`（电量 / 充电 / 体温 / 健康）、`termux-sensor`（光照与运动，传感器按名字探测，没有就不报） |
| `notify()` | 系统通知，带「打开 Windler」按钮（`WINDLER_CONSOLE_ACTIVITY`，默认 `xyz.windler.console/.MainActivity`） |
| `playAudio()` | `termux-media-player` |
| 工具 | `take_photo`（camera）、`record_audio`（microphone）、`location`（location）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device） |
| `speak` | 不提供（很多手机没有系统 TTS）；说话由运行基座的 `voice_speak` 完成 |
| 媒体位置 | `WINDLER_HOME/data/media/` |

它是**平台级**适配器：任意安卓手机 + Termux:API，一切靠探测，不含任何具体机型的实现。写一个新适配器见 [自定义身体适配器](/docs/advanced/custom-adapter)。
