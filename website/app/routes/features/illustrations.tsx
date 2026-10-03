/**
 * 亮点页示意图：全部是内联 SVG / 布局，只用设计系统的语义类（fill-accent、stroke-border …），不含字面量视觉参数。
 * 每张图宽高比 3:2（viewBox 480×320），随容器缩放；文字走 i18n。
 */
import { simulateDay } from "~/lib/bodyClock";
import { cx, StatusDot } from "~/design-system/components";

const Frame = ({ children, label }: { children: React.ReactNode; label: string }) => (
  <figure className="rounded-2xl border border-border bg-surface p-4 sm:p-6">
    <svg viewBox="0 0 480 320" role="img" aria-label={label} className="block w-full font-sans">{children}</svg>
  </figure>
);
const T = ({ x, y, children, className, anchor = "start", size = 13 }: { x: number; y: number; children: React.ReactNode; className?: string; anchor?: "start" | "middle" | "end"; size?: number }) => (
  <text x={x} y={y} textAnchor={anchor} fontSize={size} className={cx("fill-fg", className)}>{children}</text>
);
/** 呼吸的琥珀点（SVG 内用 transform-box 让缩放围绕自身中心） */
const Lamp = ({ cx: x, cy, r = 5, delay = 0 }: { cx: number; cy: number; r?: number; delay?: 0 | 1 | 2 | 3 }) => (
  <circle cx={x} cy={cy} r={r} className={cx("fill-accent animate-breath motion-reduce:animate-none origin-center [transform-box:fill-box]", ["", "[animation-delay:-1s]", "[animation-delay:-2s]", "[animation-delay:-3.5s]"][delay])} /> /* ds-allow：错开相位 */
);

/* 01 定时器 vs Windler 的醒来 */
export function WakeTimeline({ t }: { t: { cron: string; windler: string; cronNote: string; windlerNote: string; axis: readonly string[] } }) {
  const x0 = 40, x1 = 440, y1 = 96, y2 = 212;
  const px = (h: number) => x0 + ((x1 - x0) * h) / 24;
  // 固定的一组「醒来」时刻：清晨稀疏、午后密集、深夜几乎没有
  const wakes = [7.9, 8.6, 10.2, 10.9, 11.3, 13.4, 14.1, 14.5, 15.2, 15.6, 16.1, 16.9, 17.8, 19.3, 20.7, 22.4];
  const alert = Array.from({ length: 49 }, (_, i) => { const h = i / 2; const c = 0.5 + 0.5 * Math.cos((2 * Math.PI * (h - 16)) / 24); return `${i ? "L" : "M"}${px(h).toFixed(1)},${(y2 + 34 - 60 * c).toFixed(1)}`; }).join(" ");
  return (
    <Frame label={`${t.cron} vs ${t.windler}`}>
      <T x={x0} y={y1 - 36} className="fill-fg-muted" size={12}>{t.cron}</T>
      <T x={x1} y={y1 - 36} className="fill-fg-subtle" size={11} anchor="end">{t.cronNote}</T>
      <line x1={x0} x2={x1} y1={y1} y2={y1} className="stroke-border" strokeWidth="2" />
      {Array.from({ length: 25 }, (_, i) => <rect key={i} x={px(i) - 1.5} y={y1 - 10} width="3" height="20" className="fill-fg-subtle" />)}
      <T x={x0} y={y2 - 52} className="fill-fg" size={12}>{t.windler}</T>
      <T x={x1} y={y2 - 52} className="fill-fg-subtle" size={11} anchor="end">{t.windlerNote}</T>
      <path d={alert} fill="none" className="stroke-chart-line" strokeWidth="1.5" strokeDasharray="4 4" />
      <line x1={x0} x2={x1} y1={y2} y2={y2} className="stroke-border" strokeWidth="2" />
      {wakes.map((h, i) => <Lamp key={h} cx={px(h)} cy={y2} r={4.5} delay={(i % 4) as 0 | 1 | 2 | 3} />)}
      {t.axis.map((a, i) => <T key={a} x={px(i * 6)} y={300} className="fill-fg-subtle" size={11} anchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>{a}</T>)}
    </Frame>
  );
}

/* 02 一天的环：醒着 / 睡着 / 做梦 */
export function ClockRing({ t }: { t: { awake: string; asleep: string; dream: string; center: string; wake: string; sleep: string } }) {
  const samples = simulateDay();
  const cx0 = 240, cy0 = 160, r = 112;
  const ang = (h: number) => ((h / 24) * 360 - 90) * (Math.PI / 180);
  const pt = (h: number, rr = r) => [cx0 + rr * Math.cos(ang(h)), cy0 + rr * Math.sin(ang(h))] as const;
  const first = samples.findIndex((s, i) => s.awake && i > 0 && !samples[i - 1].awake);
  const last = samples.findIndex((s, i) => !s.awake && i > first && samples[i - 1].awake);
  const hw = samples[first].hour, hs = samples[last].hour;
  const arc = (a: number, b: number, rr: number) => { const [x1, y1] = pt(a, rr), [x2, y2] = pt(b, rr); return `M${x1},${y1} A${rr},${rr} 0 ${b - a > 12 ? 1 : 0} 1 ${x2},${y2}`; };
  const dreams = [1.2, 3.4, 5.1];
  return (
    <Frame label={t.center}>
      <circle cx={cx0} cy={cy0} r={r} fill="none" className="stroke-border" strokeWidth="14" />
      <path d={arc(hw, hs, r)} fill="none" className="stroke-chart-line" strokeWidth="14" strokeLinecap="round" />
      {dreams.map((h) => { const [x, y] = pt(h); return <circle key={h} cx={x} cy={y} r="4" className="fill-secondary-fg" />; })}
      {[0, 6, 12, 18].map((h) => { const [x, y] = pt(h, r + 26); return <T key={h} x={x} y={y + 4} className="fill-fg-subtle" size={11} anchor="middle">{String(h).padStart(2, "0")}</T>; })}
      <Lamp cx={pt(hw)[0]} cy={pt(hw)[1]} r={7} />
      <T x={pt(hw, r + 44)[0]} y={pt(hw, r + 44)[1] + 4} className="fill-accent" size={12} anchor="start">{t.wake}</T>
      <T x={pt(hs, r + 44)[0]} y={pt(hs, r + 44)[1] + 4} className="fill-fg-muted" size={12} anchor="end">{t.sleep}</T>
      <T x={cx0} y={cy0 - 6} className="fill-fg" size={20} anchor="middle">{t.center}</T>
      <T x={cx0} y={cy0 + 18} className="fill-fg-subtle" size={11} anchor="middle">{`${t.awake} · ${t.asleep} · ${t.dream}`}</T>
      <circle cx={pt(13, r)[0]} cy={pt(13, r)[1]} r="3" className="fill-bg" />
    </Frame>
  );
}

/* 03 传感器 → 身体感受 */
export function BodySenses({ t }: { t: { sensors: readonly (readonly string[])[]; feelings: readonly string[] } }) {
  return (
    <Frame label={t.feelings.join(" ")}>
      <rect x="40" y="26" width="150" height="268" rx="22" className="fill-bg stroke-border-strong" strokeWidth="2" />
      <rect x="95" y="40" width="40" height="5" rx="2.5" className="fill-border-strong" />
      {t.sensors.map(([k, v], i) => (
        <g key={k}>
          <rect x="56" y={64 + i * 52} width="118" height="38" rx="8" className="fill-surface-hover" />
          <T x={66} y={64 + i * 52 + 24} className="fill-fg-muted" size={12}>{k}</T>
          <T x={164} y={64 + i * 52 + 24} className="fill-fg" size={12} anchor="end">{v}</T>
          <path d={`M190,${64 + i * 52 + 19} C 230,${64 + i * 52 + 19} 240,${72 + i * 52 + 19} 282,${72 + i * 52 + 19}`} fill="none" className="stroke-border-strong" strokeWidth="1.5" />
          <rect x="284" y={72 + i * 52} width="150" height="38" rx="19" className={i === 3 ? "fill-accent-soft stroke-accent" : "fill-secondary-soft stroke-border"} strokeWidth="1" />
          <T x={359} y={72 + i * 52 + 24} className={i === 3 ? "fill-accent" : "fill-secondary-fg"} size={12} anchor="middle">{t.feelings[i]}</T>
        </g>
      ))}
      <Lamp cx={115} cy={272} r={5} />
    </Frame>
  );
}

/* 04 灵魂仓库与多具身体 */
export function SoulGit({ t }: { t: { repo: string; bodies: readonly string[]; log: readonly (readonly string[])[]; logTitle: string } }) {
  const pos = [[70, 70], [240, 44], [410, 70]] as const;
  return (
    <Frame label={t.repo}>
      {pos.map(([x, y], i) => (
        <g key={i}>
          <line x1={x} y1={y + 18} x2={240} y2={150} className="stroke-border-strong" strokeWidth="1.5" strokeDasharray="4 3" />
          <rect x={x - 46} y={y - 18} width="92" height="36" rx="10" className="fill-surface-hover stroke-border" strokeWidth="1" />
          <T x={x} y={y + 5} className="fill-fg" size={12} anchor="middle">{t.bodies[i]}</T>
        </g>
      ))}
      <path d="M180,142 a60,14 0 0 1 120,0 v40 a60,14 0 0 1 -120,0 z" className="fill-surface-hover stroke-border-strong" strokeWidth="1.5" />
      <ellipse cx="240" cy="142" rx="60" ry="14" className="fill-surface-hover stroke-border-strong" strokeWidth="1.5" />
      <T x={240} y={176} className="fill-fg" size={13} anchor="middle">{t.repo}</T>
      <Lamp cx={240} cy={146} r={4} />
      <T x={40} y={230} className="fill-fg-subtle" size={11}>{t.logTitle}</T>
      {t.log.map(([time, what, body], i) => (
        <g key={i}>
          <circle cx={48} cy={252 + i * 22} r="3.5" className={i === 0 ? "fill-accent" : "fill-secondary-fg"} />
          {i < 2 && <line x1={48} y1={256 + i * 22} x2={48} y2={270 + i * 22} className="stroke-border-strong" strokeWidth="1.5" />}
          <T x={64} y={256 + i * 22} className="fill-fg-subtle font-mono" size={11}>{time}</T>
          <T x={112} y={256 + i * 22} className="fill-fg" size={12}>{what}</T>
          <T x={440} y={256 + i * 22} className="fill-fg-subtle" size={11} anchor="end">{body}</T>
        </g>
      ))}
    </Frame>
  );
}

/* 05 保密传递 */
export function SecretVault({ t }: { t: { you: string; bubble: string; vault: string; file: string; model: string; seen: string } }) {
  return (
    <Frame label={t.vault}>
      <T x={40} y={62} className="fill-fg-subtle" size={11}>{t.you}</T>
      <rect x="40" y="72" width="170" height="44" rx="14" className="fill-surface-hover stroke-border" strokeWidth="1" />
      <T x={125} y={99} className="fill-fg font-mono" size={13} anchor="middle">{t.bubble}</T>
      <path d="M210,94 C 250,94 250,150 286,150" fill="none" className="stroke-border-strong" strokeWidth="1.5" />
      <rect x="288" y="118" width="152" height="64" rx="12" className="fill-bg stroke-accent" strokeWidth="1.5" />
      <rect x="352" y="104" width="24" height="18" rx="9" className="fill-bg stroke-accent" strokeWidth="1.5" />
      <T x={364} y={143} className="fill-accent" size={12} anchor="middle">{t.vault}</T>
      <T x={364} y={166} className="fill-fg-muted font-mono" size={10} anchor="middle">{t.file}</T>
      <path d="M364,182 V214" className="stroke-border-strong" strokeWidth="1.5" strokeDasharray="4 3" />
      <T x={40} y={226} className="fill-fg-subtle" size={11}>{t.model}</T>
      <rect x="40" y="236" width="400" height="48" rx="10" className="fill-surface-hover stroke-border" strokeWidth="1" />
      <T x={60} y={265} className="fill-fg-muted font-mono" size={13}>{t.seen}</T>
      <line x1="120" y1="92" x2="130" y2="106" className="stroke-danger" strokeWidth="0" />
      <Lamp cx={364} cy={122} r={3} />
    </Frame>
  );
}

/* 06 授权 · 审批 · 预算 · 急停 */
export function ControlPanel({ t }: { t: { caps: readonly (readonly [string, number])[]; levels: readonly string[]; approval: string; approve: string; deny: string; budget: string; stop: string } }) {
  return (
    <Frame label={t.stop}>
      {t.caps.map(([name, lvl], i) => (
        <g key={name}>
          <T x={40} y={56 + i * 40} className="fill-fg" size={12}>{name}</T>
          {t.levels.map((l, j) => (
            <g key={l}>
              <rect x={150 + j * 62} y={40 + i * 40} width="58" height="24" rx="12" className={j === lvl ? (j === 2 ? "fill-danger" : "fill-fg") : "fill-surface-hover"} />
              <T x={179 + j * 62} y={56 + i * 40} className={j === lvl ? "fill-bg" : "fill-fg-subtle"} size={11} anchor="middle">{l}</T>
            </g>
          ))}
        </g>
      ))}
      <rect x="40" y="170" width="300" height="70" rx="12" className="fill-surface-hover stroke-border" strokeWidth="1" />
      <T x={56} y={196} className="fill-fg" size={12}>{t.approval}</T>
      <rect x="56" y="206" width="76" height="24" rx="12" className="fill-fg" /><T x={94} y={222} className="fill-bg" size={11} anchor="middle">{t.approve}</T>
      <rect x="140" y="206" width="76" height="24" rx="12" className="fill-bg stroke-border-strong" strokeWidth="1" /><T x={178} y={222} className="fill-fg-muted" size={11} anchor="middle">{t.deny}</T>
      <T x={40} y={272} className="fill-fg-subtle" size={11}>{t.budget}</T>
      <rect x="40" y="280" width="300" height="8" rx="4" className="fill-border" /><rect x="40" y="280" width="190" height="8" rx="4" className="fill-secondary" />
      <circle cx="400" cy="205" r="40" className="fill-danger" />
      <T x={400} y={210} className="fill-bg" size={14} anchor="middle">{t.stop}</T>
    </Frame>
  );
}

/* 07 三步装进手机 */
export function PhoneSteps({ t }: { t: { steps: readonly string[]; done: string } }) {
  return (
    <Frame label={t.done}>
      <rect x="160" y="18" width="160" height="284" rx="24" className="fill-bg stroke-border-strong" strokeWidth="2" />
      <rect x="220" y="32" width="40" height="5" rx="2.5" className="fill-border-strong" />
      {t.steps.map((s, i) => (
        <g key={s}>
          <rect x="176" y={56 + i * 56} width="128" height="42" rx="10" className={i < 2 ? "fill-surface-hover" : "fill-accent-soft stroke-accent"} strokeWidth="1" />
          <circle cx="194" cy={77 + i * 56} r="8" className={i < 2 ? "fill-secondary" : "fill-accent"} />
          <T x={194} y={81 + i * 56} className="fill-bg" size={10} anchor="middle">{i + 1}</T>
          <T x={210} y={81 + i * 56} className="fill-fg" size={11}>{s}</T>
        </g>
      ))}
      <Lamp cx={240} cy={254} r={9} />
      <T x={240} y={286} className="fill-fg-muted" size={12} anchor="middle">{t.done}</T>
    </Frame>
  );
}

/** 小网格里的「灯」 */
export const Dot = () => <StatusDot />;
