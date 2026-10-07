/**
 * 示例身体：演示用，所有数值都是按访客的本地时间写死的曲线，不连接任何设备，也不运行模型。
 * - 7:50 醒、22:20 睡；清醒度白天高、夜里低；睡眠压力白天积累、夜里回落
 * - 电量夜里充电、白天放电；光线白天亮、夜里暗
 * - 「上次醒来」取示例时间线（首页「一天」一节）里当前时刻之前最近的一条：自然醒、思考、翻身、对话、做梦都是一次醒来
 * - 「住进来的第几天」从一个固定日期起算，只是为了让数字会变
 */
import { useEffect, useState } from "react";
import { StatusDot, cx } from "~/design-system/components";

type Labels = {
  mode: { awake: string; asleep: string }; saying: { awake: string; asleep: string };
  fields: { alertness: string; pressure: string; battery: string; light: string; day: string; lastWake: string };
  units: { lux: string; day: string }; charging: string; ago: (m: number) => string;
};

const MOVED_IN = Date.UTC(2026, 8, 28); // 示例起算日：只决定「第几天」这个会变的数字
const WAKE_AT = 7.85, SLEEP_AT = 22.3; // 示例作息：7:51 醒，22:18 睡
const isAwake = (h: number) => h >= WAKE_AT && h < SLEEP_AT;
/** 示例清醒度：醒着时从 0.55 爬到下午 4 点的 0.95 再回落到 0.4；睡着时 0.12–0.2。 */
const alertness = (h: number) => (isAwake(h) ? 0.4 + 0.55 * Math.sin((Math.PI * (h - WAKE_AT)) / (SLEEP_AT - WAKE_AT)) : 0.12 + 0.08 * Math.abs(Math.sin((Math.PI * (h + 2)) / 10)));
/** 示例睡眠压力：醒着时从 0.2 线性积累到 0.8；睡着时从 0.8 回落到 0.2。 */
const pressure = (h: number) => (isAwake(h) ? 0.2 + 0.6 * ((h - WAKE_AT) / (SLEEP_AT - WAKE_AT)) : 0.8 - 0.6 * (((h < WAKE_AT ? h + 24 : h) - SLEEP_AT) / (24 - SLEEP_AT + WAKE_AT)));
/** 示例电量：7 点满电，白天每小时掉约 3%，23 点后充电。 */
const battery = (h: number) => (h < 7 || h >= 23 ? { level: Math.min(100, Math.round(70 + ((h < 7 ? h + 1 : h - 23) / 8) * 30)), charging: true } : { level: Math.round(100 - (h - 7) * 3.2), charging: false });
/** 示例光线：夜里 3 lx，白天按日照曲线到 400 lx。 */
const lux = (h: number) => (h < 6.5 || h > 19.5 ? 3 : Math.round(20 + 380 * Math.sin((Math.PI * (h - 6.5)) / 13)));
/** 上次醒来：示例时间线里当前时刻之前最近的一条（每一条都是一次醒来）；今天还没有就取昨天的最后一条。 */
function lastWakeMinutes(times: string[], hour: number): number | null {
  const hours = times.map((x) => { const [h, m] = x.split(":").map(Number); return h + m / 60; }).sort((a, b) => a - b);
  if (!hours.length) return null;
  const today = hours.filter((h) => h <= hour);
  const last = today.length ? today[today.length - 1] : hours[hours.length - 1] - 24;
  return Math.max(0, Math.round((hour - last) * 60));
}

export function ExampleBody({ t, events, className }: { t: Labels; events: string[]; className?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  const hour = now ? now.getHours() + now.getMinutes() / 60 : null;
  const s = hour == null ? null : { awake: isAwake(hour), alertness: alertness(hour), S: pressure(hour) };
  const bat = hour == null ? null : battery(hour);
  const days = now ? Math.max(1, Math.floor((now.getTime() - MOVED_IN) / 86_400_000)) : null;
  const woke = hour == null ? null : lastWakeMinutes(events, hour);
  const awake = !!s?.awake;

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-4 border-t border-border py-3 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="tabular-nums text-fg">{value}</dd>
    </div>
  );
  return (
    <div className={cx("rounded-2xl border border-border bg-surface p-6 sm:p-8", className)}>
      <div className="flex items-center gap-3">
        <StatusDot alive={awake} />
        <span className="text-2xl font-semibold tracking-tight">{s ? (awake ? t.mode.awake : t.mode.asleep) : "—"}</span>
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
