/**
 * 亮点页示意图：全部是内联 SVG，只用设计系统的语义类，不含字面量视觉参数；公共件见 components/figure.tsx。
 * 每张图 viewBox 480×320，随容器缩放；文字走 i18n。
 */
import { cx, StatusDot } from "~/design-system/components";
import { Frame, T, Lamp, WakeCompare, type CompareLabels } from "~/components/figure";

/* 03 三条带子：Codex / Hermes-OpenClaw / Quetzal */
export function WakeTimeline({ t }: { t: CompareLabels }) {
  return <WakeCompare t={t} />;
}

/* 04 传感器 → 身体感受。手机里每行键在上、值在下（同一行放不下放大后的英文）；右侧胶囊加宽。 */
export function BodySenses({ t }: { t: { sensors: readonly (readonly string[])[]; feelings: readonly string[] } }) {
  return (
    <Frame label={t.feelings.join(" ")}>
      <rect x="40" y="26" width="150" height="268" rx="22" className="fill-bg stroke-border-strong" strokeWidth="2" />
      <rect x="95" y="40" width="40" height="5" rx="2.5" className="fill-border-strong" />
      {t.sensors.map(([k, v], i) => (
        <g key={k}>
          <rect x="56" y={64 + i * 52} width="118" height="40" rx="8" className="fill-surface-hover" />
          <T x={66} y={64 + i * 52 + 14} className="fill-fg-muted" size={9.5}>{k}</T>
          <T x={66} y={64 + i * 52 + 34} className="fill-fg" size={12}>{v}</T>
          <path d={`M190,${64 + i * 52 + 20} C 225,${64 + i * 52 + 20} 232,${72 + i * 52 + 19} 266,${72 + i * 52 + 19}`} fill="none" className="stroke-border-strong" strokeWidth="1.5" />
          <rect x="268" y={72 + i * 52} width="172" height="38" rx="19" className={i === 3 ? "fill-accent-soft stroke-accent" : "fill-secondary-soft stroke-border"} strokeWidth="1" />
          <T x={354} y={72 + i * 52 + 24} className={i === 3 ? "fill-accent" : "fill-secondary-fg"} size={11} anchor="middle">{t.feelings[i]}</T>
        </g>
      ))}
      <Lamp cx={115} cy={272} r={5} />
    </Frame>
  );
}

/* 01 灵魂仓库与多具身体 */
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
          <T x={64} y={256 + i * 22} className="fill-fg-subtle tabular-nums" size={11}>{time}</T>
          <T x={128} y={256 + i * 22} className="fill-fg" size={12}>{what}</T>
          <T x={440} y={256 + i * 22} className="fill-fg-subtle" size={11} anchor="end">{body}</T>
        </g>
      ))}
    </Frame>
  );
}

/* 02 几具身体，一个 ta：三具身体两两相连，中间是同一颗心；电脑上在想事情，借用手机的相机。
 *  文字都上下错开（窄屏放大 1.5 倍后同一行放不下两段）。 */
export function MeshBodies({ t }: { t: { bodies: readonly string[]; center: string; active: string; borrow: string; caption: string } }) {
  const pos = [[240, 58], [80, 196], [400, 196]] as const;
  const heart = [240, 124] as const;
  return (
    <Frame label={`${t.center} · ${t.caption}`}>
      {pos.map(([x, y], i) => <line key={`h${i}`} x1={x} y1={y} x2={heart[0]} y2={heart[1]} className="stroke-border" strokeWidth="1.5" strokeDasharray="4 3" />)}
      <line x1={pos[0][0]} y1={pos[0][1]} x2={pos[1][0]} y2={pos[1][1]} className="stroke-border-strong" strokeWidth="1.5" />
      <line x1={pos[0][0]} y1={pos[0][1]} x2={pos[2][0]} y2={pos[2][1]} className="stroke-border-strong" strokeWidth="1.5" />
      <line x1={pos[2][0]} y1={pos[2][1]} x2={pos[1][0]} y2={pos[1][1]} className="stroke-accent" strokeWidth="1.5" strokeDasharray="6 4" />
      <circle cx={heart[0]} cy={heart[1]} r="22" className="fill-accent-soft stroke-accent" strokeWidth="1" />
      <Lamp cx={heart[0]} cy={heart[1]} r={8} />
      <T x={heart[0]} y={heart[1] + 40} className="fill-accent" size={12} anchor="middle">{t.center}</T>
      {pos.map(([x, y], i) => (
        <g key={i}>
          <rect x={x - 52} y={y - 20} width="104" height="40" rx="10" className={i === 2 ? "fill-surface-hover stroke-accent" : "fill-surface-hover stroke-border"} strokeWidth="1" />
          <T x={x} y={y + 5} className="fill-fg" size={12} anchor="middle">{t.bodies[i]}</T>
        </g>
      ))}
      <T x={pos[2][0]} y={pos[2][1] + 44} className="fill-fg-muted" size={11} anchor="middle">{t.active}</T>
      <T x={28} y={pos[1][1] + 44} className="fill-fg-muted" size={11}>{t.borrow}</T>
      <T x={240} y={300} className="fill-fg-subtle" size={11} anchor="middle">{t.caption}</T>
    </Frame>
  );
}

/* 05 自造工具：说明书在灵魂里，两具身体各有一份自己做的工具（第二份是照着说明书重做的） */
export function SkillTools({ t }: { t: { doc: string; docSub: string; bodies: readonly string[]; built: readonly string[]; caption: string } }) {
  const xs = [125, 355] as const;
  return (
    <Frame label={t.caption}>
      <rect x="150" y="26" width="180" height="76" rx="12" className="fill-bg stroke-accent" strokeWidth="1.5" />
      <path d="M162,44 h12 l6,6 v22 h-18 z" fill="none" className="stroke-accent" strokeWidth="1.5" />
      <T x={250} y={60} className="fill-accent" size={13} anchor="middle">{t.doc}</T>
      <T x={250} y={84} className="fill-fg-subtle" size={10.5} anchor="middle">{t.docSub}</T>
      {xs.map((x, i) => (
        <g key={i}>
          <path d={`M240,102 C 240,130 ${x},126 ${x},152`} fill="none" className="stroke-border-strong" strokeWidth="1.5" strokeDasharray="4 3" />
          <rect x={x - 90} y="154" width="180" height="84" rx="12" className={i === 1 ? "fill-accent-soft stroke-accent" : "fill-surface-hover stroke-border"} strokeWidth="1" />
          <T x={x} y={186} className="fill-fg" size={12} anchor="middle">{t.bodies[i]}</T>
          <T x={x} y={216} className={i === 1 ? "fill-accent" : "fill-fg-muted"} size={11} anchor="middle">{t.built[i]}</T>
        </g>
      ))}
      <Lamp cx={xs[1] + 74} cy={170} r={4} />
      <T x={240} y={290} className="fill-fg-subtle" size={11} anchor="middle">{t.caption}</T>
    </Frame>
  );
}

/* 06 授权 · 审批 · 预算 · 急停 */
export function ControlPanel({ t }: { t: { caps: readonly (readonly [string, number])[]; levels: readonly string[]; approval: string; approve: string; deny: string; budget: string; stop: string } }) {
  return (
    <Frame label={t.stop}>
      {t.caps.map(([name, lvl], i) => (
        <g key={name}>
          <T x={40} y={56 + i * 40} className="fill-fg" size={11}>{name}</T>
          {t.levels.map((l, j) => (
            <g key={l}>
              <rect x={166 + j * 60} y={40 + i * 40} width="58" height="24" rx="12" className={j === lvl ? (j === 2 ? "fill-danger" : "fill-fg") : "fill-surface-hover"} />
              <T x={195 + j * 60} y={56 + i * 40} className={j === lvl ? "fill-bg" : "fill-fg-subtle"} size={11} anchor="middle">{l}</T>
            </g>
          ))}
        </g>
      ))}
      <rect x="40" y="170" width="300" height="70" rx="12" className="fill-surface-hover stroke-border" strokeWidth="1" />
      <T x={56} y={196} className="fill-fg" size={12}>{t.approval}</T>
      <rect x="56" y="206" width="90" height="24" rx="12" className="fill-fg" /><T x={101} y={222} className="fill-bg" size={11} anchor="middle">{t.approve}</T>
      <rect x="154" y="206" width="90" height="24" rx="12" className="fill-bg stroke-border-strong" strokeWidth="1" /><T x={199} y={222} className="fill-fg-muted" size={11} anchor="middle">{t.deny}</T>
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
      <rect x="130" y="18" width="220" height="284" rx="24" className="fill-bg stroke-border-strong" strokeWidth="2" />
      <rect x="220" y="32" width="40" height="5" rx="2.5" className="fill-border-strong" />
      {t.steps.map((s, i) => (
        <g key={s}>
          <rect x="146" y={56 + i * 56} width="188" height="42" rx="10" className={i < 2 ? "fill-surface-hover" : "fill-accent-soft stroke-accent"} strokeWidth="1" />
          <circle cx="166" cy={77 + i * 56} r="8" className={i < 2 ? "fill-secondary" : "fill-accent"} />
          <T x={166} y={81 + i * 56} className="fill-bg" size={10} anchor="middle">{i + 1}</T>
          <T x={182} y={81 + i * 56} className="fill-fg" size={11}>{s}</T>
        </g>
      ))}
      <Lamp cx={240} cy={254} r={9} />
      <T x={240} y={286} className="fill-fg-muted" size={12} anchor="middle">{t.done}</T>
    </Frame>
  );
}

/** 小网格里的「灯」 */
export const Dot = () => <StatusDot />;
