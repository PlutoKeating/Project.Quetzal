import type { Lang } from "~/i18n/core";
import { Bar, Box, Canvas, Corners, Node, Rule, T, Trace, Wire, ink, line } from "./kit";

/* ── 治理面：只有「看」和「签」的线框 ──────────────────────────────── */

type GovernanceLabels = {
  aria: string;
  pages: string[];
  lines: string;
  signed: string;
  pending: string;
  sign: string;
  waiting: string;
  note: string;
};

const governance: Record<Lang, GovernanceLabels> = {
  zh: {
    aria: "线框示意：治理面。左侧是六页——他、我、我们、往事、设备、记录。右侧是只读的内容；已签署的底线用冰蓝角标框出，新的一条等你亲手签署。整个界面没有输入框。",
    pages: ["他", "我", "我们", "往事", "设备", "记录"],
    lines: "底线",
    signed: "已签署",
    pending: "新的一条",
    sign: "签署",
    waiting: "等你亲手签",
    note: "只有看和签 · 没有输入框",
  },
  en: {
    aria: "Wireframe: the governance view. Six pages on the left: Agent, Me, Us, Memories, Devices, Records. Read-only content on the right; signed bottom lines are framed with ice corner marks, and a new one waits for you to sign by hand. There is no input box anywhere.",
    pages: ["Agent", "Me", "Us", "Memories", "Devices", "Records"],
    lines: "Bottom lines",
    signed: "signed",
    pending: "A new one",
    sign: "Sign",
    waiting: "waits for your hand",
    note: "look and sign · no input box",
  },
};

export function GovernanceWide({ lang }: { lang: Lang }) {
  const t = governance[lang];
  return (
    <Canvas id="governance-wide" w={760} h={300} label={t.aria}>
      <line x1="168.5" y1="0" x2="168.5" y2="300" stroke={line.edge} />
      <rect x="12" y="24" width="144" height="30" fill={ink.white} fillOpacity="0.06" />
      <line x1="12.75" y1="24" x2="12.75" y2="54" stroke={ink.white} strokeWidth="1.5" />
      {t.pages.map((page, i) => (
        <T key={page} x={28} y={44 + i * 38} size={14} weight={i === 0 ? 500 : undefined} fill={i === 0 ? ink.white : ink.secondary}>
          {page}
        </T>
      ))}

      <Bar x={200} y={34} w={132} h={8} o={0.78} />
      <Bar x={200} y={56} w={264} h={4} o={0.16} />

      <Corners x={200} y={84} w={276} h={116} />
      <T x={218} y={110} size={13} fill={ink.white} mono>{t.lines}</T>
      <T x={458} y={110} size={12.5} anchor="end" fill={ink.ice} mono>{t.signed}</T>
      <Bar x={218} y={128} w={206} o={0.45} />
      <Bar x={218} y={148} w={232} o={0.45} />
      <Bar x={218} y={168} w={168} o={0.45} />

      <Box x={500} y={84} w={236} h={116} />
      <T x={518} y={110} size={13} fill={ink.white} mono>{t.pending}</T>
      <Bar x={518} y={128} w={184} o={0.16} />
      <rect x="518" y="154" width="76" height="26" fill={ink.white} fillOpacity="0.9" />
      <T x={556} y={172} size={12.5} weight={500} anchor="middle" fill={ink.void}>{t.sign}</T>
      <Node x={612} y={167} mark="amber" />
      <T x={624} y={172} size={12.5} fill={ink.amber}>{t.waiting}</T>

      <Rule y={226.5} x1={200} x2={736} />
      <Bar x={200} y={246} w={92} o={0.26} />
      <Bar x={200} y={264} w={420} h={4} o={0.12} />
      <Bar x={200} y={276} w={340} h={4} o={0.08} />
      <T x={736} y={251} size={12.5} anchor="end" fill={ink.subtle} mono>{t.note}</T>
    </Canvas>
  );
}

export function GovernanceCompact({ lang }: { lang: Lang }) {
  const t = governance[lang];
  return (
    <Canvas id="governance-compact" w={360} h={410} label={t.aria}>
      <line x1="12.75" y1="20" x2="12.75" y2="46" stroke={ink.white} strokeWidth="1.5" />
      <text x="22" y="38" fontFamily="var(--qz-font-sans)" fontSize="13">
        {t.pages.map((page, i) => (
          <tspan key={page} dx={i === 0 ? 0 : 14} fill={i === 0 ? ink.white : ink.secondary} fontWeight={i === 0 ? 500 : undefined}>
            {page}
          </tspan>
        ))}
      </text>
      <Rule y={62.5} x1={0} x2={360} />

      <Bar x={16} y={86} w={132} h={8} o={0.78} />
      <Bar x={16} y={108} w={232} h={4} o={0.16} />

      <Corners x={16} y={134} w={328} h={108} />
      <T x={34} y={160} size={13} fill={ink.white} mono>{t.lines}</T>
      <T x={326} y={160} size={12.5} anchor="end" fill={ink.ice} mono>{t.signed}</T>
      <Bar x={34} y={178} w={206} o={0.45} />
      <Bar x={34} y={198} w={248} o={0.45} />
      <Bar x={34} y={218} w={168} o={0.45} />

      <Box x={16} y={264} w={328} h={100} />
      <T x={34} y={290} size={13} fill={ink.white} mono>{t.pending}</T>
      <Bar x={34} y={306} w={184} o={0.16} />
      <rect x="34" y="324" width="76" height="26" fill={ink.white} fillOpacity="0.9" />
      <T x={72} y={342} size={12.5} weight={500} anchor="middle" fill={ink.void}>{t.sign}</T>
      <Node x={128} y={337} mark="amber" />
      <T x={140} y={342} size={12.5} fill={ink.amber}>{t.waiting}</T>

      <T x={344} y={392} size={12} anchor="end" fill={ink.subtle} mono>{t.note}</T>
    </Canvas>
  );
}

/* ── 多设备：两台设备经 Hub 同步，Hub 只见密文 ─────────────────────── */

type TopologyLabels = {
  aria: string;
  a: string;
  aNote: string;
  hub: string;
  hubNote: string;
  b: string;
  bNote: string;
  cipher: string;
  blind: string;
};

const topology: Record<Lang, TopologyLabels> = {
  zh: {
    aria: "拓扑图：已有的设备与新设备经 Hub 同步。两台设备上读得到内容；Hub 只转发密文，看不到内容。",
    a: "已有的设备",
    aNote: "内容在这里读得到",
    hub: "Hub",
    hubNote: "只转发密文",
    b: "新设备",
    bNote: "配对后是同一个他",
    cipher: "密文",
    blind: "看不到内容",
  },
  en: {
    aria: "Topology: the device you already have and a new device sync through a Hub. Content is readable on the two devices; the Hub only relays ciphertext and cannot see the content.",
    a: "Your current device",
    aNote: "content is readable here",
    hub: "Hub",
    hubNote: "relays ciphertext only",
    b: "New device",
    bNote: "the same agent after pairing",
    cipher: "ciphertext",
    blind: "cannot see the content",
  },
};

export function TopologyWide({ lang }: { lang: Lang }) {
  const t = topology[lang];
  const id = "topology-wide";
  return (
    <Canvas id={id} w={760} h={212} label={t.aria}>
      <Trace id={id} d="M228 96H278" />
      <Trace id={id} d="M482 96H532" />
      <Box x={24} y={56} w={204} h={80} active />
      <Box x={278} y={56} w={204} h={80} />
      <Box x={532} y={56} w={204} h={80} active />
      <T x={42} y={90} size={15} weight={500} fill={ink.white}>{t.a}</T>
      <T x={42} y={114} size={13}>{t.aNote}</T>
      <T x={296} y={90} size={15} weight={500} fill={ink.white}>{t.hub}</T>
      <T x={296} y={114} size={13}>{t.hubNote}</T>
      <T x={550} y={90} size={15} weight={500} fill={ink.white}>{t.b}</T>
      <T x={550} y={114} size={13}>{t.bNote}</T>
      <T x={253} y={170} size={12.5} anchor="middle" fill={ink.bright} mono>{t.cipher}</T>
      <T x={507} y={170} size={12.5} anchor="middle" fill={ink.bright} mono>{t.cipher}</T>
      <Wire d="M253 104V154" dashed />
      <Wire d="M507 104V154" dashed />
      <T x={380} y={170} size={13} anchor="middle" fill={ink.subtle}>{t.blind}</T>
    </Canvas>
  );
}

export function TopologyCompact({ lang }: { lang: Lang }) {
  const t = topology[lang];
  const id = "topology-compact";
  return (
    <Canvas id={id} w={360} h={388} label={t.aria}>
      <Trace id={id} d="M72 104V152" />
      <Trace id={id} d="M72 232V280" />
      <Box x={24} y={28} w={312} h={76} active />
      <Box x={24} y={152} w={312} h={80} />
      <Box x={24} y={280} w={312} h={76} active />
      <T x={42} y={60} size={15} weight={500} fill={ink.white}>{t.a}</T>
      <T x={42} y={84} size={13}>{t.aNote}</T>
      <T x={42} y={184} size={15} weight={500} fill={ink.white}>{t.hub}</T>
      <T x={42} y={208} size={13}>{t.hubNote}</T>
      <T x={318} y={208} size={12.5} anchor="end" fill={ink.subtle}>{t.blind}</T>
      <T x={42} y={312} size={15} weight={500} fill={ink.white}>{t.b}</T>
      <T x={42} y={336} size={13}>{t.bNote}</T>
      <T x={90} y={133} size={12.5} fill={ink.bright} mono>{t.cipher}</T>
      <T x={90} y={261} size={12.5} fill={ink.bright} mono>{t.cipher}</T>
    </Canvas>
  );
}

/* ── 安全与信任：权威等级，以及每一级怎么改 ────────────────────────── */

type LevelsLabels = {
  aria: string;
  cols: [string, string, string];
  rows: { name: string; what: string; how: string }[];
};

const levels: Record<Lang, LevelsLabels> = {
  zh: {
    aria: "权威等级，自上而下：底线、核心、关系、往事。底线只有你的签名能改；其余三级由独立审查通过后才写回。",
    cols: ["等级", "是什么", "怎么改"],
    rows: [
      { name: "底线", what: "无论谁说什么都不变的几条", how: "只有你的签名" },
      { name: "核心", what: "他是谁，看重什么", how: "独立审查后写回" },
      { name: "关系", what: "你们之间", how: "独立审查后写回" },
      { name: "往事", what: "聊过的事，带出处", how: "独立审查后写回" },
    ],
  },
  en: {
    aria: "Authority levels, top to bottom: bottom lines, core, relationship, memories. Bottom lines change only with your signature; the other three are written back only after independent review.",
    cols: ["Level", "What it is", "How it changes"],
    rows: [
      { name: "Bottom lines", what: "the few things that never change", how: "your signature only" },
      { name: "Core", what: "who your agent is, what it values", how: "after independent review" },
      { name: "Relationship", what: "what is between you", how: "after independent review" },
      { name: "Memories", what: "what was said, with sources", how: "after independent review" },
    ],
  },
};

export function LevelsWide({ lang }: { lang: Lang }) {
  const t = levels[lang];
  const id = "levels-wide";
  const ys = [80, 128, 176, 224];
  return (
    <Canvas id={id} w={760} h={254} label={t.aria}>
      <T x={56} y={30} size={12.5} fill={ink.subtle} mono>{t.cols[0]}</T>
      <T x={236} y={30} size={12.5} fill={ink.subtle} mono>{t.cols[1]}</T>
      <T x={736} y={30} size={12.5} anchor="end" fill={ink.subtle} mono>{t.cols[2]}</T>
      <Rule y={46.5} x1={0} x2={760} />
      {ys.slice(1).map((y) => (
        <Rule key={y} y={y - 23.5} x1={56} x2={760} />
      ))}
      <Trace id={id} d="M28 80V224" />
      {t.rows.map((row, i) => {
        const y = ys[i] ?? 0;
        return (
          <g key={row.name}>
            <Node x={28} y={y} mark={i === 0 ? "end" : "pass"} />
            <T x={56} y={y + 5} size={15} weight={500} fill={ink.white}>{row.name}</T>
            <T x={236} y={y + 5} size={13.5}>{row.what}</T>
            <T x={736} y={y + 5} size={13.5} anchor="end" fill={i === 0 ? ink.ice : ink.bright}>{row.how}</T>
          </g>
        );
      })}
    </Canvas>
  );
}

export function LevelsCompact({ lang }: { lang: Lang }) {
  const t = levels[lang];
  const id = "levels-compact";
  const ys = [40, 110, 180, 250];
  return (
    <Canvas id={id} w={360} h={310} label={t.aria}>
      {ys.slice(1).map((y) => (
        <Rule key={y} y={y - 25.5} x1={50} x2={360} />
      ))}
      <Trace id={id} d="M28 40V250" />
      {t.rows.map((row, i) => {
        const y = ys[i] ?? 0;
        return (
          <g key={row.name}>
            <Node x={28} y={y} mark={i === 0 ? "end" : "pass"} />
            <T x={50} y={y + 5} size={15} weight={500} fill={ink.white}>{row.name}</T>
            <T x={344} y={y + 5} size={12.5} anchor="end" fill={i === 0 ? ink.ice : ink.bright}>{row.how}</T>
            <T x={50} y={y + 27} size={12.5}>{row.what}</T>
          </g>
        );
      })}
    </Canvas>
  );
}

/* ── 带走：一次导出，两样东西 ──────────────────────────────────────── */

type ExportLabels = {
  aria: string;
  sea: string;
  seaNote: string;
  readable: string;
  readableNote: string;
  sealed: string;
  sealedNote: string;
};

const exportSplit: Record<Lang, ExportLabels> = {
  zh: {
    aria: "拓扑图：从这台设备上的海，一次导出得到两样东西——人能直接读的文档，和可以原样恢复的密文。",
    sea: "海",
    seaNote: "在这台设备上",
    readable: "人能读的文档",
    readableNote: "直接打开就能读",
    sealed: "可恢复的密文",
    sealedNote: "原样恢复成同一个他",
  },
  en: {
    aria: "Topology: one export from the sea on this device yields two things: documents a person can read, and ciphertext that restores everything as it was.",
    sea: "The sea",
    seaNote: "on this device",
    readable: "Readable documents",
    readableNote: "open them and read",
    sealed: "Restorable ciphertext",
    sealedNote: "restores the same agent",
  },
};

function ExportBody({ id, t, cx, left, right, w }: { id: string; t: ExportLabels; cx: number; left: number; right: number; w: number }) {
  return (
    <Canvas id={id} w={w} h={236} label={t.aria}>
      <Trace id={id} d={`M${cx} 88V124H${left}V160`} />
      <Trace id={id} d={`M${cx} 124H${right}V160`} />
      <Box x={cx - 100} y={28} w={200} h={60} active solid />
      <T x={cx} y={54} size={15} weight={500} anchor="middle" fill={ink.white}>{t.sea}</T>
      <T x={cx} y={74} size={12.5} anchor="middle">{t.seaNote}</T>
      <T x={cx + 12} y={112} size={12.5} fill={ink.bright} mono>qz export</T>
      <Node x={left} y={164} mark="pass" />
      <Node x={right} y={164} mark="end" />
      <T x={left} y={196} size={14.5} weight={500} anchor="middle" fill={ink.white}>{t.readable}</T>
      <T x={left} y={216} size={12.5} anchor="middle">{t.readableNote}</T>
      <T x={right} y={196} size={14.5} weight={500} anchor="middle" fill={ink.white}>{t.sealed}</T>
      <T x={right} y={216} size={12.5} anchor="middle">{t.sealedNote}</T>
    </Canvas>
  );
}

export function ExportWide({ lang }: { lang: Lang }) {
  return <ExportBody id="export-wide" t={exportSplit[lang]} cx={380} left={190} right={570} w={760} />;
}

export function ExportCompact({ lang }: { lang: Lang }) {
  return <ExportBody id="export-compact" t={exportSplit[lang]} cx={180} left={90} right={270} w={360} />;
}
