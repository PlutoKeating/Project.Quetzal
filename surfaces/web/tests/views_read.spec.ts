import { describe, expect, it, vi } from "vitest";
import { FakeApi, freshFixture, fullFixture, NOW } from "./fake_api.js";
import { mount, press, settle, type } from "./harness.js";

const DAY = 86_400_000;

function text(element: Element | null): string {
  return element?.textContent ?? "";
}

describe("总览：他在 · 他在哪些宿主里 · 有没有事在等我", () => {
  it("居中的名字与「相处第 N 天」，其下一条三格的栅格", async () => {
    const ui = await mount();
    expect(ui.q("main h1").classList.contains("qz-display")).toBe(true);
    expect(text(ui.q('[data-role="agent-name"]'))).toBe("Ehecatl");
    expect(text(ui.q('[data-role="days-together"]'))).toBe("相处第 214 天");
    const rail = ui.q('[data-role="overview-rail"]');
    expect(rail.classList.contains("qz-rail")).toBe(true);
    expect(Array.from(rail.children).map((cell) => (cell as HTMLElement).dataset["cell"])).toEqual([
      "hosts",
      "pending",
      "sync",
    ]);
    expect(ui.all('[data-role="overview-rail"] h2').map(text)).toEqual(["宿主", "等你的事", "同步"]);
  });

  it("宿主格：通的冰蓝、不通的琥珀，都带文字", async () => {
    const ui = await mount();
    const hosts = ui.all('[data-cell="hosts"] .qz-signal');
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.querySelector(".qz-dot.is-ice")).not.toBeNull();
    expect(text(hosts[0] ?? null)).toContain("通");
    expect(hosts[1]?.querySelector(".qz-dot.is-amber")).not.toBeNull();
    expect(text(hosts[1] ?? null)).toContain("未接上");
    expect(text(ui.q('[data-cell="hosts"] .qz-state'))).toBe("1 个通着");
  });

  it("等你的事：有的时候逐件列出并指向那一页", async () => {
    const ui = await mount();
    const cell = ui.q('[data-cell="pending"]');
    expect(text(cell.querySelector(".qz-state.is-amber"))).toBe("1 件");
    const link = cell.querySelector("a");
    expect(text(link)).toBe("1 处变化等你看");
    expect(link?.getAttribute("href")).toBe("#/self");
  });

  it("等你的事为零时这一格说「没有事在等你」，不隐藏", async () => {
    const data = fullFixture();
    data.overview.pending = { disclosures: 0, approvals: 0 };
    const ui = await mount({ api: new FakeApi(data) });
    const cell = ui.q('[data-cell="pending"]');
    expect(text(cell.querySelector('[data-role="nothing-pending"]'))).toBe("没有事在等你。");
    expect(cell.querySelector(".is-amber")).toBeNull();
  });

  it("刚装好：第 1 天，没有宿主时写明怎么接，底线待签署算一件等你的事", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()) });
    expect(text(ui.q('[data-role="days-together"]'))).toBe("相处第 1 天");
    const hosts = ui.q('[data-cell="hosts"]');
    expect(text(hosts)).toContain("他还没有住进任何宿主");
    expect(text(hosts.querySelector(".qz-code-chip"))).toBe("qz connect");
    expect(text(ui.q('[data-cell="pending"] a'))).toBe("底线待签署");
    expect(text(ui.q('[data-cell="sync"] .qz-state'))).toBe("仅本机");
  });
});

describe("他：核心价值的栅格、性情、最近的变化", () => {
  it("核心价值每格一条：编号、陈述、自何时起", async () => {
    const ui = await mount({ hash: "#/self" });
    const cells = ui.all('[data-role="core-values"] .qz-cell');
    expect(cells).toHaveLength(2);
    expect(text(cells[0]?.querySelector(".qz-cell-num") ?? null)).toBe("01");
    expect(text(cells[0]?.querySelector("h3") ?? null)).toBe("先把问题想清楚，再动手");
    expect(text(cells[0]?.querySelector(".qz-cell-note") ?? null)).toMatch(/^自 \d{4}-\d{2}-\d{2} 起$/u);
    expect(text(cells[1]?.querySelector(".qz-cell-num") ?? null)).toBe("02");
  });

  it("性情列在核心之后，标题小一级", async () => {
    const ui = await mount({ hash: "#/self" });
    const titles = ui.all("main h2");
    expect(titles.map(text)).toEqual(["核心价值", "性情", "最近的变化", "他独处时"]);
    expect(titles[1]?.classList.contains("is-minor")).toBe(true);
    expect(titles[0]?.classList.contains("is-minor")).toBe(false);
  });

  it("变化是一条时间线；还没告诉过你的那一条带琥珀色的「等你看」", async () => {
    const ui = await mount({ hash: "#/self" });
    const items = ui.all('[data-role="changes"] .qz-timeline-item');
    expect(items).toHaveLength(2);
    expect(items[0]?.classList.contains("is-amber")).toBe(true);
    expect(text(items[0]?.querySelector(".qz-state.is-amber") ?? null)).toBe("等你看");
    expect(items[1]?.classList.contains("is-amber")).toBe(false);
    expect(text(ui.q('[data-role="view-state"]'))).toBe("1 处变化等你看");
  });

  it("变化可以展开证据链：哪几次相处、跨多少天", async () => {
    const ui = await mount({ hash: "#/self" });
    const toggle = ui.q<HTMLButtonElement>('[data-entry="chg-2"] [data-action="evidence"]');
    expect(text(toggle)).toBe("证据：3 次相处，跨 12 天");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(ui.all('[data-role="evidence"]')).toHaveLength(0);

    press(toggle);
    const opened = ui.q<HTMLButtonElement>('[data-entry="chg-2"] [data-action="evidence"]');
    expect(opened.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(opened);
    expect(ui.all('[data-role="evidence"] .qz-signal')).toHaveLength(3);
    // 出处栏写明这次变化落在哪一条上。
    expect(text(ui.q('[data-role="provenance-title"]'))).toBe("把「不附和」升为核心");
    expect(text(ui.q('[data-role="provenance-lead"]'))).toBe("这次变化落在「不附和」上。");

    opened.click();
    expect(ui.all('[data-role="evidence"]')).toHaveLength(0);
  });

  it("选中一条核心价值，出处栏写明它的理由与证据", async () => {
    const ui = await mount({ hash: "#/self" });
    press(ui.q('[data-entry="cv-1"] .qz-pick'));
    expect(ui.q('[data-entry="cv-1"]').classList.contains("is-current")).toBe(true);
    expect(ui.q('[data-entry="cv-1"] .qz-pick').getAttribute("aria-current")).toBe("true");
    expect(text(ui.q('[data-role="provenance-lead"]'))).toBe("仓促动手的那几次都返了工。");
    expect(text(ui.q('[data-role="provenance-facts"]'))).toContain("9 次相处");
    expect(document.activeElement).toBe(ui.q('[data-entry="cv-1"] .qz-pick'));
  });

  it("什么都还没有：整页说明他为什么是空的，下一步做什么", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()), hash: "#/self" });
    const situation = ui.q('[data-situation="self-empty"]');
    expect(text(situation.querySelector("h2"))).toBe("他还没有长出自己的样子");
    expect(situation.querySelectorAll('[data-role="situation-steps"] .qz-cell')).toHaveLength(3);
    expect(situation.querySelector("a")?.getAttribute("href")).toBe("#/hosts");
  });

  it("只有变化为空时，时间线的位置是一段说明", async () => {
    const data = fullFixture();
    data.self.changes = [];
    const ui = await mount({ api: new FakeApi(data), hash: "#/self" });
    expect(ui.all('[data-role="core-values"] .qz-cell')).toHaveLength(2);
    expect(text(ui.q('[data-situation="changes-empty"]'))).toContain("他最近没有变");
  });
});

describe("我：偏好与事实两栏对照", () => {
  it("左是偏好，右是事实，各带说明与条数", async () => {
    const ui = await mount({ hash: "#/user" });
    const compare = ui.q('[data-role="compare"]');
    expect(compare.classList.contains("qz-rail")).toBe(true);
    expect(compare.classList.contains("is-2")).toBe(true);
    const columns = Array.from(compare.children) as HTMLElement[];
    expect(columns.map((column) => column.dataset["column"])).toEqual(["preferences", "facts"]);
    expect(text(columns[0]?.querySelector("h2") ?? null)).toBe("偏好");
    expect(text(columns[0]?.querySelector(".qz-cell-sub") ?? null)).toBe("他据此调整做法");
    expect(text(columns[1]?.querySelector("h2") ?? null)).toBe("事实");
    expect(text(columns[1]?.querySelector(".qz-cell-sub") ?? null)).toBe("他据此理解你");
    expect(columns[0]?.querySelectorAll(".qz-row")).toHaveLength(2);
    expect(columns[1]?.querySelectorAll(".qz-row")).toHaveLength(2);
  });

  it("你亲手改过的条目带琥珀色的「你说的」", async () => {
    const ui = await mount({ hash: "#/user" });
    expect(text(ui.q('[data-entry="pref-2"] [data-mark="owner"]'))).toBe("你说的");
    expect(ui.q('[data-entry="pref-2"] [data-mark="owner"]').classList.contains("is-amber")).toBe(true);
    expect(ui.all('[data-entry="pref-1"] [data-mark="owner"]')).toHaveLength(0);
  });

  it("选中一条：就地展开三个固定动作，出处栏写明来处与有没有被纠正过", async () => {
    const ui = await mount({ hash: "#/user" });
    ui.q<HTMLButtonElement>('[data-entry="fact-2"] .qz-pick').click();
    await settle();
    const actions = ui.all<HTMLButtonElement>('[data-entry="fact-2"] [data-role="entry-actions"] button');
    expect(actions.map(text)).toEqual(["改", "不主动提", "抹除"]);
    expect(ui.api.callsTo("sea_memory").at(-1)?.params).toEqual({ id: "fact-2" });
    const facts = text(ui.q('[data-role="provenance-facts"]'));
    expect(facts).toContain("Claude Code");
    expect(facts).toContain("被纠正过 1 次");
    expect(ui.all('[data-role="provenance-events"] .qz-timeline-item')).toHaveLength(2);
    // 由你纠正的那一步是琥珀色的。
    expect(ui.all('[data-role="provenance-events"] .qz-timeline-item.is-amber')).toHaveLength(1);
  });

  it("来历读不出来时，出处栏照常显示已经知道的部分", async () => {
    const api = new FakeApi();
    api.failNext("sea_memory", "NOT_FOUND", "这一条已经不在了。");
    const ui = await mount({ api, hash: "#/user" });
    ui.q<HTMLButtonElement>('[data-entry="pref-1"] .qz-pick').click();
    await settle();
    expect(text(ui.q('[data-role="provenance-title"]'))).toBe("回答先给结论，再给理由。");
    expect(text(ui.q('[data-role="provenance-lead"]'))).toContain("读不出来");
    expect(ui.all('[data-role="entry-actions"] button')).toHaveLength(3);
  });

  it("两栏都空：整页说明；只空一栏：那一栏里说明", async () => {
    const empty = await mount({ api: new FakeApi(freshFixture()), hash: "#/user" });
    expect(text(empty.q('[data-situation="user-empty"] h2'))).toBe("他还没有记下关于你的事");

    const data = fullFixture();
    data.preferences = [];
    const half = await mount({ api: new FakeApi(data), hash: "#/user" });
    expect(text(half.q('[data-column="preferences"] [data-situation="preferences-empty"]'))).toContain(
      "他还没有记下你的偏好",
    );
    expect(half.all('[data-column="facts"] .qz-row')).toHaveLength(2);
  });
});

describe("我们：共同的承诺与一根刻度", () => {
  it("上半是编号的承诺栅格", async () => {
    const ui = await mount({ hash: "#/us" });
    const cells = ui.all('[data-role="commitments"] .qz-cell');
    expect(cells).toHaveLength(2);
    expect(text(cells[0]?.querySelector(".qz-cell-num") ?? null)).toBe("01");
    expect(text(cells[0]?.querySelector(".qz-pick") ?? null)).toBe("大决策要判断，不要附和");
    expect(text(ui.q(".qz-rail-head"))).toContain("和你");
  });

  it("下半是全站唯一的滑杆：左端他自己，右端我们，下限之外去不了", async () => {
    const ui = await mount({ hash: "#/us" });
    const scales = ui.all<HTMLInputElement>('input[type="range"]');
    expect(scales).toHaveLength(1);
    const scale = scales[0];
    expect(scale?.value).toBe("38");
    expect(scale?.min).toBe("0");
    // 下限 20：他至少留 20 给自己，所以刻度最多到 80。
    expect(scale?.max).toBe("80");
    expect(scale?.getAttribute("aria-valuetext")).toBe("他自己 62，我们 38");
    expect(ui.all(".qz-scale-ends span").map(text)).toEqual(["他自己", "我们"]);
    expect(ui.q<HTMLElement>('[data-role="scale"]').style.getPropertyValue("--qz-scale-limit")).toBe("80");
    expect(ui.all('[data-role="scale-limit"]')).toHaveLength(1);
    expect(text(ui.q('[data-role="focus-floor"]'))).toBe("下限：他至少留 20 给自己 · 已锁定");
    expect(text(ui.q('[data-role="focus-readout"]'))).toBe("他自己 62·我们 38");
  });

  it("选中一条承诺，出处栏写明它属于哪一段关系和他眼里的对方", async () => {
    const ui = await mount({ hash: "#/us" });
    ui.q<HTMLButtonElement>('[data-entry="rel-owner:1"] .qz-pick').click();
    expect(text(ui.q('[data-role="provenance-title"]'))).toBe("记错了就改，不争辩");
    expect(text(ui.aside)).toContain("他眼里的你");
    expect(text(ui.aside)).toContain("做决定之前喜欢先听反对意见");
  });

  it("还没有承诺时那一半是一段说明，刻度仍然在", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()), hash: "#/us" });
    expect(text(ui.q('[data-situation="commitments-empty"]'))).toContain("你们还没有共同的承诺");
    expect(ui.all('input[type="range"]')).toHaveLength(1);
  });
});

describe("往事：主从结构", () => {
  it("左列是结果，上方一个搜索框和三段的分段控件；右侧是选中条目的全文", async () => {
    const ui = await mount({ hash: "#/memories" });
    expect(ui.all('input[type="search"]')).toHaveLength(1);
    const tabs = ui.all('[role="tablist"] [role="tab"]');
    expect(tabs.map(text)).toEqual(["全部", "不主动提", "已过期"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    const split = ui.q('[data-role="memory-split"]');
    expect(split.classList.contains("qz-split")).toBe(true);
    // 「全部」不带 state：不主动提和已过期的不在里面。
    expect(ui.api.callsTo("sea_memories")[0]?.params).toEqual({ limit: 50 });
    expect(ui.all('[data-role="memory-list"] .qz-row')).toHaveLength(3);
    expect(text(ui.q('[data-role="memory-total"]'))).toBe("共 3 件");
    // 宽屏自动选中第一条。
    expect(ui.q('[data-entry="mem-1"]').classList.contains("is-current")).toBe(true);
    expect(text(ui.q('[data-role="memory-text"]'))).toBe("倾向于先写接口契约，再写实现。");
    const detail = ui.q('[data-role="memory-detail"]');
    expect(text(detail.querySelector("dl"))).toContain("来历");
    expect(text(detail.querySelector("dl"))).toContain("生效");
    expect(Array.from(detail.querySelectorAll('[data-role="entry-actions"] button')).map(text)).toEqual([
      "改",
      "不主动提",
      "抹除",
    ]);
  });

  it("选另一条：右侧换成它的全文，出处栏换成它的经过", async () => {
    const ui = await mount({ hash: "#/memories" });
    press(ui.q('[data-entry="mem-5"] .qz-pick'));
    await settle();
    expect(text(ui.q('[data-role="memory-text"]'))).toBe("发布前一天不合并大改动。");
    expect(ui.all('[data-role="memory-list"] .is-current')).toHaveLength(1);
    expect(text(ui.q('[data-role="provenance-facts"]'))).toContain("SayIt 快照");
    expect(text(ui.q('[data-role="provenance-facts"]'))).toContain("没有经过核实");
    expect(document.activeElement).toBe(ui.q('[data-entry="mem-5"] .qz-pick'));
  });

  it("分段控件按状态重新读取，方向键在三段之间移动", async () => {
    const ui = await mount({ hash: "#/memories" });
    ui.q<HTMLButtonElement>('[data-filter="muted"]').click();
    await settle();
    expect(ui.api.callsTo("sea_memories").at(-1)?.params).toEqual({ state: "muted", limit: 50 });
    expect(ui.all('[data-role="memory-list"] .qz-row')).toHaveLength(1);
    expect(text(ui.q('[data-entry="mem-3"] [data-mark="muted"]'))).toBe("不主动提");
    expect(ui.q('[data-filter="muted"]').getAttribute("aria-selected")).toBe("true");

    ui.q('[data-role="memory-filter"]').dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await settle();
    expect(ui.api.callsTo("sea_memories").at(-1)?.params).toEqual({ state: "expired", limit: 50 });
    expect(document.activeElement).toBe(ui.q('[data-filter="expired"]'));
    expect(text(ui.q('[data-entry="mem-4"]'))).toContain("已过期");
  });

  it("搜索：停手之后才读取，结果为空时说明并可以清空", async () => {
    const ui = await mount({ hash: "#/memories" });
    const search = ui.q<HTMLInputElement>('[data-role="memory-search"]');
    type(search, "咖");
    type(search, "咖啡因");
    await vi.waitFor(() =>
      expect(ui.api.callsTo("sea_memories").at(-1)?.params).toEqual({ query: "咖啡因", limit: 50 }),
    );
    // 两次击键只读取一次。
    expect(ui.api.callsTo("sea_memories")).toHaveLength(2);
    await settle();
    const empty = ui.q('[data-situation="memories-no-match"]');
    expect(text(empty)).toContain("没有找到「咖啡因」");

    empty.querySelector<HTMLButtonElement>('[data-role="situation-action"]')?.click();
    await settle();
    expect(search.value).toBe("");
    expect(ui.all('[data-role="memory-list"] .qz-row')).toHaveLength(3);
    expect(document.activeElement).toBe(search);
  });

  it("结果按页读取：有下一页时给一个「再看」按钮，而不是无限的单列", async () => {
    const data = fullFixture();
    const base = data.memories[0];
    if (!base) throw new Error("fixture 缺少往事");
    data.memories = Array.from({ length: 60 }, (_, index) => ({
      ...base,
      id: `bulk-${index}`,
      text: `第 ${index + 1} 件合成的往事。`,
      since_ms: NOW - index * DAY,
    }));
    const ui = await mount({ api: new FakeApi(data), hash: "#/memories" });
    expect(ui.all('[data-role="memory-list"] .qz-row')).toHaveLength(50);
    expect(text(ui.q('[data-role="memory-shown"]'))).toBe("已显示 50 / 60");
    const more = ui.q<HTMLButtonElement>('[data-action="load-more"]');
    expect(text(more)).toBe("再看 10 件");
    more.click();
    await settle();
    expect(ui.api.callsTo("sea_memories").at(-1)?.params).toEqual({ cursor: "50", limit: 50 });
    expect(ui.all('[data-role="memory-list"] .qz-row')).toHaveLength(60);
    expect(ui.all('[data-action="load-more"]')).toHaveLength(0);
    expect(ui.said()).toContain("又读出 10 件");
  });

  it("还没有任何往事：整页说明它们从哪里来", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()), hash: "#/memories" });
    const situation = ui.q('[data-situation="memories-empty"]');
    expect(text(situation.querySelector("h2"))).toBe("他还没有任何往事");
    expect(situation.querySelectorAll('[data-role="situation-steps"] .qz-cell')).toHaveLength(3);
    expect(ui.all('[data-role="memory-split"]')).toHaveLength(0);
    // 搜索框和分段控件仍然在。
    expect(ui.all('input[type="search"]')).toHaveLength(1);
  });

  it("某一段为空时说明那一段是什么", async () => {
    const data = fullFixture();
    data.memories = data.memories.filter((entry) => !entry.muted);
    const ui = await mount({ api: new FakeApi(data), hash: "#/memories" });
    ui.q<HTMLButtonElement>('[data-filter="muted"]').click();
    await settle();
    expect(text(ui.q('[data-situation="memories-none-muted"]'))).toContain("没有不主动提的往事");
  });

  it("窄屏不自动选中；选中之后正文换成那一条，带「返回列表」", async () => {
    const ui = await mount({ hash: "#/memories", narrow: true });
    const split = ui.q('[data-role="memory-split"]');
    expect(split.classList.contains("has-selection")).toBe(false);
    expect(ui.all(".qz-row.is-current")).toHaveLength(0);

    ui.q<HTMLButtonElement>('[data-entry="mem-2"] .qz-pick').click();
    await settle();
    expect(ui.q('[data-role="memory-split"]').classList.contains("has-selection")).toBe(true);
    const back = ui.q<HTMLButtonElement>('[data-role="memory-back"]');
    expect(document.activeElement).toBe(back);
    back.click();
    await settle();
    expect(ui.q('[data-role="memory-split"]').classList.contains("has-selection")).toBe(false);
    expect(document.activeElement).toBe(ui.q('[data-entry="mem-2"] .qz-pick'));
  });

  it("带着一条往事的 id 进来：直接打开它", async () => {
    const ui = await mount({ hash: "#/memories/mem-5" });
    expect(text(ui.q('[data-role="memory-text"]'))).toBe("发布前一天不合并大改动。");
    expect(ui.q('[data-entry="mem-5"]').classList.contains("is-current")).toBe(true);
  });
});

describe("底线：一份清单与一个签署动作", () => {
  it("已签署：整页的状态词是冰蓝的「自某日起生效」，清单带编号", async () => {
    const ui = await mount({ hash: "#/baseline" });
    const state = ui.q('[data-role="baseline-state"]');
    expect(state.classList.contains("is-ice")).toBe(true);
    expect(text(state)).toMatch(/^自 \d{4}-\d{2}-\d{2} 起生效$/u);
    const clauses = ui.all('[data-role="directives"] .qz-clause');
    expect(clauses).toHaveLength(2);
    expect(text(clauses[0]?.querySelector(".qz-clause-no") ?? null)).toBe("01");
    expect(text(clauses[0]?.querySelector("h3") ?? null)).toBe("不替我做不可逆的决定");
    // 没有改动：没有东西可签，白色按钮停用。
    expect(ui.q<HTMLButtonElement>('[data-action="sign"]').disabled).toBe(true);
    expect(ui.all('[data-role="sign-passphrase"]')).toHaveLength(0);
  });

  it("部署约束列在下方，只读", async () => {
    const ui = await mount({ hash: "#/baseline" });
    const deployment = ui.q('[data-section="deployment"]');
    expect(text(deployment.querySelector("h2"))).toBe("部署约束");
    expect(deployment.querySelectorAll(".qz-cell")).toHaveLength(1);
    expect(deployment.querySelectorAll("button, input, textarea")).toHaveLength(0);
    // 它在你的底线和签署条之后。
    const signBar = ui.q('[data-role="sign-bar"]');
    expect(signBar.compareDocumentPosition(deployment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("未签署：状态词是琥珀的「待签署」，整页说明底线是什么、怎么签", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()), hash: "#/baseline" });
    const state = ui.q('[data-role="baseline-state"]');
    expect(state.classList.contains("is-amber")).toBe(true);
    expect(text(state)).toBe("待签署");
    const situation = ui.q('[data-situation="baseline-empty"]');
    expect(text(situation.querySelector("h2"))).toBe("你还没有写下底线");
    expect(situation.querySelectorAll('[data-role="situation-steps"] .qz-cell')).toHaveLength(3);
    expect(text(situation.querySelector('[data-role="situation-action"]'))).toBe("写第一条");
    expect(ui.all(".qz-btn-white")).toHaveLength(0);
    // 部署约束仍然列在下方。
    expect(ui.all('[data-section="deployment"] .qz-cell')).toHaveLength(1);
  });
});

describe("宿主：每个宿主一行，四格对应四项", () => {
  it("四格的顺序固定：送核心、送往事、收信号、压缩后不丢", async () => {
    const ui = await mount({ hash: "#/hosts" });
    const host = ui.q('[data-host="claude-code"]');
    expect(text(host.querySelector("h2"))).toBe("Claude Code");
    const cells = Array.from(host.querySelectorAll<HTMLElement>('[data-role="host-checks"] .qz-cell'));
    expect(cells.map((cell) => cell.dataset["check"])).toEqual(["core", "recall", "signal", "compaction"]);
    expect(cells.map((cell) => text(cell.querySelector("h3")))).toEqual([
      "送核心",
      "送往事",
      "收信号",
      "压缩后不丢",
    ]);
  });

  it("通的是冰蓝圆点加一句话，不通的是琥珀圆点加下一步", async () => {
    const ui = await mount({ hash: "#/hosts" });
    const ok = ui.q('[data-host="claude-code"] [data-check="core"]');
    expect(text(ok.querySelector(".qz-state.is-ice"))).toBe("通");
    expect(text(ok.querySelector("p"))).toBe("核心与底线在每次调用之前送达。");
    const broken = ui.q('[data-host="claude-code"] [data-check="signal"]');
    expect(text(broken.querySelector(".qz-state.is-amber"))).toBe("不通");
    expect(text(broken.querySelector("p"))).toContain("qz connect");
    expect(text(ui.q('[data-role="view-state"]'))).toBe("1 步不通");
  });

  it("没装的宿主只占一行，写明装上之后怎么接", async () => {
    const ui = await mount({ hash: "#/hosts" });
    const host = ui.q('[data-host="dsh"]');
    expect(text(host.querySelector(".qz-state"))).toBe("未安装");
    expect(host.querySelectorAll('[data-role="host-checks"]')).toHaveLength(0);
    expect(text(host.querySelector(".qz-code-chip"))).toBe("qz connect");
  });

  it("装了没接上的宿主也只占一行，不铺四格一样的「不通」", async () => {
    const ui = await mount({ hash: "#/hosts" });
    const host = ui.q('[data-host="opencode"]');
    expect(text(host.querySelector(".qz-state"))).toBe("未接上");
    expect(host.querySelectorAll('[data-role="host-checks"]')).toHaveLength(0);
    expect(text(host.querySelector('[data-role="host-not-connected"]'))).toContain("装了，还没接上");
  });

  it("选中一项检查，出处栏写明它查的是什么", async () => {
    const ui = await mount({ hash: "#/hosts" });
    ui.q<HTMLButtonElement>('[data-entry="claude-code:signal"] .qz-pick').click();
    expect(text(ui.q('[data-role="provenance-title"]'))).toBe("Claude Code · 收信号");
    expect(text(ui.q('[data-role="provenance-lead"]'))).toBe("调用之后，把这一轮的输出当作信号收回来。");
    expect(text(ui.aside)).toContain("下一步");
  });

  it("一个宿主都没有：整页说明怎么把他接进去", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()), hash: "#/hosts" });
    const situation = ui.q('[data-situation="hosts-empty"]');
    expect(text(situation.querySelector("h2"))).toBe("他还没有住进任何宿主");
    expect(text(situation.querySelector(".qz-cmd-text"))).toBe("qz connect");
    expect(text(ui.q('[data-role="view-state"]'))).toBe("还没有接上");
  });
});

describe("设备：这台在最上，其余按最近在线排序", () => {
  it("这台设备与同步并排在最上；其余设备最近在线的在前", async () => {
    const ui = await mount({ hash: "#/devices" });
    const top = ui.q('[data-role="this-device"]');
    expect(text(top.querySelector("h2"))).toBe("这台设备");
    expect(text(top)).toContain("书房的台式机");
    expect(text(top.querySelector('[data-cell="hub"] .qz-state.is-ice'))).toBe("连着");
    const rows = ui.all('[data-role="other-devices"] .qz-row');
    // fixture 里旧笔记本排在前面；界面按最近在线重排。
    expect(rows.map((row) => text(row.querySelector(".qz-row-text")))).toEqual(["随身的笔记本", "旧笔记本"]);
    // 这台设备不在「其余」里，也没有吊销自己的按钮。
    expect(ui.all('[data-action="revoke"]')).toHaveLength(2);
    expect(top.querySelectorAll('[data-action="revoke"]')).toHaveLength(0);
  });

  it("选中一台设备，出处栏写明它何时加入、最近何时在线", async () => {
    const ui = await mount({ hash: "#/devices" });
    ui.q<HTMLButtonElement>('[data-entry="dev-laptop"] .qz-pick').click();
    const facts = text(ui.q('[data-role="provenance-facts"]'));
    expect(facts).toContain("加入");
    expect(facts).toContain("2 小时前");
    expect(facts).toContain("dev-laptop");
  });

  it("只有这一台：说明怎么再加一台", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()), hash: "#/devices" });
    expect(text(ui.q('[data-situation="devices-only-this"]'))).toContain("他只在这台设备上");
    expect(text(ui.q('[data-section="others"] .qz-cmd-text'))).toBe("qz pair start");
    expect(text(ui.q('[data-cell="hub"] .qz-state'))).toBe("没有接");
  });
});

describe("记录：按天分组的时间线", () => {
  it("每条一行：等宽的时间、动作与对象；按天分组，今天的在最上", async () => {
    const ui = await mount({ hash: "#/audit" });
    const days = ui.all(".qz-timeline-day");
    expect(days.map(text)).toEqual(["11 月 28 日 · 今天", "11 月 27 日 · 昨天", "11 月 2 日", "10 月 29 日"]);
    const rows = ui.all('[data-role="audit-timeline"] .qz-row');
    expect(rows).toHaveLength(5);
    const first = rows[0];
    expect(text(first?.querySelector("time") ?? null)).toMatch(/^\d{2}:\d{2}$/u);
    expect(text(first?.querySelector(".qz-ledger-kind") ?? null)).toBe("记下");
    expect(text(first?.querySelector(".qz-pick") ?? null)).toBe("倾向于先写接口契约");
    // 今天的两条在同一组里。
    expect(ui.all(".qz-timeline")[0]?.querySelectorAll(".qz-row")).toHaveLength(2);
  });

  it("你亲手写入的那几条是琥珀色的节点，并写明「你」", async () => {
    const ui = await mount({ hash: "#/audit" });
    const owner = ui.all('[data-actor="owner"]');
    expect(owner).toHaveLength(2);
    expect(owner.every((row) => row.classList.contains("is-amber"))).toBe(true);
    expect(text(owner[0]?.querySelector(".qz-meta") ?? null)).toBe("你");
  });

  it("选中一条，出处栏显示它写入的完整内容", async () => {
    const ui = await mount({ hash: "#/audit" });
    ui.q<HTMLButtonElement>('[data-entry="4"] .qz-pick').click();
    await settle();
    expect(ui.api.callsTo("sea_memory").at(-1)?.params).toEqual({ id: "pref-2" });
    expect(text(ui.aside)).toContain("评审代码时直说问题，不铺垫。");
    expect(ui.aside.querySelector("a")?.getAttribute("href")).toBe("#/memories/pref-2");
    expect(text(ui.q('[data-role="provenance-facts"]'))).toContain("改");
  });

  it("它写的那一条已经不在了：出处栏照实说", async () => {
    const ui = await mount({ hash: "#/audit" });
    ui.q<HTMLButtonElement>('[data-entry="1"] .qz-pick').click();
    await settle();
    expect(text(ui.q('[data-role="provenance-lead"]'))).toContain("已经不在了");
  });

  it("还没有任何写入：整页说明这里会记下什么", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()), hash: "#/audit" });
    expect(text(ui.q('[data-situation="audit-empty"] h2'))).toBe("还没有任何写入");
  });
});
