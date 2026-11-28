import { describe, expect, it, vi } from "vitest";
import { navSignals } from "../src/app.js";
import { ALL_VIEWS, hrefFor, PAGES, parseRoute } from "../src/shell/routes.js";
import { FakeApi, freshFixture, fullFixture } from "./fake_api.js";
import { mount, settle } from "./harness.js";

const EVERY_HASH = ALL_VIEWS.map((view) => hrefFor(view.key));

describe("骨架：三栏各有固定职责", () => {
  it("左是导航、中是正文、右是出处，各是一个地标", async () => {
    const ui = await mount();
    expect(ui.root.classList.contains("qz-app")).toBe(true);
    expect(ui.all("header.qz-app-nav")).toHaveLength(1);
    expect(ui.all("nav")).toHaveLength(1);
    expect(ui.q("nav").getAttribute("aria-label")).toBe("页面");
    expect(ui.all("main")).toHaveLength(1);
    expect(ui.all("aside")).toHaveLength(1);
    expect(ui.aside.getAttribute("aria-labelledby")).toBe("sea-provenance-label");
    expect(ui.q("#sea-provenance-label").textContent).toBe("出处");
    expect(ui.root.dataset["boot"]).toBe("ready");
    expect(ui.root.dataset["connection"]).toBe("online");
  });

  it("导航是八页的入口，顺序固定；品牌名包着光谱字标并回到总览", async () => {
    const ui = await mount();
    const entries = ui.all<HTMLAnchorElement>("nav a");
    expect(entries.map((entry) => entry.dataset["nav"])).toEqual([
      "self",
      "user",
      "us",
      "memories",
      "baseline",
      "hosts",
      "devices",
      "audit",
    ]);
    expect(entries.map((entry) => entry.querySelector("span")?.textContent)).toEqual([
      "他",
      "我",
      "我们",
      "往事",
      "底线",
      "宿主",
      "设备",
      "记录",
    ]);
    const brand = ui.q<HTMLAnchorElement>(".qz-brand");
    expect(brand.getAttribute("href")).toBe("#/");
    expect(brand.querySelector(".qz-wordmark")?.textContent).toBe("Quetzalcoatl");
    expect(brand.getAttribute("aria-current")).toBe("page");
    // 光谱字标只出现这一处。
    expect(ui.all(".qz-wordmark")).toHaveLength(1);
  });

  it("换页：当前入口带 aria-current，标题成为焦点，页面标题跟着变", async () => {
    const ui = await mount();
    await ui.go("#/memories");
    expect(ui.q('nav a[data-nav="memories"]').getAttribute("aria-current")).toBe("page");
    expect(ui.all('nav a[aria-current="page"]')).toHaveLength(1);
    expect(ui.q(".qz-brand").hasAttribute("aria-current")).toBe(false);
    expect(document.title).toBe("往事 · Quetzalcoatl");
    expect(document.activeElement).toBe(ui.q("main h1"));
    expect(ui.q("main h1").textContent).toBe("往事");

    await ui.go("#/");
    expect(document.title).toBe("Quetzalcoatl");
    expect(ui.q("main h1").textContent).toBe("Ehecatl");
    expect(document.activeElement).toBe(ui.q("main h1"));
  });

  it("每一页恰好一个一级标题", async () => {
    const ui = await mount();
    for (const hash of EVERY_HASH) {
      await ui.go(hash);
      expect(ui.all("h1"), hash).toHaveLength(1);
    }
  });

  it("不认识的地址回到总览", () => {
    expect(parseRoute("#/nowhere").info.key).toBe("overview");
    expect(parseRoute("").info.key).toBe("overview");
    expect(parseRoute("#/memories/mem%2F1")).toMatchObject({ info: { key: "memories" }, param: "mem/1" });
    expect(hrefFor("memories", "mem/1")).toBe("#/memories/mem%2F1");
  });

  it("「跳到正文」把焦点交给这一页的标题，不改地址", async () => {
    const ui = await mount({ hash: "#/hosts" });
    const skip = ui.q<HTMLAnchorElement>('[data-role="skip-link"]');
    skip.click();
    expect(document.activeElement).toBe(ui.q("main h1"));
    expect(window.location.hash).toBe("#/hosts");
  });
});

describe("出处栏永不留空", () => {
  it("没有选中时是这一页的一句话说明", async () => {
    const ui = await mount();
    for (const view of ALL_VIEWS) {
      await ui.go(hrefFor(view.key));
      const lead = ui.q('[data-role="provenance-lead"]').textContent ?? "";
      expect(lead.length, view.key).toBeGreaterThan(8);
      if (view.key !== "memories") {
        // 往事在宽屏下自动选中第一条；其余各页此刻都没有选中。
        expect(lead, view.key).toBe(view.sentence);
        expect(ui.aside.dataset["selected"]).toBe("false");
      }
    }
  });

  it("刚装好、什么都没有的时候同样不留空", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()) });
    for (const view of ALL_VIEWS) {
      await ui.go(hrefFor(view.key));
      expect(ui.q('[data-role="provenance-lead"]').textContent, view.key).toBe(view.sentence);
    }
  });

  it("窄屏下出处跟到选中的那一条里面；取消选中就回到正文下方", async () => {
    const ui = await mount({ hash: "#/user", narrow: true });
    expect(ui.aside.previousElementSibling).toBe(ui.main);
    ui.q<HTMLButtonElement>('[data-entry="pref-1"] .qz-pick').click();
    await settle();
    const row = ui.q('[data-entry="pref-1"]');
    expect(row.contains(ui.aside)).toBe(true);
    expect(ui.aside.classList.contains("is-following")).toBe(true);
    expect(ui.q('[data-role="provenance-title"]').textContent).toBe("回答先给结论，再给理由。");

    ui.q<HTMLButtonElement>('[data-entry="pref-1"] .qz-pick').click();
    await settle();
    expect(ui.aside.previousElementSibling).toBe(ui.main);
    expect(ui.aside.classList.contains("is-following")).toBe(false);
  });

  it("宽屏下出处始终留在右栏", async () => {
    const ui = await mount({ hash: "#/user" });
    ui.q<HTMLButtonElement>('[data-entry="pref-1"] .qz-pick').click();
    await settle();
    expect(ui.aside.previousElementSibling).toBe(ui.main);
    expect(ui.aside.dataset["selected"]).toBe("true");
  });
});

describe("导航上的信号点：只表示有事在等你", () => {
  it("他变了、底线没签、没有宿主、同步落后，各在自己的入口旁", () => {
    const overview = fullFixture().overview;
    expect(Object.keys(navSignals(overview))).toEqual(["self"]);
    expect(navSignals(overview).self).toEqual({ count: 1, text: "1 处变化等你看" });

    const fresh = freshFixture().overview;
    expect(Object.keys(navSignals(fresh)).sort()).toEqual(["baseline", "hosts"]);

    const behind = { ...overview, sync: { ...overview.sync, state: "behind" as const } };
    expect(navSignals(behind).devices?.text).toBe("同步落后");
    expect(navSignals(null)).toEqual({});
  });

  it("信号点带着读屏能读到的文字，颜色不是唯一信号", async () => {
    const ui = await mount();
    const signal = ui.q('nav a[data-nav="self"] [data-role="nav-signal"]');
    expect(signal.querySelector(".qz-sr-only")?.textContent).toBe("1 处变化等你看");
    expect(signal.querySelector(".qz-dot.is-amber")).not.toBeNull();
    expect(ui.all('[data-role="nav-signal"]')).toHaveLength(1);
  });
});

describe("守护进程联系不上", () => {
  it("第一次就联系不上：每一页都是「联系不上」的版面，说明下一步", async () => {
    const api = new FakeApi();
    api.down = true;
    const ui = await mount({ api, hash: "#/memories" });
    expect(ui.root.dataset["connection"]).toBe("unreachable");
    const situation = ui.q('[data-situation="unreachable"]');
    expect(situation.textContent).toContain("联系不上本机的守护进程");
    expect(situation.querySelector(".qz-cmd-text")?.textContent).toBe("qz up");
    expect(situation.querySelector('[data-role="situation-action"]')?.textContent).toBe("重试");
    // 页面的名字还在，出处栏也没有留空。
    expect(ui.q("main h1").textContent).toBe("往事");
    expect(ui.q('[data-role="provenance-lead"]').textContent?.length).toBeGreaterThan(8);
    expect(ui.alerted()).toContain("联系不上本机的守护进程");
  });

  it("导航上方出现一行琥珀色状态词与下一步", async () => {
    const api = new FakeApi();
    api.down = true;
    const ui = await mount({ api });
    const status = ui.q('[data-role="daemon-status"]');
    expect(status.hidden).toBe(false);
    expect(status.querySelector(".qz-state.is-amber")?.textContent).toBe("联系不上守护进程");
    expect(status.querySelector(".qz-code-chip")?.textContent).toBe("qz up");
    // 它在导航栏里、导航入口之前。
    const nav = ui.q("nav");
    expect(status.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ui.q("header.qz-app-nav").contains(status)).toBe(true);
  });

  it("中途断开：整页保留上一次的内容，所有写动作不可用；连上之后恢复", async () => {
    const api = new FakeApi();
    const ui = await mount({ api, hash: "#/user", retryMs: 20 });
    ui.q<HTMLButtonElement>('[data-entry="pref-1"] .qz-pick').click();
    await settle();
    const writes = (): HTMLButtonElement[] => ui.all<HTMLButtonElement>("[data-write]");
    expect(writes().length).toBeGreaterThanOrEqual(3);
    expect(writes().every((control) => !control.disabled)).toBe(true);
    expect(ui.q('[data-role="daemon-status"]').hidden).toBe(true);

    api.down = true;
    // 去一页从没读过的：它读不出来，骨架由此得知守护进程断了。再回到读过的这一页。
    await ui.go("#/us");
    expect(ui.all('[data-situation="unreachable"]')).toHaveLength(1);
    await ui.go("#/user");
    await vi.waitFor(() => expect(ui.root.dataset["connection"]).toBe("unreachable"));
    // 上一次的内容还在。
    expect(ui.all('[data-column="preferences"] .qz-row')).toHaveLength(2);
    expect(ui.all('[data-situation="unreachable"]')).toHaveLength(0);
    expect(writes().length).toBeGreaterThanOrEqual(3);
    expect(writes().every((control) => control.disabled)).toBe(true);
    expect(ui.q('[data-role="daemon-status"]').hidden).toBe(false);

    api.down = false;
    await vi.waitFor(() => expect(ui.root.dataset["connection"]).toBe("online"), { timeout: 2000 });
    await settle();
    expect(ui.q('[data-role="daemon-status"]').hidden).toBe(true);
    expect(writes().every((control) => !control.disabled)).toBe(true);
    expect(ui.said()).toContain("重新连上了守护进程");
  });

  it("「重试」立刻再读一遍", async () => {
    const api = new FakeApi();
    api.down = true;
    const ui = await mount({ api, hash: "#/hosts" });
    api.down = false;
    ui.q<HTMLButtonElement>('[data-role="situation-action"]').click();
    await vi.waitFor(() => expect(ui.all('[data-role="host-checks"]').length).toBeGreaterThan(0));
    expect(ui.root.dataset["connection"]).toBe("online");
  });
});

describe("接口返回错误", () => {
  it("接口未就绪：握手成功但方法不被认识，每一页都进入专门的版面", async () => {
    const api = new FakeApi();
    const ui = await mount({ api });
    for (const page of PAGES) {
      const method = (
        {
          self: "sea_self",
          user: "sea_user",
          us: "sea_us",
          memories: "sea_memories",
          baseline: "sea_baseline",
          hosts: "sea_hosts",
          devices: "sea_devices",
          audit: "sea_audit",
        } as const
      )[page.key as Exclude<typeof page.key, "overview">];
      api.failNext(method, "PERMISSION_DENIED", "该方法不允许经 Web 控制台调用", 403);
      await ui.go(hrefFor(page.key));
      const situation = ui.q('[data-situation="not-ready"]');
      expect(situation.querySelector(".qz-state")?.textContent, page.key).toBe("接口未就绪");
      expect(situation.textContent).toContain(method);
      expect(situation.querySelectorAll('[data-role="situation-steps"] .qz-cell')).toHaveLength(3);
      expect(ui.q("main h1").textContent).toBe(page.label);
      // 守护进程是联系得上的：不出现「联系不上」那一行。
      expect(ui.root.dataset["connection"]).toBe("online");
      expect(ui.q('[data-role="daemon-status"]').hidden).toBe(true);
    }
  });

  it("总览在接口未就绪时用页名当标题，重试成功后换回他的名字", async () => {
    const api = new FakeApi();
    api.failNext("sea_overview", "PERMISSION_DENIED", "该方法不允许经 Web 控制台调用", 403);
    const ui = await mount({ api });
    expect(ui.q("main h1").textContent).toBe("总览");
    expect(ui.all('[data-situation="not-ready"]')).toHaveLength(1);
    ui.q<HTMLButtonElement>('[data-role="situation-action"]').click();
    await vi.waitFor(() => expect(ui.q("main h1").textContent).toBe("Ehecatl"));
    expect(ui.all('[data-situation="not-ready"]')).toHaveLength(0);
  });

  it("普通的读取失败：写明代码与原因，可以重试", async () => {
    const api = new FakeApi();
    api.failNext("sea_devices", "STORAGE_ERROR", "脊柱暂时读不出来。");
    const ui = await mount({ api, hash: "#/devices" });
    const situation = ui.q('[data-situation="failed"]');
    expect(situation.textContent).toContain("这一页没有读出来");
    expect(situation.textContent).toContain("脊柱暂时读不出来。");
    expect(situation.textContent).toContain("STORAGE_ERROR");
    ui.q<HTMLButtonElement>('[data-role="situation-action"]').click();
    await vi.waitFor(() => expect(ui.all('[data-role="this-device"]')).toHaveLength(1));
  });
});

describe("产品不变量", () => {
  /** 全站仅有的文本输入：往事搜索、改一条时的文本、底线短句、口令。 */
  const ALLOWED_INPUTS = new Set([
    "memory-search",
    "entry-edit-text",
    "directive-title",
    "directive-text",
    "sign-passphrase",
    "sign-passphrase-repeat",
    "dialog-passphrase",
    "focus-scale",
  ]);

  it("没有任何地方可以输入一句话发给他", async () => {
    const ui = await mount();
    for (const hash of EVERY_HASH) {
      await ui.go(hash);
      for (const control of ui.all<HTMLElement>("input, textarea, [contenteditable]")) {
        expect(ALLOWED_INPUTS.has(control.dataset["role"] ?? ""), `${hash}: ${control.outerHTML}`).toBe(true);
      }
      // 没有发送按钮，没有对话记录。
      const labels = ui.all("button").map((button) => button.textContent ?? "");
      expect(labels.some((label) => /发送|发给|说一句|聊/u.test(label)), hash).toBe(false);
      expect(ui.all('[role="log"], [data-role="messages"], [data-role="composer-input"]')).toHaveLength(0);
    }
  });

  it("每一屏至多一个白色主按钮，而且只在底线页", async () => {
    const ui = await mount();
    for (const view of ALL_VIEWS) {
      await ui.go(hrefFor(view.key));
      expect(ui.all(".qz-btn-white"), view.key).toHaveLength(view.key === "baseline" ? 1 : 0);
      if (view.key === "baseline") expect(ui.q(".qz-btn-white").textContent).toBe("签署");
    }
  });

  it("什么都没有的时候同样没有白色按钮以外的主操作", async () => {
    const ui = await mount({ api: new FakeApi(freshFixture()) });
    for (const view of ALL_VIEWS) {
      await ui.go(hrefFor(view.key));
      expect(ui.all(".qz-btn-white").length, view.key).toBeLessThanOrEqual(1);
    }
  });

  it("界面的文字里没有感叹号", async () => {
    const ui = await mount();
    for (const hash of EVERY_HASH) {
      await ui.go(hash);
      expect(ui.root.textContent ?? "", hash).not.toMatch(/[!！]/u);
    }
  });
});
