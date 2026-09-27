// 心脏的纯数学部分（无副作用，便于测试）：驱动力动力学、双过程生物钟、醒来风险函数。
//
// 生物钟采用睡眠研究中的"双过程模型"（Borbély）：
//   S 睡眠压力：醒着时向 1 缓慢上升（做事越多升得越快），睡着时指数回落；
//   C 昼夜节律：由本地时刻决定的余弦波，下午最清醒、凌晨最困，光照会轻微调制它。
// 困意 = S − C。困意越过上阈值就入睡，睡眠中降到下阈值以下就自然醒——没有任何"几点睡、几点起"的设定。

export interface Personality {
  tau: { curiosity: number; expression: number; social: number }; // 驱动力趋于饱和的时间常数（小时）
  weight: { curiosity: number; expression: number; social: number; openLoops: number };
  gamma: number; // 驱动力到醒来率的非线性指数
  sleepRiseH: number; // 醒着时 S 上升的时间常数
  sleepFallH: number; // 睡着时 S 回落的时间常数
  circadianPeakHour: number; // 最清醒的时刻
  sleepAt: number; // 困意入睡阈值
  wakeAt: number; // 困意自然醒阈值
}

export const defaultPersonality: Personality = {
  tau: { curiosity: 3, expression: 6, social: 10 },
  weight: { curiosity: 1, expression: 0.8, social: 0.7, openLoops: 0.6 },
  gamma: 2,
  sleepRiseH: 16,
  sleepFallH: 4,
  circadianPeakHour: 16,
  sleepAt: 0.35,
  wakeAt: -0.15,
};

export interface Drives { curiosity: number; expression: number; social: number; openLoops: number }
export interface HeartState {
  mode: "awake" | "asleep";
  S: number;
  drives: Drives;
  updatedAt: number;
  unconsolidated: number; // 上次做梦以来积累的经历条数
}

export const initialState = (now: number): HeartState => ({
  mode: "awake", S: 0.2, updatedAt: now, unconsolidated: 0,
  drives: { curiosity: 0.5, expression: 0.3, social: 0.3, openLoops: 0 },
});

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const approach = (x: number, dtH: number, tau: number) => 1 - (1 - x) * Math.exp(-dtH / tau);

/** 昼夜节律 C ∈ [0,1]。hour 为本地时刻（可带小数），lux 为环境光照（可选）。 */
export function circadian(hour: number, p: Personality, lux?: number | null): number {
  let c = 0.5 + 0.5 * Math.cos((2 * Math.PI * (hour - p.circadianPeakHour)) / 24);
  if (lux != null) {
    const day = hour >= 7 && hour < 19;
    if (!day && lux > 200) c += 0.1; // 夜里被强光照着，会精神一点
    if (day && lux < 5) c -= 0.1; // 白天待在黑暗里，会更困
  }
  return clamp(c);
}

/** 按经过的时间推进状态（纯函数）。 */
export function advance(s: HeartState, now: number, p: Personality): HeartState {
  const dtH = Math.max(0, (now - s.updatedAt) / 3_600_000);
  const slow = s.mode === "asleep" ? 0.3 : 1; // 睡着时驱动力涨得慢
  return {
    ...s, updatedAt: now,
    S: s.mode === "awake" ? approach(s.S, dtH, p.sleepRiseH) : s.S * Math.exp(-dtH / p.sleepFallH),
    drives: {
      curiosity: approach(s.drives.curiosity, dtH * slow, p.tau.curiosity),
      expression: approach(s.drives.expression, dtH * slow, p.tau.expression),
      social: approach(s.drives.social, dtH * slow, p.tau.social),
      openLoops: s.drives.openLoops,
    },
  };
}

export const sleepiness = (s: HeartState, c: number) => s.S - c;
export const alertness = (s: HeartState, c: number) => clamp(0.5 + c - s.S);

/** 驱动力合成：加权平均后做非线性放大。 */
export function urge(d: Drives, p: Personality): number {
  const w = p.weight;
  const sum = w.curiosity + w.expression + w.social + w.openLoops;
  const avg = (w.curiosity * d.curiosity + w.expression * d.expression + w.social * d.social + w.openLoops * d.openLoops) / sum;
  return Math.pow(clamp(avg), p.gamma);
}

/**
 * 瞬时醒来率（次/小时）。醒着时：想醒来"思考"；睡着时：想"做梦"（整理记忆）。
 * inhibit ∈ [0,1] 为身体与闸门的抑制系数（过热、低电、暂停、急停……）。
 */
export function hazard(s: HeartState, c: number, p: Personality, basePerHour: number, inhibit: number): number {
  if (inhibit <= 0) return 0;
  if (s.mode === "awake") return basePerHour * urge(s.drives, p) * (0.2 + 0.8 * alertness(s, c)) * inhibit;
  const dreamNeed = clamp(s.unconsolidated / 10);
  return basePerHour * 0.5 * dreamNeed * (s.S > 0.2 ? 1 : 0.3) * inhibit;
}

/** 指数分布抽样（稀疏化方法的候选间隔，单位小时）。 */
export const expSample = (rate: number, rnd = Math.random) => -Math.log(1 - rnd()) / rate;
