// 身体适配器接口：运行基座核心与具体设备之间唯一的边界。
// 核心不知道自己跑在手机、树莓派还是服务器上；设备相关的采样、表达和动作全部由适配器提供。
// 适配器是一个独立构建的 ES 模块（默认导出 BodyAdapter），路径由配置 adapter 或环境变量 WINDLER_ADAPTER 指定。
// 适配器只能依赖本文件中的类型（构建时被擦除），不得 import 核心的其他实现。

/** 一次物理采样。字段全部可选：设备有什么就报什么。 */
export interface RawSample {
  battery?: { level: number; charging: boolean; tempC?: number; health?: string };
  lux?: number; // 环境光照
  motion?: number; // 加速度偏离重力的幅度（m/s²）
  screenOn?: boolean;
  extra?: Record<string, string | number | boolean>; // 设备特有的其他读数，原样进入孪生模型
}

/** 适配器提供给 agent 的工具（动作）。handler 返回给模型看的文本结果。 */
export interface AdapterTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  permission: string; // 对应闸门的能力类别，如 device、camera、microphone、location
  handler: (args: Record<string, any>) => Promise<string>;
}

/** 预留：操控屏幕与其他应用（看屏幕、点击、输入）。尚未实现的适配器不提供此字段。 */
export interface Hands {
  screenshot(): Promise<string>; // 返回图片路径
  describeScreen(): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  type(text: string): Promise<void>;
  openApp(id: string): Promise<void>;
}

export interface BodyAdapter {
  name: string;
  describe: string; // 一句话描述这具身体，写进 agent 的自我认知
  init?(): Promise<void>;
  sample(): Promise<RawSample>;
  /** 系统通知：agent 主动说话的本地出口；actions 为可选按钮（id → 文案） */
  notify?(title: string, text: string): Promise<void>;
  speak?(text: string): Promise<void>;
  playAudio?(file: string): Promise<void>;  // 播放一个音频文件（如语音合成的结果）
  stopAudio?(): Promise<void>; // 停止播放（对方插嘴时让她闭嘴）
  tools?: AdapterTool[];
  hands?: Hands;
}

/** 通用适配器：只用操作系统信息，没有传感器。适用于任何能跑 Node 的机器。 */
export const genericAdapter: BodyAdapter = {
  name: "generic",
  describe: "一台没有传感器的通用计算机",
  sample: async () => ({}),
};
