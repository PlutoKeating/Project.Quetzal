import type { Lang } from "~/i18n/core";
import { Canvas, Cross, Drift, Ghost, type Mark, Node, Rule, T, Trace, Wire, ink } from "./kit";

type Step = { label: string; note?: string; mark: Mark };
type Row = { title: string; meta?: string; weak?: boolean; steps: Step[] };
type Spec = { aria: string; rows: Row[] };

function labelFill(step: Step, weak: boolean | undefined): string {
  if (step.mark === "amber") return ink.amber;
  if (step.mark === "end") return ink.white;
  return weak ? ink.subtle : ink.bright;
}

const hasNotes = (row: Row) => row.steps.some((s) => s.note);

/** 宽版：每行一条横向轨迹。弱化的一行是灰色虚线，主行是白色实线加冰蓝辉光。 */
function Wide({ id, spec }: { id: string; spec: Spec }) {
  const w = 760;
  const heights = spec.rows.map((row) => (hasNotes(row) ? 158 : 140));
  const h = heights.reduce((a, b) => a + b, 0);
  const many = spec.rows.length > 1;
  let top = 0;
  return (
    <Canvas id={id} w={w} h={h} label={spec.aria}>
      {spec.rows.map((row, r) => {
        const y0 = top;
        const rowH = heights[r] ?? 140;
        top += rowH;
        const n = row.steps.length;
        const xs = row.steps.map((_, i) => 24 + (i * 712) / Math.max(1, n - 1));
        const y = y0 + 84;
        const wobble = [0, -12, 8, -4, 6];
        const ys = row.steps.map((_, i) => (row.weak ? y + (wobble[i % wobble.length] ?? 0) : y));
        const segments = xs.slice(0, -1).map((x, i) => {
          const x2 = xs[i + 1] ?? x;
          const y1 = ys[i] ?? y;
          const y2 = ys[i + 1] ?? y;
          const mid = (x2 - x) / 2;
          return { d: row.weak ? `M${x} ${y1}C${x + mid} ${y1} ${x2 - mid} ${y2} ${x2} ${y2}` : `M${x} ${y1}H${x2}`, later: row.steps[i + 1]?.mark === "later" };
        });
        return (
          <g key={row.title}>
            {r > 0 ? <Rule y={y0 + 0.5} x1={0} x2={w} /> : null}
            {many
              ? xs.slice(1, -1).map((x) => (
                  <g key={x}>
                    <Ghost x={Math.round(x) + 0.5} y1={y0} y2={y0 + rowH} />
                    {r > 0 ? <Cross x={Math.round(x) + 0.5} y={y0 + 0.5} /> : null}
                  </g>
                ))
              : null}
            <T x={16} y={y0 + 34} size={16} weight={500} fill={row.weak ? ink.support : ink.white}>{row.title}</T>
            {row.meta ? (
              <T x={744} y={y0 + 34} size={12.5} anchor="end" fill={row.weak ? ink.support : ink.bright} mono>{row.meta}</T>
            ) : null}
            {segments.map((s) =>
              row.weak ? <Drift key={s.d} d={s.d} /> : s.later ? <Wire key={s.d} d={s.d} dashed /> : <Trace key={s.d} id={id} d={s.d} />,
            )}
            {row.steps.map((step, i) => {
              const x = xs[i] ?? 0;
              const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
              const tx = i === 0 ? 16 : i === n - 1 ? 744 : x;
              return (
                <g key={step.label}>
                  <Node x={x} y={ys[i] ?? y} mark={step.mark} />
                  <T x={tx} y={y0 + 120} size={13.5} weight={step.mark === "end" ? 500 : undefined} anchor={anchor} fill={labelFill(step, row.weak)}>
                    {step.label}
                  </T>
                  {step.note ? <T x={tx} y={y0 + 139} size={12.5} anchor={anchor} fill={ink.secondary}>{step.note}</T> : null}
                </g>
              );
            })}
          </g>
        );
      })}
    </Canvas>
  );
}

/** 窄版：每行一条竖向轨迹，文字在节点右侧。 */
function Compact({ id, spec }: { id: string; spec: Spec }) {
  const w = 360;
  const layout = spec.rows.map((row) => {
    const step = hasNotes(row) ? 58 : 44;
    return { step, height: 66 + (row.steps.length - 1) * step + (hasNotes(row) ? 44 : 30) };
  });
  const h = layout.reduce((a, b) => a + b.height, 0);
  let top = 0;
  return (
    <Canvas id={id} w={w} h={h} label={spec.aria}>
      {spec.rows.map((row, r) => {
        const y0 = top;
        const { step: gap, height } = layout[r] ?? { step: 44, height: 0 };
        top += height;
        const ys = row.steps.map((_, i) => y0 + 70 + i * gap);
        const segments = ys.slice(0, -1).map((y, i) => ({ d: `M28 ${y}V${ys[i + 1] ?? y}`, later: row.steps[i + 1]?.mark === "later" }));
        return (
          <g key={row.title}>
            {r > 0 ? <Rule y={y0 + 0.5} x1={0} x2={w} /> : null}
            <T x={16} y={y0 + 32} size={15} weight={500} fill={row.weak ? ink.support : ink.white}>{row.title}</T>
            {row.meta ? (
              <T x={344} y={y0 + 32} size={12} anchor="end" fill={row.weak ? ink.support : ink.bright} mono>{row.meta}</T>
            ) : null}
            {segments.map((s) =>
              row.weak ? <Drift key={s.d} d={s.d} /> : s.later ? <Wire key={s.d} d={s.d} dashed /> : <Trace key={s.d} id={id} d={s.d} />,
            )}
            {row.steps.map((step, i) => {
              const y = ys[i] ?? 0;
              return (
                <g key={step.label}>
                  <Node x={28} y={y} mark={step.mark} />
                  <T x={50} y={y + 5} size={14} weight={step.mark === "end" ? 500 : undefined} fill={labelFill(step, row.weak)}>{step.label}</T>
                  {step.note ? <T x={50} y={y + 24} size={12.5} fill={ink.secondary}>{step.note}</T> : null}
                </g>
              );
            })}
          </g>
        );
      })}
    </Canvas>
  );
}

/** 文档总览：从安装到看见他只有三步；其余的等需要时再读。 */
const journey: Record<Lang, Spec> = {
  zh: {
    aria: "时间线：安装，接上宿主，打开宿主时他在了。之后的治理面与带走，等需要时再用。",
    rows: [
      {
        title: "从安装到他在",
        meta: "三步",
        steps: [
          { label: "安装", note: "一行命令", mark: "pass" },
          { label: "接上宿主", note: "安装时自动完成", mark: "pass" },
          { label: "打开宿主，他在了", note: "状态栏上有他的名字", mark: "end" },
          { label: "治理面", note: "看和签", mark: "later" },
          { label: "带走", note: "导出与恢复", mark: "later" },
        ],
      },
    ],
  },
  en: {
    aria: "Timeline: install, connect a host, open the host and your agent is there. The governance view and export come later, when you need them.",
    rows: [
      {
        title: "From install to there",
        meta: "three steps",
        steps: [
          { label: "Install", note: "one command", mark: "pass" },
          { label: "Connect a host", note: "done by the installer", mark: "pass" },
          { label: "Open the host", note: "the name is in the status bar", mark: "end" },
          { label: "Governance view", note: "look and sign", mark: "later" },
          { label: "Export", note: "take it with you", mark: "later" },
        ],
      },
    ],
  },
};

/** 安装页：安装器按这个顺序做事，任何一步对不上都不会继续。 */
const installer: Record<Lang, Spec> = {
  zh: {
    aria: "时间线：安装器先验证签名，再核对内容，然后安装，最后一步把它接进本机已有的宿主。",
    rows: [
      {
        title: "安装器做的事",
        meta: "按顺序",
        steps: [
          { label: "验证签名", mark: "pass" },
          { label: "核对内容", mark: "pass" },
          { label: "安装", mark: "pass" },
          { label: "接进宿主", mark: "end" },
        ],
      },
    ],
  },
  en: {
    aria: "Timeline: the installer verifies the signature, checks the contents, installs, and as its last step connects it to the hosts already on this machine.",
    rows: [
      {
        title: "What the installer does",
        meta: "in order",
        steps: [
          { label: "Verify the signature", mark: "pass" },
          { label: "Check the contents", mark: "pass" },
          { label: "Install", mark: "pass" },
          { label: "Connect the host", mark: "end" },
        ],
      },
    ],
  },
};

/** 接上宿主页：接上之后一次会话里发生的事；它出故障时宿主照常工作。 */
const session: Record<Lang, Spec> = {
  zh: {
    aria: "轨迹对比。上方：它出故障时，带入这一步被跳过，宿主照常工作。下方：接上之后，会话开始带入他的核心，每次提交带入相关往事，宿主压缩对话后核心还在。",
    rows: [
      {
        title: "它出故障时",
        meta: "宿主不受影响",
        weak: true,
        steps: [
          { label: "会话开始", mark: "neutral" },
          { label: "这一步被跳过", mark: "amber" },
          { label: "宿主照常工作", mark: "later" },
        ],
      },
      {
        title: "接上之后",
        meta: "同一个他",
        steps: [
          { label: "会话开始", note: "带入他的核心", mark: "pass" },
          { label: "每次提交", note: "带入相关往事", mark: "pass" },
          { label: "宿主压缩对话后", note: "核心还在", mark: "end" },
        ],
      },
    ],
  },
  en: {
    aria: "Trajectory comparison. Top: when it fails, the carry-in step is skipped and the host keeps working. Bottom: once connected, the core goes in when a session starts, related memories go in with every submit, and the core is still there after the host compacts the conversation.",
    rows: [
      {
        title: "When it fails",
        meta: "the host is unaffected",
        weak: true,
        steps: [
          { label: "Session starts", mark: "neutral" },
          { label: "This step is skipped", mark: "amber" },
          { label: "The host keeps working", mark: "later" },
        ],
      },
      {
        title: "Once connected",
        meta: "the same agent",
        steps: [
          { label: "Session starts", note: "the core goes in", mark: "pass" },
          { label: "Every submit", note: "related memories go in", mark: "pass" },
          { label: "After compaction", note: "the core is still there", mark: "end" },
        ],
      },
    ],
  },
};

/** 首页「它不是什么」：又一个聊天框会带来的三件事，对照它实际的样子。 */
const boundary: Record<Lang, Spec> = {
  zh: {
    aria: "轨迹对比。上方，它不是这样：多一个聊天窗口，多一份模型账单，记忆留在别人的云上。下方，它是这样：对话在你的宿主里，模型是宿主的那一份，数据在你的设备上。",
    rows: [
      {
        title: "它不是这样",
        meta: "又一个聊天框",
        weak: true,
        steps: [
          { label: "多一个聊天窗口", mark: "neutral" },
          { label: "多一份模型账单", mark: "amber" },
          { label: "记忆留在别人的云上", mark: "fail" },
        ],
      },
      {
        title: "它是这样",
        meta: "接在你的宿主上",
        steps: [
          { label: "对话在你的宿主里", note: "它没有聊天界面", mark: "pass" },
          { label: "模型是宿主的那一份", note: "它不供应模型", mark: "pass" },
          { label: "数据在你的设备上", note: "同步的只有密文", mark: "end" },
        ],
      },
    ],
  },
  en: {
    aria: "Trajectory comparison. Top, what it is not: one more chat window, one more model bill, memory kept in someone else's cloud. Bottom, what it is: conversation stays in your host, the model is your host's, the data is on your devices.",
    rows: [
      {
        title: "It is not this",
        meta: "one more chat box",
        weak: true,
        steps: [
          { label: "One more chat window", mark: "neutral" },
          { label: "One more model bill", mark: "amber" },
          { label: "Memory in someone else's cloud", mark: "fail" },
        ],
      },
      {
        title: "It is this",
        meta: "connected to your host",
        steps: [
          { label: "Conversation stays in your host", note: "it has no chat interface", mark: "pass" },
          { label: "The model is your host's", note: "it provides no model", mark: "pass" },
          { label: "The data is on your devices", note: "only ciphertext syncs", mark: "end" },
        ],
      },
    ],
  },
};

const specs = { journey, installer, session, boundary } as const;
export type TrajectoryId = keyof typeof specs;

export function TrajectoryWide({ id, lang }: { id: TrajectoryId; lang: Lang }) {
  return <Wide id={`${id}-wide`} spec={specs[id][lang]} />;
}

export function TrajectoryCompact({ id, lang }: { id: TrajectoryId; lang: Lang }) {
  return <Compact id={`${id}-compact`} spec={specs[id][lang]} />;
}
