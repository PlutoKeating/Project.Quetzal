import { useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill } from "remotion";
import { archBlueprintMessages } from "./archBlueprintI18n";

export type BlueprintCopy = (typeof archBlueprintMessages)["zh"];

const v = (token: string) => `var(--ds-color-${token})`;

/**
 * Remotion Composition：单轮会话 6 阶段 22 步动态演示（900 帧 @ 30fps = 30 秒，每阶段 150 帧 = 5 秒）
 * 严格遵循 Remotion Markup Best Practices：
 * - 所有动画完全由 useCurrentFrame() + useVideoConfig() + interpolate() 驱动
 * - 不使用任何 CSS transition / Tailwind animate-* 类
 * - 视觉色值 100% 引用设计系统 CSS 变量 var(--ds-color-*)
 */
export const TurnLifecycleVideo: React.FC<{ t: BlueprintCopy }> = ({ t }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phaseFrames = 5 * fps; // 每个阶段 150 帧 (5s)
  const rawPhaseIndex = Math.floor(frame / phaseFrames);
  const phaseIndex = Math.min(5, Math.max(0, rawPhaseIndex));
  const localFrame = frame - phaseIndex * phaseFrames;

  const phase = t.turnView.phases[phaseIndex] ?? t.turnView.phases[0];

  // 舞台入场与脉冲插值
  const headerOpacity = interpolate(localFrame, [0, 0.35 * fps], [0.25, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const headerTranslateY = interpolate(localFrame, [0, 0.35 * fps], [14, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // 6 个阶段在架构拓扑中的高亮模块映射
  // 0: 交互入口, 1: 心脏/身体, 2: 大脑宿主, 3: 独立引擎 runTurn, 4: 动态上下文 ContextManager, 5: 结构化记忆 & PRIME, 6: MCP & 沙箱, 7: SQLite & 灵魂 Git
  const activeModulesByPhase: readonly (readonly number[])[] = [
    [0, 1, 2],       // Phase 1: 入口分流、保密拦截、插话/内省
    [2, 5, 7],       // Phase 2: 拉取灵魂、Dynamic System、历史基座附注
    [2, 3, 4, 5],    // Phase 3: 收件箱合并、Quick 语义选记忆、窗口克隆视图
    [3, 4],          // Phase 4: 路由与四协议流式 SSE、空回重试、循环判定
    [3, 6, 7],       // Phase 5: Guard 审批、沙箱/MCP 执行、输出脱敏与触碰同步
    [2, 5, 7],       // Phase 6: 回复落盘、100ms 异步 PRIME 蒸馏与灵魂推送
  ];
  const activeMods = activeModulesByPhase[phaseIndex] ?? [0];

  // 数据流光点在当前阶段内的归一化进度 [0, 1]
  const packetProgress = interpolate(localFrame, [0.2 * fps, 4.6 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const miniNodes = [
    { idx: 0, x: 36, y: 74, w: 230, h: 78, tag: "CLI / App / Feishu", name: t.nodes[0].title },
    { idx: 1, x: 290, y: 74, w: 230, h: 78, tag: "Body & Heart", name: t.nodes[1].title },
    { idx: 2, x: 36, y: 186, w: 230, h: 84, tag: "runtime/mind", name: t.nodes[2].title },
    { idx: 5, x: 290, y: 186, w: 230, h: 84, tag: "memory & PRIME", name: t.nodes[5].title },
    { idx: 3, x: 36, y: 304, w: 230, h: 88, tag: "engine/loop.ts", name: t.nodes[3].title },
    { idx: 4, x: 290, y: 304, w: 230, h: 88, tag: "engine/context", name: t.nodes[4].title },
    { idx: 6, x: 36, y: 424, w: 230, h: 82, tag: "guard / sandbox / MCP", name: t.nodes[6].title },
    { idx: 7, x: 290, y: 424, w: 230, h: 82, tag: "SQLite & Soul Git", name: t.nodes[7].title },
  ];

  // 每个阶段的数据包运动轨迹坐标点
  const phasePaths: readonly (readonly [number, number][])[] = [
    [[151, 113], [405, 113], [151, 228]],
    [[405, 465], [405, 228], [151, 228]],
    [[151, 228], [151, 348], [405, 228], [405, 348]],
    [[405, 348], [151, 348], [151, 228]],
    [[151, 348], [151, 465], [405, 465], [151, 348]],
    [[151, 228], [405, 465], [405, 228], [405, 465]],
  ];
  const pts = phasePaths[phaseIndex] ?? phasePaths[0];
  const segCount = pts.length - 1;
  const segFloat = packetProgress * segCount;
  const segIdx = Math.min(segCount - 1, Math.floor(segFloat));
  const segT = segFloat - segIdx;
  const pStart = pts[segIdx];
  const pEnd = pts[segIdx + 1] ?? pStart;
  const packetX = pStart[0] + (pEnd[0] - pStart[0]) * segT;
  const packetY = pStart[1] + (pEnd[1] - pStart[1]) * segT;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: v("bg"),
        color: v("fg"),
        fontFamily: "var(--ds-font-sans)",
        padding: 28,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        boxSizing: "border-box",
      }}
    >
      {/* 1. 顶部 6 阶段进度轨道条 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, 1fr)",
          gap: 10,
        }}
      >
        {t.turnView.phases.map((p, idx) => {
          const isCurrent = idx === phaseIndex;
          const isPast = idx < phaseIndex;
          const fillRatio = isCurrent
            ? interpolate(localFrame, [0, phaseFrames], [0, 100], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
            : isPast
              ? 100
              : 0;

          return (
            <div
              key={p.id}
              style={{
                backgroundColor: isCurrent ? v("surface-hover") : v("surface"),
                border: `1.5px solid ${isCurrent ? v("accent") : isPast ? v("border-strong") : v("border")}`,
                borderRadius: 12,
                padding: "10px 12px",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: 0,
                  height: 3,
                  width: `${fillRatio}%`,
                  backgroundColor: v("accent"),
                }}
              />
              <div
                style={{
                  fontSize: 12,
                  fontFamily: "var(--ds-font-mono)",
                  fontWeight: 700,
                  color: isCurrent ? v("accent") : v("fg-subtle"),
                }}
              >
                {p.stepRange}
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: isCurrent ? v("fg") : v("fg-muted"),
                  marginTop: 2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {p.badge.split(" · ")[1] ?? p.badge}
              </div>
            </div>
          );
        })}
      </div>

      {/* 2. 中央双栏主舞台：左侧实时架构拓扑 + 动态数据包，右侧当前阶段 4 步逐帧拆解 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "556px 1fr",
          gap: 20,
          height: 540,
          alignItems: "stretch",
        }}
      >
        {/* 左栏：架构拓扑与数据包运动动画 */}
        <div
          style={{
            backgroundColor: v("bg-elevated"),
            border: `1.5px solid ${v("border")}`,
            borderRadius: 18,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <svg viewBox="0 0 556 540" style={{ width: "100%", height: "100%", display: "block" }}>
            <text x="28" y="36" fontSize="14" fontWeight="600" fill={v("fg-subtle")}>
              {t.diagram.layers.host} / {t.diagram.layers.engine}
            </text>

            {/* エンジン循环高亮框 */}
            <rect
              x="22"
              y="288"
              width="512"
              height="118"
              rx="14"
              fill="none"
              stroke={phaseIndex >= 2 && phaseIndex <= 4 ? v("accent") : v("border")}
              strokeWidth={phaseIndex >= 2 && phaseIndex <= 4 ? "2" : "1"}
              strokeDasharray="6 4"
            />

            {/* 模块间的静态连线 */}
            <line x1="151" y1="152" x2="151" y2="186" stroke={v("border-strong")} strokeWidth="2" />
            <line x1="405" y1="152" x2="151" y2="186" stroke={v("border-strong")} strokeWidth="2" />
            <line x1="266" y1="228" x2="290" y2="228" stroke={v("border-strong")} strokeWidth="2" />
            <line x1="151" y1="270" x2="151" y2="304" stroke={v("border-strong")} strokeWidth="2" />
            <line x1="266" y1="348" x2="290" y2="348" stroke={v("border-strong")} strokeWidth="2" />
            <line x1="405" y1="270" x2="405" y2="304" stroke={v("border-strong")} strokeWidth="2" />
            <line x1="151" y1="392" x2="151" y2="424" stroke={v("border-strong")} strokeWidth="2" />
            <line x1="266" y1="465" x2="290" y2="465" stroke={v("border-strong")} strokeWidth="2" />

            {/* 当前阶段激活轨迹连线 */}
            {pts.map((pt, i) => {
              if (i === pts.length - 1) return null;
              const next = pts[i + 1];
              return (
                <line
                  key={i}
                  x1={pt[0]}
                  y1={pt[1]}
                  x2={next[0]}
                  y2={next[1]}
                  stroke={v("accent")}
                  strokeWidth="3"
                  strokeOpacity="0.65"
                />
              );
            })}

            {/* 8 个子系统节点 */}
            {miniNodes.map((n) => {
              const isAct = activeMods.includes(n.idx);
              return (
                <g key={n.idx}>
                  <rect
                    x={n.x}
                    y={n.y}
                    width={n.w}
                    height={n.h}
                    rx="12"
                    fill={isAct ? v("surface-hover") : v("surface")}
                    stroke={isAct ? v("accent") : v("border")}
                    strokeWidth={isAct ? "2.5" : "1.5"}
                  />
                  <text
                    x={n.x + 14}
                    y={n.y + 24}
                    fontSize="11.5"
                    fontFamily="var(--ds-font-mono)"
                    fontWeight="600"
                    fill={isAct ? v("accent") : v("fg-subtle")}
                  >
                    {n.tag}
                  </text>
                  <text
                    x={n.x + 14}
                    y={n.y + 52}
                    fontSize="15"
                    fontWeight="700"
                    fill={isAct ? v("fg") : v("fg-muted")}
                  >
                    {n.name.slice(0, 15)}
                  </text>
                </g>
              );
            })}

            {/* 实时运动的数据流脉冲光球 */}
            <circle cx={packetX} cy={packetY} r="14" fill={v("accent-soft")} />
            <circle cx={packetX} cy={packetY} r="6.5" fill={v("accent")} />
          </svg>
        </div>

        {/* 右栏：当前阶段标题 + 4 个顺序步骤卡片逐个弹簧入场 */}
        <div
          style={{
            backgroundColor: v("bg-elevated"),
            border: `1.5px solid ${v("border")}`,
            borderRadius: 18,
            padding: "22px 26px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          {/* 阶段头部 */}
          <div
            style={{
              opacity: headerOpacity,
              translate: `0px ${headerTranslateY}px`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span
                style={{
                  backgroundColor: v("accent-soft"),
                  color: v("accent"),
                  border: `1px solid ${v("accent")}`,
                  borderRadius: 999,
                  padding: "3px 12px",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {phase.badge}
              </span>
              <span
                style={{
                  fontFamily: "var(--ds-font-mono)",
                  fontSize: 13,
                  color: v("secondary-fg"),
                  backgroundColor: v("code-bg"),
                  padding: "3px 10px",
                  borderRadius: 6,
                }}
              >
                {phase.sub}
              </span>
            </div>

            <div style={{ fontSize: 25, fontWeight: 700, color: v("fg"), marginTop: 10 }}>
              {phase.title}
            </div>
            <div style={{ fontSize: 14.5, color: v("fg-muted"), marginTop: 4, lineHeight: 1.45 }}>
              {phase.summary}
            </div>
          </div>

          {/* 4 个步骤逐帧高亮入场 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
            {phase.fnList.map((fnText, idx) => {
              const stepStart = idx * 0.85 * fps;
              const stepOpacity = interpolate(localFrame, [stepStart, stepStart + 0.4 * fps], [0.18, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              });
              const stepX = interpolate(localFrame, [stepStart, stepStart + 0.4 * fps], [18, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              });
              const isStepActive =
                localFrame >= stepStart &&
                (idx === phase.fnList.length - 1 || localFrame < (idx + 1) * 0.85 * fps);

              const [head, ...rest] = fnText.split("：");
              const body = rest.join("：");

              return (
                <div
                  key={fnText}
                  style={{
                    opacity: stepOpacity,
                    translate: `${stepX}px 0px`,
                    backgroundColor: isStepActive ? v("surface-hover") : v("surface"),
                    border: `1.5px solid ${isStepActive ? v("accent") : v("border")}`,
                    borderRadius: 12,
                    padding: "11px 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                  }}
                >
                  <div
                    style={{
                      fontSize: 14.5,
                      fontWeight: 700,
                      color: isStepActive ? v("accent") : v("fg"),
                      fontFamily: "var(--ds-font-mono)",
                    }}
                  >
                    {head}
                  </div>
                  <div style={{ fontSize: 13.5, color: v("fg-muted"), lineHeight: 1.4 }}>
                    {body}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 3. 底部条件分支与防故障守卫条 */}
      <div
        style={{
          backgroundColor: v("surface"),
          border: `1.5px solid ${v("border-strong")}`,
          borderRadius: 14,
          padding: "12px 18px",
          display: "grid",
          gridTemplateColumns: `repeat(${phase.branches.length}, 1fr)`,
          gap: 16,
        }}
      >
        {phase.branches.map((branch) => (
          <div key={branch} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, lineHeight: 1.45, color: v("fg-muted") }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                backgroundColor: v("accent"),
                marginTop: 5,
                flexShrink: 0,
              }}
            />
            <span>{branch}</span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Remotion Composition：四层系统架构与 5 条端到端业务流动画（750 帧 @ 30fps = 25 秒，每条流 150 帧 = 5 秒）
 */
export const SystemArchVideo: React.FC<{ t: BlueprintCopy }> = ({ t }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 轮播 5 条核心业务流（flows[1..5]）
  const flows = t.flows.slice(1);
  const flowFrames = 5 * fps;
  const flowIdx = Math.min(flows.length - 1, Math.max(0, Math.floor(frame / flowFrames)));
  const localFrame = frame - flowIdx * flowFrames;
  const activeFlow = flows[flowIdx] ?? flows[0];

  const flowNodeMap: Record<string, readonly number[]> = {
    loop: [1, 2, 3],
    context: [2, 3, 4, 5, 7],
    memory: [2, 4, 5, 7],
    mcp: [3, 6, 7],
    tui: [0, 2, 6, 7],
  };
  const activeIndices = flowNodeMap[activeFlow.id] ?? [0, 1, 2, 3];

  const layers = [
    { title: t.diagram.layers.clients, nodes: [0, 1] },
    { title: t.diagram.layers.host, nodes: [2, 5, 6] },
    { title: t.diagram.layers.engine, nodes: [3, 4] },
    { title: t.diagram.layers.storage, nodes: [7] },
  ];

  return (
    <AbsoluteFill
      style={{
        backgroundColor: v("bg"),
        color: v("fg"),
        fontFamily: "var(--ds-font-sans)",
        padding: 28,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        boxSizing: "border-box",
      }}
    >
      {/* 顶部 5 条业务流指示器 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
        {flows.map((f, i) => {
          const isCur = i === flowIdx;
          return (
            <div
              key={f.id}
              style={{
                backgroundColor: isCur ? v("accent-soft") : v("surface"),
                border: `1.5px solid ${isCur ? v("accent") : v("border")}`,
                borderRadius: 12,
                padding: "10px 14px",
                color: isCur ? v("accent") : v("fg-muted"),
                fontSize: 14,
                fontWeight: 700,
                textAlign: "center",
              }}
            >
              {f.label}
            </div>
          );
        })}
      </div>

      {/* 中间：左侧四层架构卡片，右侧当前业务流的 5 个步骤逐帧高亮 */}
      <div style={{ display: "grid", gridTemplateColumns: "660px 1fr", gap: 20, height: 610 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 10 }}>
          {layers.map((layer, lIdx) => (
            <div
              key={layer.title}
              style={{
                backgroundColor: v("bg-elevated"),
                border: `1.5px ${lIdx === 2 ? "dashed" : "solid"} ${lIdx === 2 ? v("accent") : v("border")}`,
                borderRadius: 14,
                padding: "10px 14px",
                flex: 1,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: lIdx === 2 ? v("accent") : v("fg-subtle") }}>
                {layer.title}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${layer.nodes.length}, 1fr)`, gap: 10 }}>
                {layer.nodes.map((nIdx) => {
                  const node = t.nodes[nIdx];
                  const isHi = activeIndices.includes(nIdx);
                  return (
                    <div
                      key={node.id}
                      style={{
                        backgroundColor: isHi ? v("surface-hover") : v("surface"),
                        border: `1.5px solid ${isHi ? v("accent") : v("border")}`,
                        borderRadius: 10,
                        padding: "10px 12px",
                      }}
                    >
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: isHi ? v("accent") : v("secondary-fg") }}>
                        {node.badge}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: v("fg"), marginTop: 2 }}>
                        {node.title}
                      </div>
                      <div style={{ fontSize: 11.5, fontFamily: "var(--ds-font-mono)", color: v("fg-muted"), marginTop: 2 }}>
                        {node.sub}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            backgroundColor: v("bg-elevated"),
            border: `1.5px solid ${v("border")}`,
            borderRadius: 16,
            padding: "22px 24px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: v("accent") }}>{activeFlow.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: v("fg"), marginTop: 4 }}>{t.flowStepsTitle}</div>
            <div style={{ fontSize: 14, color: v("fg-muted"), marginTop: 4, lineHeight: 1.45 }}>{activeFlow.summary}</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {activeFlow.steps.map((step, sIdx) => {
              const startF = sIdx * 0.75 * fps;
              const op = interpolate(localFrame, [startF, startF + 0.35 * fps], [0.2, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });
              const activeStep = localFrame >= startF && (sIdx === activeFlow.steps.length - 1 || localFrame < (sIdx + 1) * 0.75 * fps);
              return (
                <div
                  key={step}
                  style={{
                    opacity: op,
                    backgroundColor: activeStep ? v("surface-hover") : v("surface"),
                    border: `1.5px solid ${activeStep ? v("accent") : v("border")}`,
                    borderRadius: 12,
                    padding: "12px 14px",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 999,
                      backgroundColor: v("accent-soft"),
                      color: v("accent"),
                      fontFamily: "var(--ds-font-mono)",
                      fontSize: 13,
                      fontWeight: 700,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {sIdx + 1}
                  </span>
                  <span style={{ fontSize: 13.5, color: v("fg"), lineHeight: 1.45 }}>{step}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
