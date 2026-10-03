/** 一天的底纹：24 小时带子，醒着的时段浅底，昼夜节律与睡眠压力两条细线，示例条目在带子上各打一个点。 */
import { useMemo } from "react";
import { simulateDay } from "~/lib/bodyClock";

export function DayStrip({ times, label }: { times: readonly string[]; label: string }) {
  const samples = useMemo(() => simulateDay(), []);
  const W = 720, H = 72, PX = 8;
  const x = (h: number) => PX + (h / 24) * (W - PX * 2);
  const y = (v: number) => 10 + (1 - v) * (H - 28);
  const path = (k: "S" | "C") => samples.map((s, i) => `${i ? "L" : "M"}${x(s.hour).toFixed(1)},${y(s[k]).toFixed(1)}`).join(" ");
  const spans: Array<[number, number]> = [];
  samples.forEach((s, i) => { if (s.awake && (i === 0 || !samples[i - 1].awake)) spans.push([s.hour, s.hour]); if (s.awake && spans.length) spans[spans.length - 1][1] = s.hour; });
  const toH = (t: string) => { const [h, m] = t.split(":").map(Number); return h + m / 60; };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block w-full">
      {spans.map(([a, b], i) => <rect key={i} x={x(a)} y={6} width={Math.max(1, x(b) - x(a))} height={H - 20} rx="4" className="fill-chart-fill" />)}
      <path d={path("S")} fill="none" className="stroke-fg-subtle" strokeWidth="1" strokeDasharray="3 3" />
      <path d={path("C")} fill="none" className="stroke-chart-line" strokeWidth="1.5" />
      {times.map((t) => <circle key={t} cx={x(toH(t))} cy={H - 14} r="3.5" className="fill-chart-marker" />)}
      {[0, 6, 12, 18, 24].map((h) => <text key={h} x={x(h)} y={H - 1} textAnchor={h === 0 ? "start" : h === 24 ? "end" : "middle"} fontSize="9" className="fill-fg-subtle">{String(h % 24).padStart(2, "0")}</text>)}
    </svg>
  );
}
