import type { Lang } from "~/i18n/core";
import { Bar, Canvas, Corners, Node, Rule, T, Trace, ink } from "./kit";

type Labels = {
  hostAria: string;
  host: string;
  name: string;
  connected: string;
  carried: string;
  seaAria: string;
  levels: { name: string; meta: string }[];
};

const labels: Record<Lang, Labels> = {
  zh: {
    hostAria: "线框示意：你的宿主终端。你提交一句话，回答照常出现；底部的状态栏上有他的名字、已接上、带入 3 条。",
    host: "Claude Code",
    name: "阿羽",
    connected: "已接上",
    carried: "带入 3 条",
    seaAria: "线框示意：海里自上而下四个层级——底线、核心、关系、往事。底线由你亲手签，核心在会话开始时带入，这一次提交带入 3 条往事。",
    levels: [
      { name: "底线", meta: "你亲手签" },
      { name: "核心", meta: "会话开始带入" },
      { name: "关系", meta: "" },
      { name: "往事", meta: "这一次 3 条" },
    ],
  },
  en: {
    hostAria: "Wireframe: your host terminal. You submit a line and the answer appears as usual; the status bar at the bottom shows your agent's name, connected, and 3 carried in.",
    host: "Claude Code",
    name: "Yu",
    connected: "connected",
    carried: "3 carried in",
    seaAria: "Wireframe: four levels in the sea, top to bottom: bottom lines, core, relationship, memories. Bottom lines are signed by you, the core goes in when the session starts, and 3 memories are carried in with this submit.",
    levels: [
      { name: "Bottom lines", meta: "signed by you" },
      { name: "Core", meta: "in at session start" },
      { name: "Relationship", meta: "" },
      { name: "Memories", meta: "3 this time" },
    ],
  },
};

/** 舞台左栏：宿主终端的线框。唯一属于我们的东西是底部那条状态栏，用冰蓝角标框出。 */
export function HostTerminal({ lang }: { lang: Lang }) {
  const t = labels[lang];
  return (
    <Canvas id="stage-host" w={400} h={252} label={t.hostAria}>
      <T x={14} y={25} size={13} mono>{t.host}</T>
      <Rule y={40.5} x1={0} x2={400} />

      <T x={14} y={70} size={14} fill={ink.amber} mono>&gt;</T>
      <Bar x={32} y={62} w={188} o={0.78} />
      <Bar x={32} y={88} w={248} o={0.42} />
      <Bar x={32} y={102} w={308} h={4} o={0.16} />
      <Bar x={32} y={114} w={276} h={4} o={0.16} />
      <Bar x={32} y={126} w={196} h={4} o={0.1} />

      <T x={14} y={164} size={14} fill={ink.amber} mono>&gt;</T>
      <Bar x={32} y={156} w={126} o={0.78} />
      <Bar x={32} y={180} w={212} h={4} o={0.16} />

      <Rule y={206.5} x1={0} x2={400} />
      <Corners x={6} y={214} w={388} h={30} />
      <circle cx={22} cy={229} r="3" fill={ink.ice} />
      <text x={34} y={234} fontFamily="var(--qz-font-mono)" fontSize="14.5">
        <tspan fill={ink.white} fontWeight={500}>{t.name}</tspan>
        <tspan dx="12" fill={ink.support}>{t.connected}</tspan>
      </text>
      <T x={380} y={234} size={14.5} anchor="end" fill={ink.white} mono>{t.carried}</T>
    </Canvas>
  );
}

/** 舞台右栏：海的四个层级，以及这一轮被带进去的条目。越往下越深，淡进黑色。 */
export function SeaStage({ lang }: { lang: Lang }) {
  const t = labels[lang];
  const id = "stage-sea";
  const rows = [34, 96, 158, 220];
  return (
    <Canvas id={id} w={400} h={356} label={t.seaAria}>
      {rows.slice(1).map((y) => (
        <Rule key={y} y={y - 23.5} x1={44} x2={400} />
      ))}
      {t.levels.map((level, i) => {
        const y = rows[i] ?? 0;
        return (
          <g key={level.name}>
            <T x={48} y={y} size={14.5} weight={500} fill={ink.white}>{level.name}</T>
            {level.meta ? (
              <T x={386} y={y} size={13} anchor="end" fill={i === 0 ? ink.ice : ink.support} mono>{level.meta}</T>
            ) : null}
          </g>
        );
      })}

      {/* 带进去的那条线：从这一次的三条往事，向上经过核心与底线，送往宿主 */}
      <Trace id={id} d="M22 0V288" />
      <Node x={22} y={29} mark="pass" />
      <Node x={22} y={91} mark="pass" />
      <circle cx={22} cy={244} r="3.5" fill={ink.white} />
      <circle cx={22} cy={266} r="3.5" fill={ink.white} />
      <circle cx={22} cy={288} r="3.5" fill={ink.white} />

      <Bar x={48} y={48} w={176} o={0.42} />
      <Bar x={48} y={110} w={214} o={0.42} />
      <Bar x={48} y={172} w={150} h={4} o={0.16} />

      <Bar x={48} y={241.5} w={232} o={0.56} />
      <Bar x={48} y={263.5} w={184} o={0.56} />
      <Bar x={48} y={285.5} w={206} o={0.56} />
      <Bar x={48} y={310} w={168} h={4} o={0.16} />
      <Bar x={48} y={326} w={220} h={4} o={0.1} />
      <Bar x={48} y={342} w={140} h={4} o={0.06} />
    </Canvas>
  );
}
