/**
 * 示例身体：全部由浏览器里的生物钟模型按本地时间推算，不连接任何真实设备。
 * - 模式 / 清醒度 / 睡眠压力来自 lib/bodyClock（与运行基座相同的双过程模型）
 * - 电量、光线是按一天节律构造的示例曲线（夜里充电、白天放电；白天明亮、夜里昏暗）
 * - 「住进来的第几天」从一个固定日期起算，只是为了让数字会变
 */
import { useEffect, useMemo, useState } from "react";
import { simulateDay, sampleAt, type Sample } from "~/lib/bodyClock";
import { Badge, StatusDot, cx } from "~/design-system/components";

type Labels = {
  note: string; mode: { awake: string; asleep: string }; saying: { awake: string; asleep: string };
  fields: { alertness: string; pressure: string; battery: string; light: string; day: string; lastWake: string };
  units: { lux: string; day: string }; charging: string; ago: (m: number) => string;
};

const MOVED_IN = Date.UTC(2026, 8, 28); // 示例起算日：只决定「第几天」这个会变的数字
/** 示例电量：7 点满电，白天每小时掉约 3%，23 点后充电。 */
const battery = (h: number) => (h < 7 || h >= 23 ? { level: Math.min(100, Math.round(70 + ((h < 7 ? h + 1 : h - 23) / 8) * 30)), charging: true } : { level: Math.round(100 - (h - 7) * 3.2), charging: false });
/** 示例光线：夜里 3 lx，白天按日照曲线到 400 lx。 */
const lux = (h: number) => (h < 6.5 || h > 19.5 ? 3 : Math.round(20 + 380 * Math.sin((Math.PI * (h - 6.5)) / 13)));
/** 上次醒来：当前时刻之前最近一次「睡着 → 醒着」的边沿。 */
function lastWakeMinutes(samples: Sample[], hour: number): number | null {
  const edges = samples.filter((s, i) => s.awake && i > 0 && !samples[i - 1].awake).map((s) => s.hour);
  if (!edges.length) return null;
  const today = edges.filter((h) => h <= hour);
  const last = today.length ? today[today.length - 1] : edges[edges.length - 1] - 24; // 今天还没醒过：上次醒来在昨天
  return Math.max(0, Math.round((hour - last) * 60));
}

export function ExampleBody({ t, className }: { t: Labels; className?: string }) {
  const samples = useMemo(() => simulateDay(), []);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  const hour = now ? now.getHours() + now.getMinutes() / 60 : null;
  const s = hour == null ? null : sampleAt(samples, hour);
  const bat = hour == null ? null : battery(hour);
  const days = now ? Math.max(1, Math.floor((now.getTime() - MOVED_IN) / 86_400_000)) : null;
  const woke = hour == null ? null : lastWakeMinutes(samples, hour);
  const awake = !!s?.awake;

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-4 border-t border-border py-3 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="font-mono text-fg">{value}</dd>
    </div>
  );
  return (
    <div className={cx("rounded-2xl border border-border bg-surface p-6 sm:p-8", className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <StatusDot alive={awake} />
          <span className="text-2xl font-semibold tracking-tight">{s ? (awake ? t.mode.awake : t.mode.asleep) : "—"}</span>
        </div>
        <Badge tone="secondary">{t.note}</Badge>
      </div>
      <p className="mt-2 text-fg-muted">{s ? (awake ? t.saying.awake : t.saying.asleep) : ""}</p>
      <dl className="mt-6">
        {row(t.fields.alertness, s ? s.alertness.toFixed(2) : "—")}
        {row(t.fields.pressure, s ? s.S.toFixed(2) : "—")}
        {row(t.fields.battery, bat ? `${bat.level}%${bat.charging ? ` · ${t.charging}` : ""}` : "—")}
        {row(t.fields.light, hour == null ? "—" : `${lux(hour)} ${t.units.lux}`)}
        {row(t.fields.lastWake, woke == null ? "—" : t.ago(woke))}
        {row(t.fields.day, days == null ? "—" : `${days} ${t.units.day}`)}
      </dl>
    </div>
  );
}
