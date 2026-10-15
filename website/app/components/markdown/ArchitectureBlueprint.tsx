import { useEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import { Badge, Card, cx } from "~/design-system/components";
import { useMessages } from "~/i18n/core";
import { archBlueprintMessages } from "./archBlueprintI18n";
import { SystemArchVideo, TurnLifecycleVideo } from "./RemotionBlueprint";

type ViewMode = "turn" | "arch";
type PhaseId = "p1" | "p2" | "p3" | "p4" | "p5" | "p6";
type FlowId = "loop" | "context" | "memory" | "mcp" | "tui";
type NodeId =
  | "clients"
  | "body_heart"
  | "brain_host"
  | "engine_loop"
  | "context_mgr"
  | "memory_prime"
  | "mcp_sandbox"
  | "storage_mesh";

const PHASE_INDEX: Record<PhaseId, number> = { p1: 0, p2: 1, p3: 2, p4: 3, p5: 4, p6: 5 };
const FLOW_INDEX: Record<FlowId, number> = { loop: 0, context: 1, memory: 2, mcp: 3, tui: 4 };

const FLOW_NODES: Record<FlowId, readonly NodeId[]> = {
  loop: ["body_heart", "brain_host", "engine_loop"],
  context: ["brain_host", "engine_loop", "context_mgr", "memory_prime", "storage_mesh"],
  memory: ["brain_host", "context_mgr", "memory_prime", "storage_mesh"],
  mcp: ["engine_loop", "mcp_sandbox", "storage_mesh"],
  tui: ["clients", "brain_host", "mcp_sandbox", "storage_mesh"],
};

export function ArchitectureBlueprint() {
  const t = useMessages(archBlueprintMessages);
  const [viewMode, setViewMode] = useState<ViewMode>("turn");
  const [selectedPhaseId, setSelectedPhaseId] = useState<PhaseId>("p1");
  const [activeFlow, setActiveFlow] = useState<FlowId>("loop");
  const [selectedNodeId, setSelectedNodeId] = useState<NodeId>("engine_loop");
  const [PlayerComp, setPlayerComp] = useState<typeof import("@remotion/player").Player | null>(null);

  const turnPlayerRef = useRef<PlayerRef>(null);
  const archPlayerRef = useRef<PlayerRef>(null);

  // 客户端挂载后加载 @remotion/player，兼容静态预渲染
  useEffect(() => {
    let alive = true;
    import("@remotion/player").then((mod) => {
      if (alive) setPlayerComp(() => mod.Player);
    });
    return () => {
      alive = false;
    };
  }, []);

  const selectedPhase = t.turnView.phases.find((p) => p.id === selectedPhaseId) ?? t.turnView.phases[0];
  const activeFlowObj = t.flows.find((f) => f.id === activeFlow) ?? t.flows[1];
  const selectedNode = t.nodes.find((n) => n.id === selectedNodeId) ?? t.nodes[0];
  const highlightedNodes = new Set(FLOW_NODES[activeFlow]);

  const jumpToPhase = (id: PhaseId) => {
    setSelectedPhaseId(id);
    const frame = PHASE_INDEX[id] * 150 + 18;
    turnPlayerRef.current?.seekTo(frame);
  };

  const jumpToFlow = (id: FlowId) => {
    setActiveFlow(id);
    const candidates = FLOW_NODES[id];
    if (!candidates.includes(selectedNodeId)) {
      setSelectedNodeId(candidates[0]);
    }
    const frame = FLOW_INDEX[id] * 150 + 15;
    archPlayerRef.current?.seekTo(frame);
  };

  return (
    <section aria-label={t.title} className="my-8 flex flex-col gap-5 rounded-2xl border border-border bg-bg-elevated p-5 sm:p-6">
      {/* 标题栏 */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-accent">{t.eyebrow}</p>
          <h3 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{t.title}</h3>
          <p className="text-sm text-fg-muted">{t.subtitle}</p>
        </div>
        <Badge tone="accent">Remotion Player · 30 FPS</Badge>
      </div>

      {/* 顶层视图模式切换：视图 A（单轮 6 阶段 22 步动态演示） vs 视图 B（四层系统架构与业务流动画） */}
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
          {/* 6 大阶段章节跳转按钮（点击立即让 Remotion Player seek 到对应阶段帧） */}
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
                    onClick={() => jumpToPhase(id)}
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

          {/* Remotion Player 主舞台：单轮 6 阶段 22 步全链路动画（1280×740，30fps，900帧=30秒循环） */}
          <div className="overflow-hidden rounded-xl border border-border bg-bg">
            {PlayerComp ? (
              <PlayerComp
                ref={turnPlayerRef}
                component={TurnLifecycleVideo}
                inputProps={{ t }}
                durationInFrames={900}
                compositionWidth={1280}
                compositionHeight={740}
                fps={30}
                controls
                loop
                autoPlay
                clickToPlay
                allowFullscreen
                style={{ width: "100%", aspectRatio: "1280 / 740" }}
              />
            ) : (
              <div className="flex aspect-[1280/740] w-full items-center justify-center p-6 text-sm text-fg-muted"> {/* ds-allow：播放器静态预渲染占位比例 */}
                {t.title}
              </div>
            )}
          </div>

          {/* 选中阶段详情面板：左栏为该阶段精确执行函数步骤，右栏为条件分支与四种触发源对比表 */}
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
          {/* 视图 B：业务流切换胶囊（点击立即 seek 到对应业务流动画段落） */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t.flowsLabel}</span>
            <div className="flex flex-wrap gap-2" role="tablist" aria-label={t.flowsLabel}>
              {t.flows.slice(1).map((flow) => {
                const active = activeFlow === flow.id;
                return (
                  <button
                    key={flow.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => jumpToFlow(flow.id as FlowId)}
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

          {/* Remotion Player 主舞台：四层系统架构与 5 条业务流动画（1280×740，30fps，750帧=25秒循环） */}
          <div className="overflow-hidden rounded-xl border border-border bg-bg">
            {PlayerComp ? (
              <PlayerComp
                ref={archPlayerRef}
                component={SystemArchVideo}
                inputProps={{ t }}
                durationInFrames={750}
                compositionWidth={1280}
                compositionHeight={740}
                fps={30}
                controls
                loop
                autoPlay
                clickToPlay
                allowFullscreen
                style={{ width: "100%", aspectRatio: "1280 / 740" }}
              />
            ) : (
              <div className="flex aspect-[1280/740] w-full items-center justify-center p-6 text-sm text-fg-muted"> {/* ds-allow：播放器静态预渲染占位比例 */}
                {t.title}
              </div>
            )}
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
    </section>
  );
}
