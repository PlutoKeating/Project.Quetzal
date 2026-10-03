// 生成 README 用的生物钟曲线 ../docs/assets/readme/bodyclock.{zh,en}.svg（与官网首页同一模型）。
// 用法：node --experimental-strip-types scripts/gen-bodyclock-svg.ts
import { writeFileSync } from "node:fs";
import { simulateDay } from "../app/lib/bodyClock.ts";

const BG = "#0e0f11", BOX = "#17181c", BORDER = "#2a2b30", FG = "#e8e4dd", MUTED = "#a9a49c", SUB = "#6f6b65", LINE = "#7d8f8a", FILL = "rgba(125,143,138,0.14)", ACCENT = "#f0a35e";
const FONT = 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const L = {
  zh: { title: "一天的生物钟（双过程模型）", S: "睡眠压力 S：醒着上升，睡着回落", C: "昼夜节律 C：24 小时余弦", awake: "醒着", asleep: "睡着", note: "困意 = S − C。越过阈值入睡，跌破阈值醒来。没有定时器。" },
  en: { title: "One day of the body clock (two-process model)", S: "Sleep pressure S: rises awake, decays asleep", C: "Circadian C: 24-hour cosine", awake: "awake", asleep: "asleep", note: "sleepiness = S − C. Cross one threshold to fall asleep, drop below another to wake. No timers." },
};
const samples = simulateDay();
const W = 1600, H = 480, PX = 80, PY = 70, PB = 110;
const x = (h: number) => PX + (h / 24) * (W - PX * 2);
const y = (v: number) => PY + (1 - v) * (H - PY - PB);
const path = (k: "S" | "C") => samples.map((s, i) => `${i ? "L" : "M"}${x(s.hour).toFixed(1)},${y(s[k]).toFixed(1)}`).join(" ");
const spans: Array<[number, number]> = [];
samples.forEach((s, i) => { if (s.awake && (i === 0 || !samples[i - 1].awake)) spans.push([s.hour, s.hour]); if (s.awake && spans.length) spans[spans.length - 1][1] = s.hour; });
for (const [lang, t] of Object.entries(L)) {
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family='${FONT}'>`);
  o.push(`<rect width="${W}" height="${H}" rx="24" fill="${BG}"/>`);
  o.push(`<text x="${PX}" y="42" font-size="24" font-weight="600" fill="${FG}">${t.title}</text>`);
  for (const [a, b] of spans) o.push(`<rect x="${x(a)}" y="${PY}" width="${Math.max(1, x(b) - x(a))}" height="${H - PY - PB}" fill="${FILL}"/>`);
  for (const [a, b] of spans) o.push(`<text x="${(x(a) + x(b)) / 2}" y="${PY + 28}" text-anchor="middle" font-size="18" fill="${LINE}">${t.awake}</text>`);
  for (const h of [0, 6, 12, 18, 24]) o.push(`<line x1="${x(h)}" x2="${x(h)}" y1="${PY}" y2="${H - PB}" stroke="${BORDER}"/><text x="${x(h)}" y="${H - PB + 30}" text-anchor="middle" font-size="18" fill="${SUB}">${String(h % 24).padStart(2, "0")}:00</text>`);
  o.push(`<path d="${path("S")}" fill="none" stroke="${SUB}" stroke-width="2.5" stroke-dasharray="6 6"/>`);
  o.push(`<path d="${path("C")}" fill="none" stroke="${LINE}" stroke-width="3.5"/>`);
  const mark = samples.find((s, i) => s.awake && i > 0 && !samples[i - 1].awake)!;
  o.push(`<circle cx="${x(mark.hour)}" cy="${y(mark.C)}" r="9" fill="${ACCENT}"/>`);
  o.push(`<line x1="${PX}" x2="${PX + 36}" y1="${H - 36}" y2="${H - 36}" stroke="${LINE}" stroke-width="3.5"/><text x="${PX + 48}" y="${H - 30}" font-size="18" fill="${MUTED}">${t.C}</text>`);
  o.push(`<line x1="${PX + 520}" x2="${PX + 556}" y1="${H - 36}" y2="${H - 36}" stroke="${SUB}" stroke-width="2.5" stroke-dasharray="6 6"/><text x="${PX + 568}" y="${H - 30}" font-size="18" fill="${MUTED}">${t.S}</text>`);
  o.push(`<text x="${W - PX}" y="${H - 30}" text-anchor="end" font-size="18" fill="${SUB}">${t.note}</text>`);
  o.push(`</svg>`);
  const p = `../docs/assets/readme/bodyclock.${lang}.svg`;
  writeFileSync(p, o.join("\n")); console.log(p);
}
