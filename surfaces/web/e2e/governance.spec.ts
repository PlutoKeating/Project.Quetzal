import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 治理面在真实 Chromium 里的验收：假守护进程按契约应答，写操作真的改它内存里的数据。

const PASSPHRASE = "mock-passphrase";
const VIEWS = ["", "self", "user", "us", "memories", "baseline", "hosts", "devices", "audit"] as const;
const NARROW = { width: 390, height: 844 };
const BASE_URL = "http://127.0.0.1:43117";

async function reset(request: APIRequestContext, scenario: "full" | "fresh" = "full"): Promise<void> {
  const response = await request.post("/__mock/reset", { data: { scenario } });
  expect(response.ok()).toBe(true);
}

async function open(page: Page, view: string = ""): Promise<void> {
  await page.goto(`/#/${view}`);
  await expect(page.locator('#app[data-boot="ready"]')).toBeVisible();
  await expect(page.locator(`#app[data-view="${view === "" ? "overview" : view}"]`)).toBeVisible();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
}

async function go(page: Page, view: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/${view}`);
  await expect(page.locator(`#app[data-view="${view === "" ? "overview" : view}"]`)).toBeVisible();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
}

function provenance(page: Page) {
  return page.locator('[data-role="provenance"]');
}

/** 页面上此刻用到的每一种有色相的颜色。纯黑、白和灰不算。 */
async function hues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found = new Set<string>();
    const properties = [
      "color",
      "backgroundColor",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
      "outlineColor",
      "textDecorationColor",
    ] as const;
    for (const element of document.querySelectorAll<HTMLElement>("#app *")) {
      // 光谱字标是系统里唯一不是信号的颜色；它靠背景图上色，这里按类名排除。
      if (element.closest(".qz-wordmark")) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      for (const property of properties) {
        const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/u.exec(style[property]);
        if (!match) continue;
        const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
        if (match[4] !== undefined && Number(match[4]) === 0) continue;
        if (r === g && g === b) continue;
        found.add(`${r},${g},${b}`);
      }
    }
    return [...found].sort();
  });
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test.describe("握手与骨架", () => {
  test("经 /auth/local 本机握手，之后每次读取都是带会话令牌的 POST /rpc", async ({ page }) => {
    const handshake = page.waitForResponse((response) => response.url().endsWith("/auth/local"));
    const firstCall = page.waitForRequest((request) => request.url().endsWith("/rpc"));
    await open(page);
    const auth = await handshake;
    expect(auth.status()).toBe(200);
    expect(auth.request().method()).toBe("POST");
    const call = await firstCall;
    expect(call.method()).toBe("POST");
    expect(call.headers()["authorization"]).toMatch(/^Bearer /u);
    expect(call.postDataJSON()).toEqual({ method: "sea_overview" });
    await expect(page.locator("#app")).toHaveAttribute("data-connection", "online");
  });

  test("三栏：导航在左、正文居中、出处在右；两侧是不透明的纯黑", async ({ page }) => {
    await open(page, "self");
    const nav = await page.locator("header.qz-app-nav").boundingBox();
    const main = await page.locator("main").boundingBox();
    const aside = await provenance(page).boundingBox();
    if (!nav || !main || !aside) throw new Error("三栏没有都渲染出来");
    expect(nav.x).toBe(0);
    expect(main.x).toBeGreaterThanOrEqual(nav.x + nav.width - 1);
    expect(aside.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
    // 三栏同高并排，没有哪一栏掉到下面去。
    expect(Math.abs(nav.y - main.y)).toBeLessThan(2);
    expect(Math.abs(aside.y - main.y)).toBeLessThan(2);

    const grounds = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      nav: getComputedStyle(document.querySelector("header.qz-app-nav") as Element).backgroundColor,
      aside: getComputedStyle(document.querySelector('[data-role="provenance"]') as Element).backgroundColor,
      main: getComputedStyle(document.querySelector("main") as Element).backgroundColor,
    }));
    expect(grounds.body).toBe("rgb(0, 0, 0)");
    expect(grounds.nav).toBe("rgb(0, 0, 0)");
    expect(grounds.aside).toBe("rgb(0, 0, 0)");
    // 光只落在正文这一栏：它是透明的，底下是固定的光学地平线。
    expect(grounds.main).toBe("rgba(0, 0, 0, 0)");
    await expect(page.locator(".qz-optical-horizon")).toHaveCount(1);
    await expect(page.locator(".qz-grain")).toHaveCount(1);
  });

  test("当前页在导航里有一条 1.5px 的白线", async ({ page }) => {
    await open(page, "hosts");
    const current = page.locator('nav a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText("宿主");
    const edge = await current.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.borderInlineStartColor,
        // 1.5px 在 1 倍屏上会被浏览器取整到整像素：量它画出来没有，再量设计系统声明的宽度。
        drawn: Number.parseFloat(style.borderInlineStartWidth) >= 1,
        declared: getComputedStyle(document.documentElement).getPropertyValue("--qz-stroke-accent").trim(),
      };
    });
    expect(edge).toEqual({ color: "rgb(255, 255, 255)", drawn: true, declared: "1.5px" });
    // 其余入口的那条线是透明的。
    const others = await page
      .locator('nav a:not([aria-current="page"])')
      .evaluateAll((links) => links.map((link) => getComputedStyle(link).borderInlineStartColor));
    expect(new Set(others)).toEqual(new Set(["rgba(0, 0, 0, 0)"]));
  });

  test("字体随包携带，由同源加载；整个过程没有脚本错误和 CSP 违规", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    const offOrigin: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol !== "data:" && url.origin !== BASE_URL) offOrigin.push(request.url());
    });
    await open(page);
    for (const view of VIEWS) await go(page, view);
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => ({
      sora: document.fonts.check('500 16px "Sora"'),
      mono: document.fonts.check('400 16px "JetBrains Mono"'),
    }));
    expect(fonts).toEqual({ sora: true, mono: true });
    expect(problems).toEqual([]);
    expect(offOrigin).toEqual([]);
  });
});

test.describe("九个视图的主路径", () => {
  test("总览：他的名字、相处第几天，和三格——宿主、等你的事、同步", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ehecatl");
    await expect(page.locator('[data-role="days-together"]')).toHaveText("相处第 214 天");
    const cells = page.locator('[data-role="overview-rail"] > .qz-cell');
    await expect(cells).toHaveCount(3);
    const boxes = await cells.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect()).map(({ x, y }) => ({ x, y })),
    );
    // 三格并排在一行里。
    expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(1);
    expect(boxes[0]?.x).toBeLessThan(boxes[1]?.x ?? 0);
    expect(boxes[1]?.x).toBeLessThan(boxes[2]?.x ?? 0);
    await expect(page.locator('[data-cell="pending"] .qz-state')).toHaveText("3 件");
    await expect(page.locator('[data-cell="sync"] .qz-state')).toHaveText("已同步");

    // 「等你的事」里的每一件都指向能处理它的那一页。
    await page.locator('[data-cell="pending"] a', { hasText: "处变化等你看" }).click();
    await expect(page.locator('#app[data-view="self"]')).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("他");
  });

  test("他：核心价值的栅格，和可以展开证据链的变化时间线", async ({ page }) => {
    await open(page, "self");
    await expect(page.locator('[data-role="core-values"] .qz-cell')).toHaveCount(5);
    await expect(page.locator('[data-role="core-values"] .qz-cell-num').first()).toHaveText("01");
    await expect(page.locator('[data-role="changes"] .qz-timeline-item')).toHaveCount(4);

    const change = page.locator('[data-entry="chg-4"]');
    await change.locator('[data-action="evidence"]').click();
    await expect(change.locator('[data-role="evidence"] .qz-signal')).toHaveCount(3);
    await expect(change.locator('[data-action="evidence"]')).toHaveAttribute("aria-expanded", "true");
    await expect(provenance(page).locator('[data-role="provenance-title"]')).toHaveText(
      "把「守住边界」从性情升为核心",
    );

    await page.locator('[data-entry="cv-2"] .qz-pick').click();
    await expect(page.locator('[data-entry="cv-2"]')).toHaveClass(/is-current/u);
    await expect(provenance(page)).toContainText("7 次相处");
  });

  test("我：两栏对照；改一条之后就地更新，出处栏追加「刚刚由你修改」", async ({ page }) => {
    await open(page, "user");
    const left = await page.locator('[data-column="preferences"]').boundingBox();
    const right = await page.locator('[data-column="facts"]').boundingBox();
    if (!left || !right) throw new Error("两栏没有都渲染出来");
    expect(Math.abs(left.y - right.y)).toBeLessThan(2);
    expect(right.x).toBeGreaterThan(left.x + left.width - 2);

    const row = page.locator('[data-entry="pref-1"]');
    await row.locator(".qz-pick").click();
    await expect(provenance(page)).toContainText("Claude Code");
    await expect(provenance(page)).toContainText("没有被纠正过");

    await row.locator('[data-action="edit"]').click();
    const editor = row.locator('[data-role="entry-edit-text"]');
    await expect(editor).toBeFocused();
    await editor.fill("先给结论，再给理由，最后给出处。");
    await row.locator('[data-action="save"]').click();

    await expect(row.locator(".qz-row-text")).toHaveText("先给结论，再给理由，最后给出处。");
    await expect(row.locator('[data-mark="owner"]')).toHaveText("你说的");
    await expect(provenance(page).locator('[data-role="provenance-recent"]')).toHaveText("刚刚由你修改");
    await expect(provenance(page)).toContainText("纠正 · 你");
    await expect(page.locator('[data-live="polite"]')).toHaveText("已改好这一条。");
    // 没有跳转；刷新之后改动还在：它真的写进了守护进程。
    expect(new URL(page.url()).hash).toBe("#/user");
    await page.reload();
    await expect(page.locator('[data-entry="pref-1"] .qz-row-text')).toHaveText(
      "先给结论，再给理由，最后给出处。",
    );
  });

  test("我们：承诺的栅格，和一根用键盘也能拨的刻度；下限之外去不了", async ({ page }) => {
    await open(page, "us");
    await expect(page.locator('[data-role="commitments"] .qz-cell')).toHaveCount(4);
    const scale = page.locator('[data-role="focus-scale"]');
    await expect(page.locator('input[type="range"]')).toHaveCount(1);
    await expect(scale).toHaveValue("38");

    await scale.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-role="focus-readout"]')).toContainText("我们 40");
    await expect(provenance(page).locator('[data-role="provenance-recent"]')).toHaveText("刚刚由你调节");
    await expect(page.locator('[data-live="polite"]')).toHaveText("已调到：他自己 60，我们 40。");

    // End 键拨到头：停在下限上，过不去。
    await page.locator('[data-role="focus-scale"]').focus();
    await page.keyboard.press("End");
    await expect(page.locator('[data-role="focus-readout"]')).toContainText("他自己 20");
    await expect(page.locator('[data-role="focus-scale"]')).toHaveValue("80");
    await expect(page.locator('[data-live="polite"]')).toHaveText("已调到：他自己 20，我们 80。");

    const stored = await (await page.request.get("/__mock/state")).json();
    expect(stored.focus.self_weight).toBe(0.2);

    // 不可越过的线画在刻度上，位置与下限一致。
    const geometry = await page.evaluate(() => {
      const track = document.querySelector(".qz-scale-track")?.getBoundingClientRect();
      const limit = document.querySelector('[data-role="scale-limit"]')?.getBoundingClientRect();
      if (!track || !limit) return null;
      return (limit.left - track.left) / track.width;
    });
    expect(geometry).not.toBeNull();
    expect(geometry ?? 0).toBeCloseTo(0.8, 2);
  });

  test("往事：主从并排；搜索、分段、翻页", async ({ page }) => {
    await open(page, "memories");
    const list = await page.locator('[data-role="memory-list"]').boundingBox();
    const detail = await page.locator('[data-role="memory-detail"]').boundingBox();
    if (!list || !detail) throw new Error("主从两侧没有都渲染出来");
    expect(detail.x).toBeGreaterThan(list.x + list.width - 2);

    await expect(page.locator('[data-role="memory-list"] .qz-row')).toHaveCount(50);
    await expect(page.locator('[data-role="memory-total"]')).toHaveText("共 57 件");
    await expect(page.locator('[data-role="memory-list"] .qz-row').first()).toHaveClass(/is-current/u);
    await expect(page.locator('[data-role="memory-text"]')).toHaveText("倾向于先写接口契约，再写实现。");

    await page.locator('[data-action="load-more"]').click();
    await expect(page.locator('[data-role="memory-list"] .qz-row')).toHaveCount(57);
    await expect(page.locator('[data-action="load-more"]')).toHaveCount(0);

    await page.getByRole("searchbox", { name: "搜索往事" }).fill("咖啡");
    await expect(page.locator('[data-role="memory-total"]')).toHaveText("共 1 件");
    await expect(page.locator('[data-role="memory-text"]')).toHaveText("喝茶多过喝咖啡。");

    await page.getByRole("searchbox", { name: "搜索往事" }).fill("");
    await page.getByRole("tab", { name: "不主动提" }).click();
    await expect(page.locator('[data-role="memory-total"]')).toHaveText("共 3 件");
    await expect(page.locator('[data-role="memory-list"] [data-mark="muted"]')).toHaveCount(3);
    await page.getByRole("tab", { name: "已过期" }).click();
    await expect(page.locator('[data-role="memory-total"]')).toHaveText("共 4 件");
    await expect(page.locator('[data-role="memory-detail"]')).toContainText("过期");
  });

  test("往事：不主动提是一个开关；抹除要再确认一次", async ({ page }) => {
    await open(page, "memories");
    const detail = page.locator('[data-role="memory-detail"]');
    await detail.locator('[data-action="mute"]').click();
    await expect(detail.locator('[data-action="mute"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-entry="mem-001"] [data-mark="muted"]')).toHaveText("不主动提");
    await expect(provenance(page).locator('[data-role="provenance-recent"]')).toHaveText("刚刚由你修改");
    await expect(provenance(page)).toContainText("设为不主动提 · 你");

    await detail.locator('[data-action="erase"]').click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("它会从所有设备上消失，而且不可恢复。");
    await expect(dialog.locator('[data-role="dialog-cancel"]')).toBeFocused();
    // Esc 取消：什么都没有发生，焦点回到「抹除」。
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-entry="mem-001"]')).toHaveCount(1);
    await expect(detail.locator('[data-action="erase"]')).toBeFocused();

    await detail.locator('[data-action="erase"]').click();
    await page.getByRole("dialog").locator('[data-role="dialog-confirm"]').click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator('[data-entry="mem-001"]')).toHaveCount(0);
    await expect(provenance(page).locator('[data-role="provenance-recent"]')).toHaveText("刚刚由你抹除");
    // 选中移到了下一条，焦点也在那里。
    await expect(page.locator('[data-entry="mem-002"]')).toHaveClass(/is-current/u);
    await expect(page.locator('[data-entry="mem-002"] .qz-pick')).toBeFocused();

    const stored = await (await page.request.get("/__mock/state")).json();
    expect(stored.entries.some((entry: { id: string }) => entry.id === "mem-001")).toBe(false);
    expect(stored.audit[0]).toMatchObject({ kind: "entry_erase", actor: "owner" });
  });

  test("底线：已签署是冰蓝；改一条变成琥珀，重新签署后回到冰蓝", async ({ page }) => {
    await open(page, "baseline");
    const state = page.locator('[data-role="baseline-state"]');
    await expect(state).toHaveText(/^自 \d{4}-\d{2}-\d{2} 起生效$/u);
    await expect(state).toHaveCSS("color", "rgb(186, 230, 253)");
    await expect(page.locator('[data-role="directives"] .qz-clause')).toHaveCount(3);
    await expect(page.locator('[data-section="deployment"] .qz-cell')).toHaveCount(2);
    await expect(page.locator('[data-action="sign"]')).toBeDisabled();

    await page.locator('[data-entry="dir-3"] [data-action="edit-directive"]').click();
    await page.locator('[data-role="directive-text"]').fill("不确定就说不确定，不同意就说不同意，并说出理由。");
    await page.locator('[data-action="finish-directive"]').click();
    await expect(state).toHaveText("有改动待签署");
    await expect(state).toHaveCSS("color", "rgb(229, 160, 61)");

    // 口令不对：没有签成。
    await page.locator('[data-role="sign-passphrase"]').fill("wrong");
    await page.locator('[data-action="sign"]').click();
    await expect(page.locator('[data-role="sign-error"]')).toHaveText("没有签成：口令不对。");
    await expect(state).toHaveText("有改动待签署");

    await page.locator('[data-role="sign-passphrase"]').fill(PASSPHRASE);
    await page.locator('[data-action="sign"]').click();
    await expect(state).toHaveText(/^自 \d{4}-\d{2}-\d{2} 起生效$/u);
    await expect(state).toHaveCSS("color", "rgb(186, 230, 253)");
    await expect(provenance(page).locator('[data-role="provenance-recent"]')).toHaveText("刚刚由你签署");
    const stored = await (await page.request.get("/__mock/state")).json();
    expect(stored.baseline.directives.map((item: { text: string }) => item.text)).toContain(
      "不确定就说不确定，不同意就说不同意，并说出理由。",
    );
  });

  test("底线：从没签过时整页是「待签署」；写下第一条、设定口令并签署", async ({ page, request }) => {
    await reset(request, "fresh");
    await open(page, "baseline");
    await expect(page.locator('[data-role="baseline-state"]')).toHaveText("待签署");
    await expect(page.locator('[data-situation="baseline-empty"]')).toContainText("你还没有写下底线");
    await expect(page.locator('nav a[data-nav="baseline"] [data-role="nav-signal"]')).toHaveCount(1);

    await page.locator('[data-role="situation-action"]').click();
    await expect(page.locator('[data-role="directive-title"]')).toBeFocused();
    await page.locator('[data-role="directive-title"]').fill("不替我做不可逆的决定");
    await page.locator('[data-role="directive-text"]').fill("涉及钱和删除数据的事，必须等我亲口确认。");
    await page.locator('[data-action="finish-directive"]').click();
    await expect(page.locator('[data-role="directives"] .qz-clause')).toHaveCount(1);

    await page.locator('[data-role="sign-passphrase"]').fill("a-new-passphrase");
    await page.locator('[data-role="sign-passphrase-repeat"]').fill("a-new-passphrase");
    await page.locator('[data-action="sign"]').click();
    await expect(page.locator('[data-role="baseline-state"]')).toHaveText(/^自 \d{4}-\d{2}-\d{2} 起生效$/u);
    await expect(page.locator('nav a[data-nav="baseline"] [data-role="nav-signal"]')).toHaveCount(0);
    await expect(page.locator('[data-live="polite"]')).toHaveText("已签署，1 条底线自现在起生效。");
  });

  test("宿主：每个宿主一行四格；通的冰蓝，不通的琥珀并写明下一步", async ({ page }) => {
    await open(page, "hosts");
    const checks = page.locator('[data-host="codex"] [data-role="host-checks"] > .qz-cell');
    await expect(checks).toHaveCount(4);
    const ys = await checks.evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().y)));
    expect(new Set(ys).size).toBe(1);
    await expect(checks.locator("h3")).toHaveText(["送核心", "送往事", "收信号", "压缩后不丢"]);

    const failing = page.locator('[data-host="codex"] [data-check="signal"]');
    await expect(failing.locator(".qz-state")).toHaveText("不通");
    await expect(failing.locator(".qz-state")).toHaveCSS("color", "rgb(229, 160, 61)");
    await expect(failing).toContainText("qz connect");
    const passing = page.locator('[data-host="claude-code"] [data-check="core"]');
    await expect(passing.locator(".qz-state")).toHaveText("通");
    await expect(passing.locator(".qz-state")).toHaveCSS("color", "rgb(186, 230, 253)");

    await failing.locator(".qz-pick").click();
    await expect(provenance(page).locator('[data-role="provenance-title"]')).toHaveText("Codex · 收信号");
    await expect(provenance(page)).toContainText("下一步");
    // 装了没接上、没装：各只占一行，不铺四格。
    await expect(page.locator('[data-host="opencode"]')).toContainText("未接上");
    await expect(page.locator('[data-host="opencode"] [data-role="host-checks"]')).toHaveCount(0);
    await expect(page.locator('[data-host="dsh"]')).toContainText("未安装");
  });

  test("设备：这台在最上；吊销要再次确认并输入口令", async ({ page }) => {
    await open(page, "devices");
    await expect(page.locator('[data-role="this-device"]')).toContainText("书房的台式机");
    const rows = page.locator('[data-role="other-devices"] .qz-row');
    await expect(rows.locator(".qz-row-text")).toHaveText(["随身的笔记本", "客厅的小主机", "旧笔记本"]);
    const top = await page.locator('[data-role="this-device"]').boundingBox();
    const others = await page.locator('[data-role="other-devices"]').boundingBox();
    expect(top?.y ?? 0).toBeLessThan(others?.y ?? 0);

    await page.locator('[data-entry="dev-c41d9a60"] [data-action="revoke"]').click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("吊销「旧笔记本」？");
    await expect(dialog.locator('[data-role="dialog-passphrase"]')).toBeFocused();
    await dialog.locator('[data-role="dialog-passphrase"]').fill("wrong");
    await page.keyboard.press("Enter");
    await expect(dialog.locator('[data-role="dialog-error"]')).toHaveText("没有做成：口令不对。");
    await expect(rows).toHaveCount(3);

    await dialog.locator('[data-role="dialog-passphrase"]').fill(PASSPHRASE);
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    await expect(provenance(page).locator('[data-role="provenance-recent"]')).toHaveText("刚刚由你吊销");
    await expect(page.locator('[data-live="polite"]')).toHaveText("已吊销「旧笔记本」。");
  });

  test("记录：按天分组的时间线；刚才的写入出现在最上面", async ({ page }) => {
    await open(page, "memories");
    await page.locator('[data-role="memory-detail"] [data-action="mute"]').click();
    await expect(page.locator('[data-entry="mem-001"] [data-mark="muted"]')).toHaveCount(1);

    await go(page, "audit");
    await expect(page.locator(".qz-timeline-day").first()).toContainText("今天");
    const first = page.locator('[data-role="audit-timeline"] .qz-row').first();
    await expect(first.locator(".qz-ledger-kind")).toHaveText("不主动提");
    await expect(first).toHaveAttribute("data-actor", "owner");
    await expect(first.locator("time")).toHaveText(/^\d{2}:\d{2}$/u);
    // 一行：时间、动作、对象在同一条基线附近。
    const line = await first.evaluate((row) => {
      const tops = ["time", ".qz-ledger-kind", ".qz-pick"].map(
        (selector) => row.querySelector(selector)?.getBoundingClientRect().top ?? 0,
      );
      return Math.max(...tops) - Math.min(...tops);
    });
    expect(line).toBeLessThan(8);

    await first.locator(".qz-pick").click();
    await expect(provenance(page)).toContainText("倾向于先写接口契约，再写实现。");
    await provenance(page).getByRole("link", { name: "在往事里看它" }).click();
    await expect(page.locator('#app[data-view="memories"]')).toBeVisible();
    await expect(page.locator('[data-role="memory-text"]')).toHaveText("倾向于先写接口契约，再写实现。");

    await go(page, "audit");
    await expect(page.locator('[data-role="audit-timeline"] .qz-row')).toHaveCount(50);
    await page.locator('[data-action="load-more"]').click();
    await expect(page.locator('[data-role="audit-timeline"] .qz-row')).not.toHaveCount(50);
  });
});

test.describe("键盘", () => {
  test("第一下 Tab 是「跳到正文」；导航入口用回车换页，焦点落到新页的标题", async ({ page }) => {
    await open(page);
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-role="skip-link"]')).toBeFocused();
    await expect(page.locator('[data-role="skip-link"]')).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(page.locator(".qz-brand")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('nav a[data-nav="self"]')).toBeFocused();
    // 看得见的焦点：1px 冰蓝的描边。
    const ring = await page.locator('nav a[data-nav="self"]').evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
    });
    expect(ring).toEqual({ style: "solid", width: "1px", color: "rgb(186, 230, 253)" });

    for (let step = 0; step < 3; step += 1) await page.keyboard.press("Tab");
    await expect(page.locator('nav a[data-nav="memories"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('#app[data-view="memories"]')).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page).toHaveTitle("往事 · Quetzalcoatl");
  });

  test("「跳到正文」把焦点交给标题，地址不变", async ({ page }) => {
    await open(page, "hosts");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    expect(new URL(page.url()).hash).toBe("#/hosts");
  });

  test("往事的列表只占一个 Tab 停靠点：方向键在条目间走，回车选中，Tab 直接到右侧的动作", async ({
    page,
  }) => {
    await open(page, "memories");
    await page.getByRole("searchbox", { name: "搜索往事" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tab", { name: "全部" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-entry="mem-001"] .qz-pick')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('[data-entry="mem-003"] .qz-pick')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-entry="mem-003"]')).toHaveClass(/is-current/u);
    await expect(page.locator('[data-entry="mem-003"] .qz-pick')).toBeFocused();
    await expect(page.locator('[data-role="memory-text"]')).toHaveText("技术书先读目录和最后一章。");

    // 50 条往事之后的下一站是「再看」，再下一站就是右侧的三个动作。
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-action="load-more"]')).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-role="memory-detail"] [data-action="edit"]')).toBeFocused();

    // 选中的条目有看得见的焦点环。
    await page.locator('[data-entry="mem-003"] .qz-pick').focus();
    await page.keyboard.press("ArrowUp");
    const ring = await page.locator('[data-entry="mem-002"] .qz-pick').evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { style: style.outlineStyle, color: style.outlineColor };
    });
    expect(ring).toEqual({ style: "solid", color: "rgb(186, 230, 253)" });
  });

  test("对话框把焦点圈在里面；关掉以后焦点回到触发它的按钮", async ({ page }) => {
    await open(page, "devices");
    const revoke = page.locator('[data-entry="dev-9e6f1b35"] [data-action="revoke"]');
    await revoke.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator('[data-role="dialog-passphrase"]')).toBeFocused();
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => document.activeElement?.closest("dialog") !== null);
      // 焦点可以落在浏览器自己的界面上，但绝不会落到对话框后面的页面里。
      const onPage = await page.evaluate(() => document.activeElement?.closest("#app > main, #app > header") !== null);
      expect(inside || !onPage).toBe(true);
      expect(onPage).toBe(false);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(revoke).toBeFocused();
  });

  test("分段控件用方向键切换", async ({ page }) => {
    await open(page, "memories");
    await page.getByRole("tab", { name: "全部" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "不主动提" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "不主动提" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-role="memory-total"]')).toHaveText("共 3 件");
  });
});

test.describe("窄屏（≤ 900px）", () => {
  test.use({ viewport: NARROW });

  test("九个视图都没有横向滚动；导航是顶部的一行，出处在正文下方", async ({ page }) => {
    await open(page);
    for (const view of VIEWS) {
      await go(page, view);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `「${view || "总览"}」有横向滚动`).toBeLessThanOrEqual(0);
      const nav = await page.locator("header.qz-app-nav").boundingBox();
      const main = await page.locator("main").boundingBox();
      const aside = await provenance(page).boundingBox();
      if (!nav || !main || !aside) throw new Error("骨架没有渲染完整");
      expect(nav.y).toBe(0);
      expect(nav.width).toBe(NARROW.width);
      expect(nav.height).toBeLessThan(80);
      expect(main.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
      // 出处栏变成正文下方的一段，同样不留空。
      expect(aside.y).toBeGreaterThanOrEqual(main.y + main.height - 1);
      await expect(provenance(page).locator('[data-role="provenance-lead"]')).not.toBeEmpty();
    }
  });

  test("导航的八个入口在一行里，可以横向滚动到最后一个", async ({ page }) => {
    await open(page);
    const entries = page.locator("nav a");
    await expect(entries).toHaveCount(8);
    const tops = await entries.evaluateAll((links) => links.map((link) => Math.round(link.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    const scroller = page.locator("nav.qz-sidenav");
    const before = await scroller.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
    await expect(page.locator('nav a[data-nav="audit"]')).not.toBeInViewport();

    await page.locator('nav a[data-nav="audit"]').click();
    await expect(page.locator('#app[data-view="audit"]')).toBeVisible();
    // 当前入口自己滚进视野里。
    await expect(page.locator('nav a[data-nav="audit"]')).toBeInViewport();
    await expect(page.locator('nav a[data-nav="audit"]')).toHaveAttribute("aria-current", "page");
  });

  test("选中一条：出处跟到它正下方，三个动作也在那里", async ({ page }) => {
    await open(page, "user");
    const row = page.locator('[data-entry="pref-2"]');
    await row.locator(".qz-pick").click();
    await expect(row.locator('[data-role="provenance"]')).toBeVisible();
    await expect(row.locator('[data-role="provenance-title"]')).toHaveText("评审代码时直说问题，不铺垫。");
    await expect(row.locator('[data-role="entry-actions"] button')).toHaveText(["改", "不主动提", "抹除"]);
    const pick = await row.locator(".qz-pick").boundingBox();
    const aside = await provenance(page).boundingBox();
    const next = await page.locator('[data-entry="pref-3"]').boundingBox();
    if (!pick || !aside || !next) throw new Error("没有量到位置");
    expect(aside.y).toBeGreaterThan(pick.y);
    expect(aside.y + aside.height).toBeLessThanOrEqual(next.y + 1);

    // 取消选中，出处回到正文下方。
    await row.locator(".qz-pick").click();
    await expect(row.locator('[data-role="provenance"]')).toHaveCount(0);
    await expect(provenance(page)).toBeVisible();
  });

  test("对照的两栏上下排开；栅格的每一格占满一行", async ({ page }) => {
    await open(page, "user");
    const left = await page.locator('[data-column="preferences"]').boundingBox();
    const right = await page.locator('[data-column="facts"]').boundingBox();
    if (!left || !right) throw new Error("两栏没有都渲染出来");
    expect(right.y).toBeGreaterThan(left.y + left.height - 2);

    await go(page, "hosts");
    const xs = await page
      .locator('[data-host="codex"] [data-role="host-checks"] > .qz-cell')
      .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().x)));
    expect(new Set(xs).size).toBe(1);
  });

  test("往事：先是列表；选中一件之后换成它的全文，带「返回列表」", async ({ page }) => {
    await open(page, "memories");
    await expect(page.locator('[data-role="memory-list"]')).toBeVisible();
    await expect(page.locator('[data-role="memory-detail"]')).toBeHidden();
    await expect(page.locator(".qz-row.is-current")).toHaveCount(0);

    await page.locator('[data-entry="mem-002"] .qz-pick').click();
    await expect(page.locator('[data-role="memory-list"]')).toBeHidden();
    await expect(page.locator('[data-role="memory-text"]')).toHaveText("早上先处理需要专注的事。");
    await expect(page.locator('[data-role="memory-back"]')).toBeFocused();
    await expect(page.locator('[data-role="memory-detail"] [data-role="entry-actions"] button')).toHaveCount(3);
    await expect(provenance(page)).toContainText("Codex");

    await page.locator('[data-role="memory-back"]').click();
    await expect(page.locator('[data-role="memory-list"]')).toBeVisible();
    await expect(page.locator('[data-entry="mem-002"] .qz-pick')).toBeFocused();
  });

  test("刻度在窄屏上仍然是一根横向的滑杆，手指够得着", async ({ page }) => {
    await open(page, "us");
    const track = await page.locator(".qz-scale-track").boundingBox();
    if (!track) throw new Error("没有刻度");
    expect(track.width).toBeGreaterThan(280);
    expect(track.height).toBeGreaterThanOrEqual(36);
  });
});

test.describe("状态", () => {
  test("刚装好：每一页都是专门的空状态，说明现状和下一步", async ({ page, request }) => {
    await reset(request, "fresh");
    await open(page);
    await expect(page.locator('[data-role="days-together"]')).toHaveText("相处第 1 天");
    await expect(page.locator('[data-cell="hosts"]')).toContainText("qz connect");

    const expected: Array<[string, string, string]> = [
      ["self", "self-empty", "他还没有长出自己的样子"],
      ["user", "user-empty", "他还没有记下关于你的事"],
      ["us", "commitments-empty", "你们还没有共同的承诺"],
      ["memories", "memories-empty", "他还没有任何往事"],
      ["baseline", "baseline-empty", "你还没有写下底线"],
      ["hosts", "hosts-empty", "他还没有住进任何宿主"],
      ["devices", "devices-only-this", "他只在这台设备上"],
      ["audit", "audit-empty", "还没有任何写入"],
    ];
    for (const [view, kind, title] of expected) {
      await go(page, view);
      const situation = page.locator(`[data-situation="${kind}"]`);
      await expect(situation).toBeVisible();
      await expect(situation.getByRole("heading")).toHaveText(title);
      // 不是一行灰字：有状态词、有标题、有一段说明。
      await expect(situation.locator(".qz-state")).toBeVisible();
      const body = (await situation.locator(".qz-situation-body").textContent()) ?? "";
      expect(body.length, view).toBeGreaterThan(30);
      await expect(provenance(page).locator('[data-role="provenance-lead"]')).not.toBeEmpty();
    }
  });

  test("守护进程中途联系不上：保留上一次的内容，导航上方一行琥珀色状态词，写动作不可用；恢复后自己接上", async ({
    page,
  }) => {
    await open(page, "user");
    await page.locator('[data-entry="pref-1"] .qz-pick').click();
    await expect(page.locator('[data-entry="pref-1"] [data-action="edit"]')).toBeEnabled();

    await page.route("**/rpc", (route) => route.abort("connectionrefused"));
    await page.route("**/auth/local", (route) => route.abort("connectionrefused"));
    await go(page, "hosts");
    await expect(page.locator('[data-situation="unreachable"]')).toBeVisible();
    await expect(page.locator('[data-situation="unreachable"] .qz-cmd-text')).toHaveText("qz up");

    const status = page.locator('[data-role="daemon-status"]');
    await expect(status).toBeVisible();
    await expect(status.locator(".qz-state")).toHaveText("联系不上守护进程");
    await expect(status.locator(".qz-state")).toHaveCSS("color", "rgb(229, 160, 61)");
    await expect(status).toContainText("qz up");
    // 它在导航入口的上方。
    const statusBox = await status.boundingBox();
    const navBox = await page.locator("nav").boundingBox();
    expect((statusBox?.y ?? 0) + (statusBox?.height ?? 0)).toBeLessThanOrEqual((navBox?.y ?? 0) + 1);

    // 读过的那一页保留着上一次的内容，写动作全部停用。
    await go(page, "user");
    await expect(page.locator('[data-column="preferences"] .qz-row')).toHaveCount(5);
    await expect(page.locator('[data-situation="unreachable"]')).toHaveCount(0);
    for (const action of ["edit", "mute", "erase"]) {
      await expect(page.locator(`[data-entry="pref-1"] [data-action="${action}"]`)).toBeDisabled();
    }

    await page.unroute("**/rpc");
    await page.unroute("**/auth/local");
    await expect(page.locator("#app")).toHaveAttribute("data-connection", "online", { timeout: 15_000 });
    await expect(status).toBeHidden();
    await expect(page.locator('[data-entry="pref-1"] [data-action="edit"]')).toBeEnabled();
  });

  test("一开始就联系不上：不是白屏，是「联系不上」的版面；启动之后点重试就读出来", async ({ page }) => {
    await page.route("**/auth/local", (route) => route.abort("connectionrefused"));
    await page.goto("/#/memories");
    await expect(page.locator('#app[data-boot="ready"]')).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("往事");
    await expect(page.locator('[data-situation="unreachable"]')).toContainText("联系不上本机的守护进程");
    await expect(page.locator('[data-role="daemon-status"]')).toBeVisible();

    await page.unroute("**/auth/local");
    await page.locator('[data-role="situation-action"]').click();
    await expect(page.locator('[data-role="memory-list"] .qz-row')).toHaveCount(50);
    await expect(page.locator('[data-role="daemon-status"]')).toBeHidden();
  });

  test("接口返回错误：写明代码和原因，可以重试", async ({ page, request }) => {
    await request.post("/__mock/fail", {
      data: { method: "sea_devices", code: "STORAGE_ERROR", detail: "脊柱暂时读不出来。" },
    });
    await open(page, "devices");
    const situation = page.locator('[data-situation="failed"]');
    await expect(situation).toContainText("这一页没有读出来");
    await expect(situation).toContainText("脊柱暂时读不出来。");
    await expect(situation).toContainText("STORAGE_ERROR");
    await expect(page.locator("#app")).toHaveAttribute("data-connection", "online");
    await situation.locator('[data-role="situation-action"]').click();
    await expect(page.locator('[data-role="this-device"]')).toBeVisible();
  });

  test("接口未就绪：握手成功但方法不被认识，进入专门的版面而不是白屏", async ({ page, request }) => {
    await request.post("/__mock/fail", {
      data: {
        method: "sea_self",
        code: "PERMISSION_DENIED",
        detail: "该方法不允许经 Web 控制台调用",
        status: 403,
      },
    });
    await open(page, "self");
    const situation = page.locator('[data-situation="not-ready"]');
    await expect(situation.locator(".qz-state")).toHaveText("接口未就绪");
    await expect(situation).toContainText("sea_self");
    await expect(situation.locator('[data-role="situation-steps"] .qz-cell')).toHaveCount(3);
    await expect(page.locator('[data-role="daemon-status"]')).toBeHidden();
  });

  test("写操作失败：就地写明原因并播报，原来的内容不动", async ({ page, request }) => {
    await open(page, "memories");
    await request.post("/__mock/fail", {
      data: { method: "sea_entry_mute", code: "STORAGE_ERROR", detail: "脊柱暂时写不进去。" },
    });
    await page.locator('[data-role="memory-detail"] [data-action="mute"]').click();
    await expect(page.locator('[data-role="entry-error"]')).toHaveText("没有改成：脊柱暂时写不进去。");
    await expect(page.locator('[data-live="assertive"]')).toHaveText("没有改成：脊柱暂时写不进去。");
    await expect(page.locator('[data-entry="mem-001"] [data-mark="muted"]')).toHaveCount(0);
    await expect(page.locator('[data-role="provenance-recent"]')).toHaveCount(0);
  });
});

test.describe("产品不变量与设计系统的硬规则", () => {
  /** 全站仅有的文本输入：往事搜索、改一条时的文本、底线短句、口令。 */
  const ALLOWED = [
    "memory-search",
    "entry-edit-text",
    "directive-title",
    "directive-text",
    "sign-passphrase",
    "sign-passphrase-repeat",
    "dialog-passphrase",
  ];

  for (const scenario of ["full", "fresh"] as const) {
    test(`全站没有可以「发给他一句话」的输入框，每一屏至多一个白色主按钮（${scenario}）`, async ({
      page,
      request,
    }) => {
      await reset(request, scenario);
      await open(page);
      for (const view of VIEWS) {
        await go(page, view);
        const label = view || "总览";
        const inputs = await page
          .locator('input:not([type="range"]), textarea, [contenteditable="true"], [role="textbox"]')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-role") ?? ""));
        for (const role of inputs) expect(ALLOWED, `「${label}」里有不该有的输入框`).toContain(role);
        await expect(page.locator(".qz-btn-white"), `「${label}」`).toHaveCount(
          view === "baseline" && scenario === "full" ? 1 : 0,
        );
        await expect(page.getByRole("button", { name: /发送|发给|说一句|聊/u })).toHaveCount(0);
        await expect(page.locator('[role="log"]')).toHaveCount(0);
      }
    });
  }

  test("把每一种编辑状态都打开，也没有第二个白色按钮，没有别的输入框", async ({ page }) => {
    await open(page, "user");
    await page.locator('[data-entry="pref-1"] .qz-pick').click();
    await page.locator('[data-entry="pref-1"] [data-action="edit"]').click();
    await expect(page.locator(".qz-btn-white")).toHaveCount(0);
    await expect(page.locator("textarea")).toHaveCount(1);

    await go(page, "memories");
    await page.locator('[data-role="memory-detail"] [data-action="erase"]').click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".qz-btn-white")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await go(page, "baseline");
    await page.locator('[data-action="add-directive"]').click();
    await expect(page.locator(".qz-btn-white")).toHaveCount(1);
    await expect(page.locator(".qz-btn-white")).toHaveText("签署");

    await go(page, "devices");
    await page.locator('[data-action="revoke"]').first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".qz-btn-white")).toHaveCount(0);
    await expect(page.getByRole("dialog").locator("input")).toHaveAttribute("type", "password");
  });

  test("除了光谱字标，页面上有色相的颜色只有冰蓝与琥珀", async ({ page }) => {
    await open(page);
    const seen = new Set<string>();
    for (const view of VIEWS) {
      await go(page, view);
      for (const hue of await hues(page)) seen.add(hue);
    }
    // 把交互状态也带上：选中、展开、编辑、对话框。
    await go(page, "user");
    await page.locator('[data-entry="pref-2"] .qz-pick').click();
    await page.locator('[data-entry="pref-2"] [data-action="edit"]').click();
    for (const hue of await hues(page)) seen.add(hue);
    await go(page, "devices");
    await page.locator('[data-action="revoke"]').first().click();
    for (const hue of await hues(page)) seen.add(hue);

    expect([...seen].sort()).toEqual(["186,230,253", "229,160,61"]);
  });

  test("标题字重 500，没有加粗；除了浮层没有阴影；没有内联样式属性", async ({ page }) => {
    await open(page);
    for (const view of VIEWS) {
      await go(page, view);
      const report = await page.evaluate(() => {
        const heavy: string[] = [];
        const shadows: string[] = [];
        const headings: string[] = [];
        for (const element of document.querySelectorAll<HTMLElement>("#app *")) {
          const style = getComputedStyle(element);
          const weight = Number(style.fontWeight);
          // 字重 600 只属于字标。
          if (weight > 500 && !element.closest(".qz-brand")) heavy.push(`${element.tagName}.${element.className}`);
          if (style.boxShadow !== "none") shadows.push(`${element.tagName}.${element.className}`);
          if (/^H[1-6]$/u.test(element.tagName) && weight !== 500 && !element.classList.contains("qz-sr-only")) {
            headings.push(`${element.tagName}:${weight}`);
          }
        }
        return {
          heavy,
          shadows,
          headings,
          // 光学脚本与刻度经 CSSOM 写自定义属性；除此之外不该有任何内联声明。
          inline: Array.from(document.querySelectorAll<HTMLElement>("#app [style]")).flatMap((element) =>
            Array.from(element.style).filter((name) => !name.startsWith("--qz-")),
          ),
        };
      });
      expect(report, `「${view || "总览"}」`).toEqual({ heavy: [], shadows: [], headings: [], inline: [] });
    }

    // 浮层是唯一有阴影的地方。
    await go(page, "devices");
    await page.locator('[data-action="revoke"]').first().click();
    await expect(page.getByRole("dialog")).not.toHaveCSS("box-shadow", "none");
  });

  test("没有任何东西在滑动或缩放：过渡只作用于颜色与透明度", async ({ page }) => {
    await open(page);
    for (const view of VIEWS) {
      await go(page, view);
      const moving = await page.evaluate(() => {
        const allowed = new Set([
          "all",
          "none",
          "opacity",
          "color",
          "background",
          "background-color",
          "border-color",
          "border-top-color",
          "border-right-color",
          "border-bottom-color",
          "border-left-color",
          "border-inline-start-color",
          "text-decoration-color",
        ]);
        const found: string[] = [];
        for (const element of document.querySelectorAll<HTMLElement>("#app *")) {
          const style = getComputedStyle(element);
          if (style.animationName !== "none") found.push(`animation on ${element.className}`);
          if (style.transform !== "none") found.push(`transform on ${element.className}`);
          const durations = style.transitionDuration.split(",").map((value) => Number.parseFloat(value));
          if (durations.every((value) => value === 0)) continue;
          for (const property of style.transitionProperty.split(",")) {
            if (!allowed.has(property.trim())) found.push(`${property.trim()} on ${element.className}`);
          }
        }
        return found;
      });
      expect(moving, `「${view || "总览"}」`).toEqual([]);
    }
  });

  test("界面的文字里没有感叹号，也没有表情符号", async ({ page, request }) => {
    for (const scenario of ["full", "fresh"] as const) {
      await reset(request, scenario);
      await open(page);
      for (const view of VIEWS) {
        await go(page, view);
        const text = (await page.locator("#app").textContent()) ?? "";
        expect(text, `「${view || "总览"}」`).not.toMatch(/[!！]/u);
        expect(text, `「${view || "总览"}」`).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });
});
