import { useEffect, useMemo, useState } from "react";
import { simulateDay, sampleAt } from "~/lib/bodyClock";
import { cx } from "~/design-system/components";

type Labels = { title: string; note: string; S: string; C: string; alertness: string; awake: string; asleep: string; now: string };

/** 一天的生物钟曲线（SVG）：C 实线、S 虚线、清醒时段浅底、当前时刻一个琥珀点。 */
export function BodyClock({ t, className }: { t: Labels; className?: string }) {
  const samples = useMemo(() => simulateDay(), []);
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => { const d = new Date(); setHour(d.getHours() + d.getMinutes() / 60); };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  const W = 720, H = 220, PX = 36, PY = 18;
  const x = (h: number) => PX + (h / 24) * (W - PX * 2);
  const y = (v: number) => PY + (1 - v) * (H - PY * 2);
  const path = (key: "S" | "C") => samples.map((s, i) => `${i ? "L" : "M"}${x(s.hour).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const awakeSpans: Array<[number, number]> = [];
  samples.forEach((s, i) => {
    if (s.awake && (i === 0 || !samples[i - 1].awake)) awakeSpans.push([s.hour, s.hour]);
    if (s.awake && awakeSpans.length) awakeSpans[awakeSpans.length - 1][1] = s.hour;
  });
  const now = hour == null ? null : sampleAt(samples, hour);

  return (
    <figure className={cx("rounded-xl border border-border bg-surface p-5 sm:p-6", className)}>
      <figcaption className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span className="text-sm font-medium text-fg">{t.title}</span>
        <span className="text-xs text-fg-subtle">{t.note}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t.title} className="w-full">
        {awakeSpans.map(([a, b], i) => (
          <rect key={i} x={x(a)} y={PY} width={Math.max(1, x(b) - x(a))} height={H - PY * 2} className="fill-chart-fill" />
        ))}
        {[0, 6, 12, 18, 24].map((h) => (
          <g key={h}>
            <line x1={x(h)} x2={x(h)} y1={PY} y2={H - PY} className="stroke-border" strokeWidth="1" />
            <text x={x(h)} y={H - 2} textAnchor="middle" className="fill-fg-subtle text-[11px]"> {/* ds-allow：SVG 字号 */}
              {String(h % 24).padStart(2, "0")}:00
            </text>
          </g>
        ))}
        <path d={path("S")} fill="none" className="stroke-fg-subtle" strokeWidth="1.5" strokeDasharray="4 4" />
        <path d={path("C")} fill="none" className="stroke-chart-line" strokeWidth="2" />
        {now && hour != null && (
          <g>
            <line x1={x(hour)} x2={x(hour)} y1={PY} y2={H - PY} className="stroke-accent-soft" strokeWidth="1" />
            <circle cx={x(hour)} cy={y(now.C)} r="5" className="fill-chart-marker animate-breath motion-reduce:animate-none" />
          </g>
        )}
      </svg>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <div className="flex items-center gap-2"><span aria-hidden className="inline-block h-0.5 w-5 bg-chart-line" /><dt className="text-fg-muted">{t.C}</dt><dd className="font-mono text-fg">{now ? now.C.toFixed(2) : "—"}</dd></div>
        <div className="flex items-center gap-2"><span aria-hidden className="inline-block h-0.5 w-5 border-t border-dashed border-fg-subtle" /><dt className="text-fg-muted">{t.S}</dt><dd className="font-mono text-fg">{now ? now.S.toFixed(2) : "—"}</dd></div>
        <div className="flex items-center gap-2"><span aria-hidden className="inline-block size-3 rounded-xs bg-chart-fill border border-border" /><dt className="text-fg-muted">{t.alertness}</dt><dd className="font-mono text-fg">{now ? now.alertness.toFixed(2) : "—"}</dd></div>
        <div className="flex items-center gap-2"><span aria-hidden className={cx("inline-block size-2 rounded-full", now?.awake ? "bg-accent" : "bg-fg-subtle")} /><dt className="text-fg-muted">{t.now}</dt><dd className="text-fg">{now ? (now.awake ? t.awake : t.asleep) : "—"}</dd></div>
      </dl>
    </figure>
  );
}
