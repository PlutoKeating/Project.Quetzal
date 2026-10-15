import { useState } from "react";
import { Badge, Button, Card, cx } from "~/design-system/components";
import { useMessages } from "~/i18n/core";
import { archBlueprintMessages } from "./archBlueprintI18n";
import { Lightbox } from "./Lightbox";

type ViewMode = "turn" | "arch";
type PhaseId = "p1" | "p2" | "p3" | "p4" | "p5" | "p6";
type FlowId = "all" | "loop" | "context" | "memory" | "mcp" | "tui";
type NodeId =
  | "clients"
  | "body_heart"
  | "brain_host"
  | "engine_loop"
  | "context_mgr"
  | "memory_prime"
  | "mcp_sandbox"
  | "storage_mesh";

const FLOW_NODES: Record<FlowId, readonly NodeId[]> = {
  all: ["clients", "body_heart", "brain_host", "engine_loop", "context_mgr", "memory_prime", "mcp_sandbox", "storage_mesh"],
  loop: ["body_heart", "brain_host", "engine_loop"],
  context: ["brain_host", "engine_loop", "context_mgr", "memory_prime", "storage_mesh"],
  memory: ["brain_host", "context_mgr", "memory_prime", "storage_mesh"],
  mcp: ["engine_loop", "mcp_sandbox", "storage_mesh"],
  tui: ["clients", "brain_host", "mcp_sandbox", "storage_mesh"],
};

const NODE_LAYOUT: Record<NodeId, { x: number; y: number; w: number; h: number }> = {
  clients: { x: 48, y: 66, w: 720, h: 108 },
  body_heart: { x: 832, y: 66, w: 720, h: 108 },
  brain_host: { x: 48, y: 248, w: 460, h: 138 },
  memory_prime: { x: 550, y: 248, w: 490, h: 138 },
  mcp_sandbox: { x: 1082, y: 248, w: 470, h: 138 },
  engine_loop: { x: 80, y: 468, w: 660, h: 136 },
  context_mgr: { x: 820, y: 468, w: 700, h: 136 },
  storage_mesh: { x: 48, y: 676, w: 1504, h: 112 },
};

const PHASE_LAYOUT: Record<PhaseId, { x: number; y: number; w: number; h: number }> = {
  p1: { x: 36, y: 56, w: 1528, h: 112 },
  p2: { x: 36, y: 196, w: 1528, h: 104 },
  p3: { x: 64, y: 356, w: 1472, h: 116 },
  p4: { x: 64, y: 500, w: 1472, h: 116 },
  p5: { x: 64, y: 644, w: 1472, h: 116 },
  p6: { x: 36, y: 816, w: 1528, h: 116 },
};

interface EdgeDef {
  id: string;
  d: string;
  lx: number;
  ly: number;
  labelKey: keyof (typeof archBlueprintMessages)["zh"]["diagram"]["edges"];
  flows: readonly FlowId[];
}

const EDGES: readonly EdgeDef[] = [
  { id: "e_tui", d: "M 278 174 L 278 244", lx: 278, ly: 204, labelKey: "wsRpc", flows: ["all", "tui", "loop"] },
  { id: "e_wake", d: "M 960 174 C 960 206, 420 206, 420 244", lx: 690, ly: 198, labelKey: "converseWake", flows: ["all", "loop"] },
  { id: "e_turn", d: "M 278 386 L 278 464", lx: 278, ly: 424, labelKey: "runTurn", flows: ["all", "loop", "context"] },
  { id: "e_ctx", d: "M 740 536 L 816 536", lx: 778, ly: 520, labelKey: "prepareCtx", flows: ["all", "context", "loop"] },
  { id: "e_mem", d: "M 920 386 L 1060 464", lx: 1015, ly: 424, labelKey: "selectMem", flows: ["all", "context", "memory"] },
  { id: "e_prime", d: "M 508 316 L 546 316", lx: 527, ly: 296, labelKey: "primeAsync", flows: ["all", "memory"] },
  { id: "e_mcp", d: "M 640 468 C 640 426, 1280 426, 1280 390", lx: 1120, ly: 438, labelKey: "callTool", flows: ["all", "mcp", "loop"] },
  { id: "e_soul", d: "M 795 386 L 795 672", lx: 795, ly: 642, labelKey: "soulTouch", flows: ["all", "memory", "mcp", "tui"] },
];

export function ArchitectureBlueprint() {
  const t = useMessages(archBlueprintMessages);
  const [viewMode, setViewMode] = useState<ViewMode>("turn");
  const [selectedPhaseId, setSelectedPhaseId] = useState<PhaseId>("p3");
  const [activeFlow, setActiveFlow] = useState<FlowId>("all");
  const [selectedNodeId, setSelectedNodeId] = useState<NodeId>("engine_loop");
  const [zoomOpen, setZoomOpen] = useState(false);

  const activeFlowObj = t.flows.find((f) => f.id === activeFlow) ?? t.flows[0];
  const selectedNode = t.nodes.find((n) => n.id === selectedNodeId) ?? t.nodes[0];
  const selectedPhase = t.turnView.phases.find((p) => p.id === selectedPhaseId) ?? t.turnView.phases[0];
  const highlightedNodes = new Set(FLOW_NODES[activeFlow]);

  const selectFlow = (id: FlowId) => {
    setActiveFlow(id);
    const candidates = FLOW_NODES[id];
    if (!candidates.includes(selectedNodeId)) {
      setSelectedNodeId(candidates[0]);
    }
  };

  /** 视图 A：单轮会话 6 阶段 22 步全链路时序泳道 SVG */
  const renderTurnSvg = (interactive: boolean) => (
    <svg
      viewBox="0 0 1600 960"
      role="img"
      aria-label={t.viewModes.turn}
      className="block h-auto w-full select-none font-sans"
    >
      <defs>
        <marker id="tl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" className="fill-fg-muted" />
        </marker>
        <marker id="tl-arrow-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" className="fill-accent" />
        </marker>
      </defs>

      <rect width="1600" height="960" rx="20" className="fill-bg" />

      {/* 顶部时间轴说明 */}
      <text x="40" y="34" fontSize="14" className="fill-accent font-semibold tracking-wide">
        {t.viewModes.turn}
      </text>
      <text x="1560" y="34" textAnchor="end" fontSize="12.5" className="fill-fg-subtle font-mono">
        converse() / wake() → engine.runTurn() → learnTurn()
      </text>

      {/* 中央多步循环外框（包裹 Phase 3 / Phase 4 / Phase 5） */}
      <rect
        x="36"
        y="322"
        width="1528"
        height="462"
        rx="18"
        strokeWidth="2"
        strokeDasharray="8 5"
        className="fill-bg-elevated stroke-accent"
      />
      <text x="64" y="344" fontSize="13" className="fill-accent font-semibold font-mono">
        LOOP: engine/src/loop.ts · runTurn() — Step i = 1, 2, 3… ({t.turnView.svgLabels.loopBack})
      </text>

      {/* 阶段之间的主干流向箭头 */}
      <line x1="480" y1="168" x2="480" y2="192" strokeWidth="2" markerEnd="url(#tl-arrow-accent)" className="stroke-accent" />
      <line x1="480" y1="300" x2="480" y2="352" strokeWidth="2" markerEnd="url(#tl-arrow-accent)" className="stroke-accent" />
      <line x1="480" y1="472" x2="480" y2="496" strokeWidth="2" markerEnd="url(#tl-arrow-accent)" className="stroke-accent" />
      <line x1="480" y1="616" x2="480" y2="640" strokeWidth="2" markerEnd="url(#tl-arrow-accent)" className="stroke-accent" />
      <line x1="480" y1="760" x2="480" y2="812" strokeWidth="2" markerEnd="url(#tl-arrow-accent)" className="stroke-accent" />

      {/* 右侧回环线：Phase 5 (Step 18) 回到 Phase 3 (Step 08) */}
      <path
        d="M 1536 702 L 1554 702 L 1554 414 L 1540 414"
        fill="none"
        strokeWidth="2.5"
        markerEnd="url(#tl-arrow-accent)"
        className="stroke-accent"
      />

      {/* 六大阶段卡片与内部 22 步微节点 */}
      {t.turnView.phases.map((phase) => {
        const id = phase.id as PhaseId;
        const box = PHASE_LAYOUT[id];
        const isSelected = selectedPhaseId === id;

        return (
          <g
            key={id}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={`${phase.badge} - ${phase.title}`}
            onClick={interactive ? () => setSelectedPhaseId(id) : undefined}
            onKeyDown={
              interactive
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedPhaseId(id);
                    }
                  }
                : undefined
            }
            className={cx(interactive && "cursor-pointer")}
          >
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              rx="14"
              strokeWidth={isSelected ? "2.5" : "1.5"}
              className={cx(
                isSelected ? "fill-surface-hover stroke-accent" : "fill-surface stroke-border",
              )}
            />

            {/* 左侧阶段徽章与标题 */}
            <rect
              x={box.x + 16}
              y={box.y + 14}
              width="196"
              height="22"
              rx="11"
              className={cx(isSelected ? "fill-accent-soft" : "fill-secondary-soft")}
            />
            <text
              x={box.x + 28}
              y={box.y + 29}
              fontSize="11.5"
              className={cx("font-semibold", isSelected ? "fill-accent" : "fill-secondary-fg")}
            >
              {phase.badge}
            </text>
            <text x={box.x + 224} y={box.y + 29} fontSize="11.5" className="fill-fg-subtle font-mono">
              {phase.stepRange}
            </text>

            <text x={box.x + 16} y={box.y + 56} fontSize="16.5" className="fill-fg font-semibold">
              {phase.title}
            </text>
            <text x={box.x + 16} y={box.y + 78} fontSize="12" className="fill-fg-muted font-mono">
              {phase.sub}
            </text>
            <text x={box.x + 16} y={box.y + 98} fontSize="11.5" className="fill-fg-subtle">
              {phase.summary.slice(0, 56)}…
            </text>

            {/* 右侧横向排列该阶段内的具体步骤胶囊 */}
            {phase.fnList.map((fnText, idx) => {
              const count = phase.fnList.length;
              const startX = box.x + 540;
              const availW = box.w - 556;
              const gap = 10;
              const stepW = Math.floor((availW - gap * (count - 1)) / count);
              const sx = startX + idx * (stepW + gap);
              const sy = box.y + 14;
              const sh = box.h - 28;
              const [head, body] = fnText.split("：");
              return (
                <g key={fnText}>
                  <rect
                    x={sx}
                    y={sy}
                    width={stepW}
                    height={sh}
                    rx="10"
                    strokeWidth="1"
                    className={cx(
                      isSelected ? "fill-bg stroke-accent" : "fill-bg stroke-border-strong",
                    )}
                  />
                  <text x={sx + 10} y={sy + 22} fontSize="11.5" className="fill-accent font-semibold font-mono">
                    {head.slice(0, 26)}
                  </text>
                  {body && (
                    <>
                      <text x={sx + 10} y={sy + 44} fontSize="11" className="fill-fg-muted">
                        {body.slice(0, 22)}
                      </text>
                      <text x={sx + 10} y={sy + 62} fontSize="10.5" className="fill-fg-subtle">
                        {body.slice(22, 44)}
                        {body.length > 44 ? "…" : ""}
                      </text>
                    </>
                  )}
                  {idx < count - 1 && (
                    <line
                      x1={sx + stepW}
                      y1={sy + sh / 2}
                      x2={sx + stepW + gap}
                      y2={sy + sh / 2}
                      strokeWidth="1.5"
                      className="stroke-fg-muted"
                    />
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );

  /** 视图 B：四层系统架构与模块映射 SVG */
  const renderArchSvg = (interactive: boolean) => (
    <svg
      viewBox="0 0 1600 820"
      role="img"
      aria-label={t.title}
      className="block h-auto w-full select-none font-sans"
    >
      <defs>
        <marker id="bp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" className="fill-fg-muted" />
        </marker>
        <marker id="bp-arrow-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" className="fill-accent" />
        </marker>
      </defs>

      <rect width="1600" height="820" rx="20" className="fill-bg" />

      {/* 四大架构分层泳道 */}
      <g>
        <rect x="24" y="22" width="1552" height="168" rx="16" className="fill-bg-elevated stroke-border" strokeWidth="1.5" />
        <text x="48" y="48" fontSize="14" className="fill-fg-subtle font-semibold tracking-wide">
          {t.diagram.layers.clients}
        </text>

        <rect x="24" y="206" width="1552" height="196" rx="16" className="fill-bg-elevated stroke-border" strokeWidth="1.5" />
        <text x="48" y="232" fontSize="14" className="fill-fg-subtle font-semibold tracking-wide">
          {t.diagram.layers.host}
        </text>
        <text x="1552" y="232" textAnchor="end" fontSize="13" className="fill-secondary-fg font-mono">
          {t.diagram.badges.singleProc}
        </text>

        <rect x="24" y="424" width="1552" height="196" rx="16" className="fill-bg-elevated stroke-accent" strokeWidth="1.5" strokeDasharray="6 4" />
        <text x="48" y="450" fontSize="14" className="fill-accent font-semibold tracking-wide">
          {t.diagram.layers.engine}
        </text>
        <text x="1552" y="450" textAnchor="end" fontSize="13" className="fill-accent font-mono">
          {t.diagram.badges.zeroDep}
        </text>

        <rect x="24" y="636" width="1552" height="164" rx="16" className="fill-bg-elevated stroke-border" strokeWidth="1.5" />
        <text x="48" y="662" fontSize="14" className="fill-fg-subtle font-semibold tracking-wide">
          {t.diagram.layers.storage}
        </text>
        <text x="1552" y="662" textAnchor="end" fontSize="13" className="fill-secondary-fg font-mono">
          {t.diagram.badges.gitSync}
        </text>
      </g>

      {/* 业务流连线 */}
      <g>
        {EDGES.map((edge) => {
          const active = edge.flows.includes(activeFlow);
          return (
            <g key={edge.id} className={cx(!active && "opacity-(--ds-opacity-disabled)")}>
              <path
                d={edge.d}
                fill="none"
                strokeWidth={active && activeFlow !== "all" ? "2.5" : "1.75"}
                markerEnd={active && activeFlow !== "all" ? "url(#bp-arrow-accent)" : "url(#bp-arrow)"}
                className={cx(active && activeFlow !== "all" ? "stroke-accent" : "stroke-fg-muted")}
              />
              <rect x={edge.lx - 110} y={edge.ly - 13} width="220" height="20" rx="6" className="fill-bg stroke-border" strokeWidth="1" />
              <text
                x={edge.lx}
                y={edge.ly + 1}
                textAnchor="middle"
                fontSize="11.5"
                className={cx(active && activeFlow !== "all" ? "fill-accent font-semibold" : "fill-fg-muted")}
              >
                {t.diagram.edges[edge.labelKey]}
              </text>
            </g>
          );
        })}
      </g>

      {/* 八大核心模块节点 */}
      <g>
        {t.nodes.map((node) => {
          const id = node.id as NodeId;
          const box = NODE_LAYOUT[id];
          const isSelected = selectedNodeId === id;
          const inFlow = highlightedNodes.has(id);
          const isAliveCore = id === "body_heart" || id === "engine_loop";

          return (
            <g
              key={id}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={`${node.title} - ${node.sub}`}
              onClick={interactive ? () => setSelectedNodeId(id) : undefined}
              onKeyDown={
                interactive
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedNodeId(id);
                      }
                    }
                  : undefined
              }
              className={cx(interactive && "cursor-pointer", !inFlow && "opacity-(--ds-opacity-disabled)")}
            >
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx="14"
                strokeWidth={isSelected ? "2.5" : "1.5"}
                className={cx(
                  isSelected
                    ? "fill-surface-hover stroke-accent"
                    : inFlow && activeFlow !== "all"
                      ? "fill-surface stroke-border-strong"
                      : "fill-surface stroke-border",
                )}
              />

              <rect
                x={box.x + 18}
                y={box.y + 14}
                width={Math.min(200, box.w - 36)}
                height="22"
                rx="11"
                className={cx(isSelected || isAliveCore ? "fill-accent-soft" : "fill-secondary-soft")}
              />
              {isAliveCore && (
                <circle cx={box.x + 30} cy={box.y + 25} r="4.5" className="fill-accent animate-breath motion-reduce:animate-none" />
              )}
              <text
                x={box.x + (isAliveCore ? 42 : 28)}
                y={box.y + 29}
                fontSize="11.5"
                className={cx("font-semibold", isSelected || isAliveCore ? "fill-accent" : "fill-secondary-fg")}
              >
                {node.badge}
              </text>

              <text x={box.x + 18} y={box.y + 62} fontSize="19" className="fill-fg font-semibold">
                {node.title}
              </text>
              <text x={box.x + 18} y={box.y + 86} fontSize="13.5" className="fill-fg-muted font-mono">
                {node.sub}
              </text>

              {box.h >= 130 && (
                <text x={box.x + 18} y={box.y + 114} fontSize="12.5" className="fill-fg-subtle font-mono">
                  {node.files[0].split(" · ")[0]}
                </text>
              )}
              {box.w > 1000 && (
                <text x={box.x + box.w - 22} y={box.y + 62} textAnchor="end" fontSize="13" className="fill-fg-muted font-mono">
                  QUETZAL_HOME: data/quetzal.db · soul/notes/QuetzalMemory/ · secrets/ · vault/
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );

  return (
    <section aria-label={t.title} className="my-8 flex flex-col gap-5 rounded-2xl border border-border bg-bg-elevated p-5 sm:p-6">
      {/* 标题栏与全屏按钮 */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-accent">{t.eyebrow}</p>
          <h3 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{t.title}</h3>
          <p className="text-sm text-fg-muted">{t.subtitle}</p>
        </div>
        <Button variant="secondary" size="sm" type="button" onClick={() => setZoomOpen(true)}>
          {t.zoomAction}
        </Button>
      </div>

      {/* 顶层视图模式切换：视图 A（单轮 6 阶段 22 步全链路） vs 视图 B（四层系统架构图） */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t.viewModeLabel}</span>
        <div className="grid gap-2 sm:grid-cols-2" role="tablist" aria-label={t.viewModeLabel}>
          {(["turn", "arch"] as const).map((mode) => {
            const active = viewMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setViewMode(mode)}
                className={cx(
                  "flex items-center justify-between rounded-xl border px-4 py-2.5 text-left text-xs font-semibold transition-colors duration-(--ds-duration-fast)",
                  active
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
                )}
              >
                <span>{t.viewModes[mode]}</span>
                <span aria-hidden className={cx("size-2 rounded-full", active ? "bg-accent" : "bg-border-strong")} />
              </button>
            );
          })}
        </div>
      </div>

      {viewMode === "turn" ? (
        <>
          {/* 视图 A：单轮 6 阶段 22 步全链路 SVG */}
          <div className="overflow-x-auto rounded-xl border border-border bg-bg p-2 sm:p-3">
            <div className="min-w-[48rem]">{renderTurnSvg(true)}</div> {/* ds-allow：时序泳道图在小屏保持可读最小宽度 */}
          </div>

          {/* 6 大阶段快速选择器 */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t.turnView.phasesLabel}</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {t.turnView.phases.map((phase) => {
                const id = phase.id as PhaseId;
                const isSelected = selectedPhaseId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelectedPhaseId(id)}
                    className={cx(
                      "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors duration-(--ds-duration-fast)",
                      isSelected
                        ? "border-accent bg-surface-hover text-fg"
                        : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
                    )}
                  >
                    <span className="font-mono text-xs font-semibold text-accent">{phase.stepRange}</span>
                    <span className="text-xs font-medium text-fg">{phase.badge.split(" · ")[1] ?? phase.badge}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 选中阶段详情面板：左栏为该阶段精确执行函数步骤，右栏为条件分支与防故障机制 */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Badge tone="accent">{selectedPhase.badge}</Badge>
                  <h4 className="mt-1.5 text-lg font-semibold text-fg">{selectedPhase.title}</h4>
                </div>
                <code className="rounded-sm bg-code-bg px-2 py-0.5 font-mono text-xs text-code-fg">{selectedPhase.stepRange}</code>
              </div>
              <p className="text-sm text-fg-muted">{selectedPhase.summary}</p>
              <code className="rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-secondary-fg">
                {selectedPhase.sub}
              </code>
              <ol className="flex flex-col gap-2">
                {selectedPhase.fnList.map((fn) => (
                  <li key={fn} className="rounded-lg border border-border bg-bg p-3 text-xs leading-relaxed text-fg-muted">
                    <span className="font-semibold text-fg">{fn.split("：")[0]}：</span>
                    <span>{fn.split("：").slice(1).join("：")}</span>
                  </li>
                ))}
              </ol>
            </Card>

            <div className="flex flex-col gap-4">
              <Card className="flex flex-col gap-3 p-5">
                <Badge tone="secondary">{selectedPhase.stepRange}</Badge>
                <h4 className="text-base font-semibold text-fg">{t.highlightsTitle}</h4>
                <ul className="flex flex-col gap-2 text-xs text-fg-muted">
                  {selectedPhase.branches.map((b) => (
                    <li key={b} className="grid grid-cols-[0.65rem_1fr] gap-2 rounded-lg border border-border bg-bg p-3 leading-relaxed">
                      <span aria-hidden className="mt-1.5 inline-block size-1.5 rounded-full bg-accent" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              {/* 四种触发源对比表 */}
              <Card className="flex flex-col gap-3 overflow-x-auto p-5">
                <h4 className="text-sm font-semibold text-fg">{t.turnView.triggersTitle}</h4>
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-fg-subtle">
                      {t.turnView.triggersHeaders.map((h) => (
                        <th key={h} className="py-1.5 pr-3 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-fg-muted">
                    {t.turnView.triggersRows.map((row) => (
                      <tr key={row[0]}>
                        <td className="py-2 pr-3 font-medium text-fg">{row[0]}</td>
                        <td className="py-2 pr-3">{row[1]}</td>
                        <td className="py-2 pr-3">{row[2]}</td>
                        <td className="py-2 pr-3">{row[3]}</td>
                        <td className="py-2">{row[4]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* 视图 B：业务流切换胶囊 */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t.flowsLabel}</span>
            <div className="flex flex-wrap gap-2" role="tablist" aria-label={t.flowsLabel}>
              {t.flows.map((flow) => {
                const active = activeFlow === flow.id;
                return (
                  <button
                    key={flow.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => selectFlow(flow.id as FlowId)}
                    className={cx(
                      "rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors duration-(--ds-duration-fast)",
                      active
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
                    )}
                  >
                    {flow.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-bg p-2 sm:p-3">
            <div className="min-w-[44rem]">{renderArchSvg(true)}</div> {/* ds-allow：宽架构图在小屏保持可读最小宽度 */}
          </div>

          {/* 子系统快速切换条 */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t.modulesLabel}</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {t.nodes.map((node) => {
                const id = node.id as NodeId;
                const isSelected = selectedNodeId === id;
                const inFlow = highlightedNodes.has(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelectedNodeId(id)}
                    className={cx(
                      "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors duration-(--ds-duration-fast)",
                      isSelected
                        ? "border-accent bg-surface-hover text-fg"
                        : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
                      !inFlow && "opacity-(--ds-opacity-muted)",
                    )}
                  >
                    <span className="text-xs font-semibold text-accent">{node.badge}</span>
                    <span className="text-xs font-medium text-fg">{node.title}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 底部双栏详情面板 */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Badge tone="accent">{selectedNode.badge}</Badge>
                  <h4 className="mt-1.5 text-lg font-semibold text-fg">{selectedNode.title}</h4>
                </div>
                <code className="rounded-sm bg-code-bg px-2 py-0.5 font-mono text-xs text-code-fg">{selectedNode.sub}</code>
              </div>
              <p className="text-sm text-fg-muted">{selectedNode.summary}</p>

              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{t.filesTitle}</p>
                <ul className="flex flex-col gap-1.5">
                  {selectedNode.files.map((file) => {
                    const [pathPart, descPart] = file.split(" · ");
                    return (
                      <li key={file} className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs">
                        <code className="font-mono font-semibold text-fg">{pathPart}</code>
                        {descPart && <span className="text-fg-muted"> · {descPart}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{t.highlightsTitle}</p>
                <ul className="flex flex-col gap-1.5 text-xs text-fg-muted">
                  {selectedNode.highlights.map((item) => (
                    <li key={item} className="grid grid-cols-[0.65rem_1fr] gap-2">
                      <span aria-hidden className="mt-1.5 inline-block size-1.5 rounded-full bg-accent" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>

            <Card className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1">
                <Badge tone="secondary">{activeFlowObj.label}</Badge>
                <h4 className="mt-1 text-lg font-semibold text-fg">{t.flowStepsTitle}</h4>
                <p className="text-sm text-fg-muted">{activeFlowObj.summary}</p>
              </div>
              <ol className="flex flex-col gap-2.5">
                {activeFlowObj.steps.map((step, index) => (
                  <li key={step} className="grid grid-cols-[1.5rem_1fr] items-start gap-2.5 rounded-lg border border-border bg-bg p-3 text-xs text-fg">
                    <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent-soft font-mono text-xs font-semibold text-accent tabular-nums">
                      {index + 1}
                    </span>
                    <span className="leading-relaxed text-fg-muted">{step}</span>
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </>
      )}

      {zoomOpen && (
        <Lightbox natural={{ w: 1600, h: viewMode === "turn" ? 960 : 820 }} onClose={() => setZoomOpen(false)}>
          {(size) => (
            <div style={size} className="[&_svg]:block [&_svg]:h-full! [&_svg]:w-full!">
              {viewMode === "turn" ? renderTurnSvg(true) : renderArchSvg(true)}
            </div>
          )}
        </Lightbox>
      )}
    </section>
  );
}
