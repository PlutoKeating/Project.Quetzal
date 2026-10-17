// 身体适配器接口：运行基座核心与具体设备之间唯一的边界。
// 核心不知道自己跑在手机、树莓派还是服务器上；设备相关的采样、表达和动作全部由适配器提供。
// 适配器是一个独立构建的 ES 模块（默认导出 BodyAdapter），路径由配置 adapter 或环境变量 QUETZAL_ADAPTER 指定。
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

// ---------- 手（hands）：看屏幕、操作屏幕与其他应用（计算机使用）
// 坐标系：本接口里的坐标一律是「屏幕像素」，原点在 screenshot() 那张整屏截图的左上角，与截图的像素一一对应。
//   多显示器的偏移、DPI 缩放等与系统坐标的换算由适配器自己负责；核心再把它换算成她看到的（缩小后的）截图坐标。
// 元素：snapshot() 读无障碍树（安卓 AccessibilityService、Windows UI Automation、Linux AT-SPI、macOS AX……），列出屏幕上看得见的元素。
//   核心给元素编号、过滤、排版后交给她；她按编号操作时，核心把编号换成元素的中心点，连同元素的 ref 一起交给适配器。
// 出错一律抛出 Error（消息是给她看的一句话，说清楚为什么、怎么才能做）；核心把这次调用标为失败。

/** 屏幕上的一点。ref：snapshot() 给这个元素的不透明引用；适配器能直接对元素做动作（无障碍的点击、设值）时优先用它，失效了就按坐标做。 */
export interface ScreenPoint { x: number; y: number; ref?: string }

/** 无障碍树里的一个元素。x、y、w、h 是包围盒（屏幕像素）。 */
export interface ScreenElement {
  /** 通用角色名（适配器负责从平台的角色映射过来，映射不了的原样给）：
   *  button、link、text、input、checkbox、radio、switch、combobox、slider、tab、menu、menuitem、list、item、image、toolbar、dialog、window、group、scroll、other */
  role: string;
  name?: string;      // 可见文字或无障碍名称
  value?: string;     // 输入框里的文字、滑块的值等（不要放密码框的内容）
  x: number; y: number; w: number; h: number;
  ref?: string;       // 适配器自己的引用（例如树路径、RuntimeId），原样回到 ScreenPoint.ref
  clickable?: boolean; editable?: boolean; scrollable?: boolean;
  enabled?: boolean; focused?: boolean; selected?: boolean; checked?: boolean;
}

/** 一次读屏的结果。width、height 是屏幕（截图）的像素尺寸。 */
export interface ScreenSnapshot {
  width: number; height: number;
  app?: string;       // 前台应用（包名、进程名或应用名）
  window?: string;    // 前台窗口标题
  elements: ScreenElement[]; // 按树的先后顺序（大致是阅读顺序）；核心负责过滤与截断，适配器可以多给
  note?: string;      // 给她看的说明：例如「这个应用没有暴露无障碍信息，请截图看」
}

/** 一个顶层窗口。id 由适配器定义，原样交回 focusWindow。 */
export interface ScreenWindow { id: string; title: string; app?: string; focused?: boolean; x?: number; y?: number; w?: number; h?: number }

/** 手现在能不能用。ready 为假时 reason 说清楚怎么才能用（开启无障碍服务、登录桌面、安装 xdotool……）。 */
export interface HandsStatus {
  ready: boolean;
  reason?: string;
  screenshot: boolean; // 能截图
  tree: boolean;       // 能读无障碍树
  input: boolean;      // 能点击与输入
  detail?: string;     // 给人看的一句话：用的是什么（如「X11：xdotool + AT-SPI」）
}

/** click 的选项：button 缺省 left；count 2 为双击；holdMs 按住多久（长按）。安卓上 right 等同长按。 */
export interface ClickOptions { button?: "left" | "right" | "middle"; count?: number; holdMs?: number }

/**
 * 操作屏幕与其他应用。没有屏幕的身体不提供此字段（可以是 getter：探测到桌面时才返回）。
 * 键名（key 的参数，核心已规范为小写）：修饰键 ctrl、alt、shift、meta（Win / Super / Command）；
 *   enter、esc、tab、space、backspace、delete、insert、home、end、pageup、pagedown、up、down、left、right、f1–f24、单个字符（a、1、/ ……）；
 *   手机的全局动作：back、home、recents、notifications、quick_settings、lock、power。不支持的键抛错。
 */
export interface Hands {
  status(): Promise<HandsStatus>;
  /** 截整个屏幕（多显示器时为全部显示器拼成的一张），返回图片路径与屏幕尺寸。maxEdge：希望长边不超过多少像素（适配器能缩就缩，不能缩由核心缩），width / height 始终是缩之前的屏幕像素。 */
  screenshot(maxEdge?: number): Promise<{ file: string; width: number; height: number }>;
  /** 读前台窗口（手机上是当前界面）的无障碍树。 */
  snapshot(): Promise<ScreenSnapshot>;
  click(at: ScreenPoint, opts?: ClickOptions): Promise<void>;
  /** 拖拽 / 滑动：从 from 按住移到 to 再松开，用时 durationMs（缺省约 300 毫秒）。 */
  drag(from: ScreenPoint, to: ScreenPoint, durationMs?: number): Promise<void>;
  /** 滚动 amount 格（鼠标滚轮的格数；手机上一格约为屏幕的六分之一）。at 缺省为屏幕中央或当前焦点。direction 是内容移动的反方向，与滚轮一致：down 看下面的内容。 */
  scroll(direction: "up" | "down" | "left" | "right", amount: number, at?: ScreenPoint): Promise<void>;
  /** 输入文字（任意 Unicode）。at 给出时先点它（或直接对那个输入框设值），否则输入到当前焦点。 */
  type(text: string, at?: ScreenPoint): Promise<void>;
  /** 按键或组合键，keys 如 ["ctrl", "shift", "t"]、["enter"]、["back"]：修饰键在前，最后一个是主键。 */
  key(keys: string[]): Promise<void>;
  /** 打开一个已安装的应用：id 是包名 / 应用 ID / .desktop 名，或应用的显示名。只打开已安装的应用，不执行任意命令。返回给她看的一句话。 */
  openApp(id: string): Promise<string>;
  /** 列出顶层窗口（可选）。 */
  windows?(): Promise<ScreenWindow[]>;
  /** 切换到某个窗口（可选，id 来自 windows()）。 */
  focusWindow?(id: string): Promise<void>;
}

/** 守护：开机自启 + 退出后自动重启。由这具身体所在平台的进程守护者（systemd、runit、守护循环……）提供，一个开关管两件事。 */
export interface SupervisionState {
  available: boolean;                       // 这具身体有没有可控制的守护者（手动运行、自定义部署时为 false，控制台不显示开关）
  enabled: boolean;                         // 开机自启且退出后自动重启
  kind: "systemd" | "runit" | "loop" | "task" | "launchd" | "none"; // task：Windows 的计划任务；launchd：macOS 的用户代理
  detail: string;                           // 给人看的一句话：守护者是谁、怎么拉起
}
export interface Supervision {
  status(): Promise<SupervisionState>;
  set(enabled: boolean): Promise<void>;     // 关：退出后不再拉起、开机不再自启（正在运行的进程不受影响）；开：恢复两者
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
  hands?: Hands;              // 操作屏幕（核心据此提供 screen_* 工具，归「操作屏幕与应用」类别）；没有屏幕的身体不提供
  supervision?: Supervision;  // 守护开关（控制台「高级 · 运行」页）；没有的身体不显示
  /**
   * 设备自身稳定的标识（Linux 的 machine-id、Windows 的 MachineGuid、安卓的 ANDROID_ID……），取不到返回 undefined。
   * 核心只用它的哈希派生这具身体的 uuid（body/uuid.ts），原始值不进日志、审计、灵魂仓库与网状层。没有的适配器不提供。
   */
  deviceId?(): Promise<string | undefined>;
  /**
   * 网络变化通知：平台知道默认网络换了（Wi-Fi ↔ 移动数据、断网又连上）时立即调用 cb（detail 是给人看的一句话）。返回停止监听的函数。
   * 网状层据此立即检查信令连接与各条直连；核心另有每 5 秒的轮询兜底，没有的适配器不提供。
   */
  onNetworkChange?(cb: (detail: string) => void): () => void;
  /** 退出（桌面托盘的「退出」）：这一次停掉后台服务，开机自启照旧。没有的身体由 ops 直接结束进程 */
  quit?(): Promise<void>;
  /** 让这具身体在后台重跑安装（升级运行基座与控制台到最新发布）：立即返回一句说明，进程随后由守护者重启。没有的身体（安卓由 App 升级）不提供 */
  upgrade?(version?: string): Promise<string>;
  /** 最近一次升级的状态（进行中 / 退出码 / 最后一步）：控制台据此显示结果或失败原因，不再只等版本号变化 */
  upgradeStatus?(): { running: boolean; id?: string; startedAt?: number; target?: string; exitCode?: number; step?: string; stalled?: boolean };
}

/** 通用适配器：只用操作系统信息，没有传感器。适用于任何能跑 Node 的机器。 */
export const genericAdapter: BodyAdapter = {
  name: "generic",
  describe: "一台没有传感器的通用计算机",
  sample: async () => ({}),
};
