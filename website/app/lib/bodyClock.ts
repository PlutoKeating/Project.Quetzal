/**
 * 生物钟模拟：在浏览器里运行与运行基座相同的双过程模型（runtime/src/heart/model.ts 的纯函数部分）。
 * 这是模型，不是任何真实设备的数据；首页用它画出一天里睡眠压力 S、昼夜节律 C 与清醒度的曲线。
 */
export type Personality = { sleepRiseH: number; sleepFallH: number; circadianPeakHour: number; sleepAt: number; wakeAt: number };
export const DEFAULT_PERSONALITY: Personality = { sleepRiseH: 16, sleepFallH: 4, circadianPeakHour: 16, sleepAt: 0.35, wakeAt: -0.15 };

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const approach = (x: number, dtH: number, tau: number) => 1 - (1 - x) * Math.exp(-dtH / tau);

/** 昼夜节律 C ∈ [0,1]：余弦，峰值在 circadianPeakHour。 */
export const circadian = (hour: number, p: Personality) => clamp(0.5 + 0.5 * Math.cos((2 * Math.PI * (hour - p.circadianPeakHour)) / 24));

export type Sample = { hour: number; S: number; C: number; alertness: number; awake: boolean };

/** 模拟稳态的一天：从午夜睡着开始，先跑一天让状态收敛，再记录第二天。步长 stepMin 分钟。 */
export function simulateDay(p: Personality = DEFAULT_PERSONALITY, stepMin = 5): Sample[] {
  const dt = stepMin / 60;
  let S = 0.6, awake = false;
  const out: Sample[] = [];
  for (let day = 0; day < 2; day++) {
    for (let h = 0; h < 24; h += dt) {
      const C = circadian(h, p);
      S = awake ? approach(S, dt, p.sleepRiseH) : S * Math.exp(-dt / p.sleepFallH);
      const sleepiness = S - C;
      if (awake && sleepiness > p.sleepAt) awake = false;
      else if (!awake && sleepiness < p.wakeAt) awake = true;
      if (day === 1) out.push({ hour: h, S, C, alertness: clamp(0.5 + C - S), awake });
    }
  }
  return out;
}

export const sampleAt = (samples: Sample[], hour: number) => samples[Math.min(samples.length - 1, Math.floor((hour / 24) * samples.length))];
