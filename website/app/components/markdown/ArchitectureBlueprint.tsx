import { useState } from "react";
import { Badge, Button, Card, cx } from "~/design-system/components";
import { useMessages } from "~/i18n/core";
import { archBlueprintMessages } from "./archBlueprintI18n";
import { Lightbox } from "./Lightbox";

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
  const [activeFlow, setActiveFlow] = useState<FlowId>("all");
  const [selectedNodeId, setSelectedNodeId] = useState<NodeId>("engine_loop");
  const [zoomOpen, setZoomOpen] = useState(false);

  const activeFlowObj = t.flows.find((f) => f.id === activeFlow) ?? t.flows[0];
  const selectedNode = t.nodes.find((n) => n.id === selectedNodeId) ?? t.nodes[0];
  const highlightedNodes = new Set(FLOW_NODES[activeFlow]);

  const selectFlow = (id: FlowId) => {
    setActiveFlow(id);
    const candidates = FLOW_NODES[id];
    if (!candidates.includes(selectedNodeId)) {
      setSelectedNodeId(candidates[0]);
    }
  };

  const renderSvg = (interactive: boolean) => (
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

      {/* 背景 */}
      <rect width="1600" height="820" rx="20" className="fill-bg" />

      {/* 四大架构分层泳道 */}
      <g>
        {/* Layer 1: Clients & Body */}
        <rect x="24" y="22" width="1552" height="168" rx="16" className="fill-bg-elevated stroke-border" strokeWidth="1.5" />
        <text x="48" y="48" fontSize="14" className="fill-fg-subtle font-semibold tracking-wide">
          {t.diagram.layers.clients}
        </text>

        {/* Layer 2: Production Host runtime/src/ */}
        <rect x="24" y="206" width="1552" height="196" rx="16" className="fill-bg-elevated stroke-border" strokeWidth="1.5" />
        <text x="48" y="232" fontSize="14" className="fill-fg-subtle font-semibold tracking-wide">
          {t.diagram.layers.host}
        </text>
        <text x="1552" y="232" textAnchor="end" fontSize="13" className="fill-secondary-fg font-mono">
          {t.diagram.badges.singleProc}
        </text>

        {/* Layer 3: Standalone Kernel engine/src/ */}
        <rect x="24" y="424" width="1552" height="196" rx="16" className="fill-bg-elevated stroke-accent" strokeWidth="1.5" strokeDasharray="6 4" />
        <text x="48" y="450" fontSize="14" className="fill-accent font-semibold tracking-wide">
          {t.diagram.layers.engine}
        </text>
        <text x="1552" y="450" textAnchor="end" fontSize="13" className="fill-accent font-mono">
          {t.diagram.badges.zeroDep}
        </text>

        {/* Layer 4: Storage & Mesh */}
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
                className={cx(
                  active && activeFlow !== "all" ? "stroke-accent" : "stroke-fg-muted",
                )}
              />
              <rect
                x={edge.lx - 110}
                y={edge.ly - 13}
                width="220"
                height="20"
                rx="6"
                className="fill-bg stroke-border"
                strokeWidth="1"
              />
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
              className={cx(
                interactive && "cursor-pointer",
                !inFlow && "opacity-(--ds-opacity-disabled)",
              )}
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

              {/* 顶部标签 */}
              <rect
                x={box.x + 18}
                y={box.y + 14}
                width={Math.min(200, box.w - 36)}
                height="22"
                rx="11"
                className={cx(
                  isSelected || isAliveCore ? "fill-accent-soft" : "fill-secondary-soft",
                )}
              />
              {isAliveCore && (
                <circle
                  cx={box.x + 30}
                  cy={box.y + 25}
                  r="4.5"
                  className="fill-accent animate-breath motion-reduce:animate-none"
                />
              )}
              <text
                x={box.x + (isAliveCore ? 42 : 28)}
                y={box.y + 29}
                fontSize="11.5"
                className={cx(
                  "font-semibold",
                  isSelected || isAliveCore ? "fill-accent" : "fill-secondary-fg",
                )}
              >
                {node.badge}
              </text>

              {/* 标题与副标题 */}
              <text
                x={box.x + 18}
                y={box.y + 62}
                fontSize="19"
                className="fill-fg font-semibold"
              >
                {node.title}
              </text>
              <text
                x={box.x + 18}
                y={box.y + 86}
                fontSize="13.5"
                className="fill-fg-muted font-mono"
              >
                {node.sub}
              </text>

              {/* 在宽节点右侧展示首条关键源码路径提示 */}
              {box.h >= 130 && (
                <text
                  x={box.x + 18}
                  y={box.y + 114}
                  fontSize="12.5"
                  className="fill-fg-subtle font-mono"
                >
                  {node.files[0].split(" · ")[0]}
                </text>
              )}
              {box.w > 1000 && (
                <text
                  x={box.x + box.w - 22}
                  y={box.y + 62}
                  textAnchor="end"
                  fontSize="13"
                  className="fill-fg-muted font-mono"
                >
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

      {/* 业务流切换胶囊（HTML5 交互控制） */}
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

      {/* 核心一体架构 + 业务流 SVG 画布 */}
      <div className="overflow-x-auto rounded-xl border border-border bg-bg p-2 sm:p-3">
        <div className="min-w-[44rem]">{renderSvg(true)}</div> {/* ds-allow：宽架构图在小屏保持可读最小宽度并支持横向滑动 */}
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

      {/* 底部双栏详情面板：左侧为当前选中模块的代码映射与边界，右侧为当前激活业务流的端到端步骤 */}
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

      {zoomOpen && (
        <Lightbox natural={{ w: 1600, h: 820 }} onClose={() => setZoomOpen(false)}>
          {(size) => (
            <div style={size} className="[&_svg]:block [&_svg]:h-full! [&_svg]:w-full!">
              {renderSvg(true)}
            </div>
          )}
        </Lightbox>
      )}
    </section>
  );
}
