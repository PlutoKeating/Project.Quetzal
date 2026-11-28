import type { Lang } from "~/i18n/core";
import { Box, Canvas, Cross, Ghost, Node, Rule, T, Trace, Wire, ink } from "./kit";

type Labels = {
  aria: string;
  host: string;
  hostMeta: string;
  sea: string;
  seaMeta: string;
  you: string;
  call: string;
  answer: string;
  carried: string;
  signal: string;
  review: string;
  written: string;
  s1: string;
  s2: string;
  s3: string;
};

const labels: Record<Lang, Labels> = {
  zh: {
    aria: "回路图。你在宿主里提交一句话。调用模型之前，海里的核心与相关往事被送进去；调用之后，输出被当作信号，经独立审查才写回海里。回答照常回到你手上。",
    host: "你的宿主",
    hostMeta: "对话与推理在这里",
    sea: "海",
    seaMeta: "在你的设备上",
    you: "你提交一句",
    call: "模型调用",
    answer: "回答照常给你",
    carried: "核心与相关往事",
    signal: "输出只是信号",
    review: "独立审查",
    written: "写回",
    s1: "01 送进去",
    s2: "02 当信号",
    s3: "03",
  },
  en: {
    aria: "Loop diagram. You submit a line in your host. Before the model call, the core and related memories are sent in from the sea; after the call, the output is treated as a signal and written back to the sea only after independent review. The answer comes back to you as usual.",
    host: "Your host",
    hostMeta: "conversation happens here",
    sea: "The sea",
    seaMeta: "on your devices",
    you: "you submit a line",
    call: "model call",
    answer: "the answer, as usual",
    carried: "core and related memories",
    signal: "output is only a signal",
    review: "independent review",
    written: "written back",
    s1: "01 sent in",
    s2: "02 a signal",
    s3: "03",
  },
};

/** 首页的回路图（宽版）：三站与下面的三格栅格逐列对齐。 */
export function LoopWide({ lang }: { lang: Lang }) {
  const t = labels[lang];
  const id = "loop-wide";
  return (
    <Canvas id={id} w={760} h={304} label={t.aria}>
      <Rule y={152.5} x1={0} x2={760} />
      <Ghost x={253.5} y1={0} y2={304} />
      <Ghost x={506.5} y1={0} y2={304} />
      <Cross x={253.5} y={152.5} />
      <Cross x={506.5} y={152.5} />

      <T x={16} y={34} size={16} weight={500} fill={ink.support}>{t.host}</T>
      <T x={744} y={34} size={12.5} anchor="end" mono>{t.hostMeta}</T>
      <T x={16} y={186} size={16} weight={500} fill={ink.white}>{t.sea}</T>
      <T x={744} y={186} size={12.5} anchor="end" fill={ink.bright} mono>{t.seaMeta}</T>

      {/* 宿主自己的那条线：你说的话 → 模型调用 → 回答。琥珀色的 > 表示「这是人说的」。 */}
      <T x={22} y={103} size={15} fill={ink.amber} mono>&gt;</T>
      <T x={22} y={74} size={13} fill={ink.subtle}>{t.you}</T>
      <Wire d="M42 98H127" />
      <Wire d="M380 98H736" />
      <T x={744} y={74} size={13} anchor="end">{t.answer}</T>

      {/* 海的底轨 */}
      <path d="M24 240H736" stroke={ink.white} strokeOpacity="0.18" />

      {/* 送进去 → 调用 → 当信号（虚线，尚未写入）→ 审查 → 写回 */}
      <Trace id={id} d="M127 240V98H380" />
      <Wire d="M380 98V240H506.5" dashed />
      <Trace id={id} d="M506.5 240H633" />

      <Box x={205.5} y={80} w={96} h={36} solid />
      <T x={253.5} y={103} size={13} anchor="middle" fill={ink.white} mono>{t.call}</T>

      <Node x={127} y={98} mark="pass" />
      <Node x={380} y={98} mark="pass" />
      <Node x={736} y={98} mark="later" />
      <Node x={127} y={240} mark="pass" />
      <Node x={380} y={240} mark="later" />
      <Node x={506.5} y={240} mark="amber" />
      <Node x={633} y={240} mark="end" />

      <T x={141} y={176} size={12.5} fill={ink.bright} mono>{t.s1}</T>
      <T x={394} y={176} size={12.5} mono>{t.s2}</T>
      <T x={633} y={216} size={12.5} anchor="middle" fill={ink.bright} mono>{t.s3}</T>

      <T x={127} y={272} size={13} anchor="middle" fill={ink.bright}>{t.carried}</T>
      <T x={380} y={272} size={13} anchor="middle">{t.signal}</T>
      <T x={506.5} y={216} size={13} anchor="middle" fill={ink.amber}>{t.review}</T>
      <T x={633} y={272} size={13.5} weight={500} anchor="middle" fill={ink.white}>{t.written}</T>
    </Canvas>
  );
}

/** 窄版：时间自上而下，左边是宿主，右边是海。 */
export function LoopCompact({ lang }: { lang: Lang }) {
  const t = labels[lang];
  const id = "loop-compact";
  return (
    <Canvas id={id} w={360} h={500} label={t.aria}>
      <T x={16} y={30} size={15} weight={500} fill={ink.support}>{t.host}</T>
      <T x={344} y={30} size={15} weight={500} anchor="end" fill={ink.white}>{t.sea}</T>
      <T x={16} y={50} size={11.5} mono>{t.hostMeta}</T>
      <T x={344} y={50} size={11.5} anchor="end" fill={ink.bright} mono>{t.seaMeta}</T>
      <Rule y={66.5} x1={0} x2={360} />

      <T x={64} y={98} size={15} anchor="middle" fill={ink.amber} mono>&gt;</T>
      <T x={82} y={97} size={12.5} fill={ink.subtle}>{t.you}</T>
      <Wire d="M64 108V160" />
      <Wire d="M64 318V456" />

      <path d="M304 108V456" stroke={ink.white} strokeOpacity="0.18" />

      <Trace id={id} d="M304 160H64V318" />
      <Wire d="M64 318H304V386" dashed />
      <Trace id={id} d="M304 386V456" />

      <Box x={16} y={221} w={96} h={36} solid />
      <T x={64} y={244} size={12.5} anchor="middle" fill={ink.white} mono>{t.call}</T>

      <Node x={304} y={160} mark="pass" />
      <Node x={64} y={160} mark="pass" />
      <Node x={64} y={318} mark="pass" />
      <Node x={304} y={318} mark="later" />
      <Node x={304} y={386} mark="amber" />
      <Node x={304} y={456} mark="end" />
      <Node x={64} y={456} mark="later" />

      <T x={184} y={148} size={12.5} anchor="middle" fill={ink.bright}>{t.carried}</T>
      <T x={184} y={180} size={12} anchor="middle" fill={ink.bright} mono>{t.s1}</T>
      <T x={184} y={306} size={12.5} anchor="middle">{t.signal}</T>
      <T x={184} y={338} size={12} anchor="middle" mono>{t.s2}</T>
      <T x={286} y={391} size={12.5} anchor="end" fill={ink.amber}>{t.review}</T>
      <T x={286} y={418} size={12} anchor="end" fill={ink.bright} mono>{t.s3}</T>
      <T x={286} y={439} size={13.5} weight={500} anchor="end" fill={ink.white}>{t.written}</T>
      <T x={82} y={461} size={12.5}>{t.answer}</T>
    </Canvas>
  );
}
