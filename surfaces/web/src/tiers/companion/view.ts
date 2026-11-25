import { h } from "../../render/dom.js";
import { messageList, offlinePanel, statusLine, tierShell, toolCards } from "../shared.js";
import type { TierContext } from "../types.js";

const ONBOARDING_STEPS: Record<number, { title: string; body: string }> = {
  1: { title: "写一句话就行", body: "说你今天想完成的事，我把它记下来。" },
  2: { title: "我替你排好顺序", body: "重要的事放前面，做完的自动划掉。" },
  3: { title: "内容只留在本机", body: "不会自动发到外面；随时可切到工作台看细节。" },
};

function onboardingCard(ctx: TierContext): HTMLElement | null {
  if (!ctx.onboarding) return null;
  const step = ONBOARDING_STEPS[ctx.onboarding.step] ?? ONBOARDING_STEPS[1];
  if (!step) return null;
  return h(
    "section",
    {
      class: "card onboarding-card",
      "data-role": "onboarding",
      "data-onboarding-step": String(ctx.onboarding.step),
      "aria-label": "十秒快速上手",
      // 主动播报会让屏幕阅读器在引导期间被反复打断，故本卡片不参与 live。
      "aria-live": "off",
    },
    h("h2", null, step.title),
    h("p", null, step.body),
    h("p", { class: "muted" }, `第 ${ctx.onboarding.step} / ${ctx.onboarding.total} 步 · 十秒后自动收起`),
    h(
      "button",
      {
        class: "btn btn--quiet",
        type: "button",
        "data-role": "onboarding-skip",
        "data-focus-key": "onboarding-skip",
        onClick: () => ctx.actions.skipOnboarding(),
      },
      "跳过引导",
    ),
  );
}

/** 陪伴态：零术语、大触控目标，只披露一句话摘要。 */
export function renderCompanion(ctx: TierContext): HTMLElement {
  const artifactSummaries = ctx.rows
    .filter((row) => row.kind === "artifact" || row.kind === "conscience")
    .slice(0, 3)
    .map((row) => h("li", null, row.summary));
  return tierShell("companion", "需要我做什么？", "写一句话就行，我来帮你安排。", [
    onboardingCard(ctx),
    h(
      "div",
      { class: "card welcome-card", "data-role": "welcome" },
      h("h2", null, "我是羽蛇神"),
      h("p", null, "你说一件事，我把它记下来、排好顺序，再提醒你。"),
      h("p", { class: "muted" }, "所有内容只留在这台设备上，不会自动发到外面。"),
    ),
    statusLine(ctx),
    offlinePanel(ctx),
    artifactSummaries.length > 0
      ? h("ul", { class: "plain-list", "data-role": "highlights" }, ...artifactSummaries)
      : null,
    messageList(ctx),
    toolCards(ctx),
  ]);
}
