import { expect, test } from "@playwright/test";

// 真守护进程冒烟：页面壳由 quetzalcoatld 同源托管并加载，本机握手成功；
// 守护进程一侧的 `sea_*` 还没有就绪时，界面进入「接口未就绪」的版面，而不是白屏或崩溃。

test.describe("真实 quetzalcoatld 同源托管", () => {
  test("页面壳、样式、脚本与字体都由守护进程同源提供", async ({ page }) => {
    const baseUrl = process.env.QZ_REAL_DAEMON_URL;
    // 验收路径：环境原因不许 skip，必须大声失败。
    expect(baseUrl, "globalSetup 必须启动真实 quetzalcoatld").toBeTruthy();
    if (!baseUrl) throw new Error("缺少 QZ_REAL_DAEMON_URL");

    const health = await page.request.get(`${baseUrl}/health`);
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", web: true });

    const shell = await page.request.get(`${baseUrl}/`);
    expect(shell.status()).toBe(200);
    expect(shell.headers()["content-type"] ?? "").toContain("text/html");
    const csp = shell.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await shell.text()).toContain('class="qz-optical-horizon"');

    for (const asset of [
      "/assets/app.js",
      "/assets/styles.css",
      "/assets/optics.js",
      "/assets/fonts/sora-latin-500-normal.woff2",
    ]) {
      const response = await page.request.get(`${baseUrl}${asset}`);
      expect(response.status(), asset).toBe(200);
      expect((await response.body()).byteLength, asset).toBeGreaterThan(500);
    }
  });

  test("本机握手成功，每一页都由真守护进程的接口读出", async ({ page }) => {
    const baseUrl = process.env.QZ_REAL_DAEMON_URL;
    if (!baseUrl) throw new Error("缺少 QZ_REAL_DAEMON_URL");

    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      // 守护进程拒绝一次调用时，浏览器会把那个 4xx 记进控制台；那正是这里要验的情形，不算脚本错误。
      if (message.type() === "error" && !/Failed to load resource/u.test(message.text())) {
        problems.push(`console: ${message.text()}`);
      }
    });

    const handshake = page.waitForResponse((response) => response.url().endsWith("/auth/local"));
    const firstCall = page.waitForResponse((response) => response.url().endsWith("/rpc"));
    await page.goto(`${baseUrl}/`);

    const auth = await handshake;
    expect(auth.status()).toBe(200);
    expect(auth.headers()["content-type"] ?? "").toContain("application/json");
    const session = (await auth.json()) as { token?: string };
    expect(session.token ?? "").toMatch(/^[0-9a-f]{64}$/u);

    const reply = await firstCall;
    expect(reply.request().headers()["authorization"]).toBe(`Bearer ${session.token}`);
    const body = (await reply.json()) as { kind?: string; data?: { code?: string } };

    // 骨架完整：三栏都在，品牌名、八个入口、出处栏都渲染出来了。
    await expect(page.locator('#app[data-boot="ready"]')).toBeVisible();
    await expect(page.locator("#app")).toHaveAttribute("data-connection", "online");
    await expect(page.locator(".qz-brand .qz-wordmark")).toHaveText("Quetzalcoatl");
    await expect(page.locator("nav a")).toHaveCount(8);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator('[data-role="provenance-lead"]')).not.toBeEmpty();
    // 握手是通的，所以不是「联系不上」。
    await expect(page.locator('[data-role="daemon-status"]')).toBeHidden();
    await expect(page.locator('[data-situation="unreachable"]')).toHaveCount(0);

    // 守护进程实现了 sea_*：每一页都读得出来，不会落到「接口未就绪」。
    expect(body.kind).toBe("sea_overview");
    await expect(page.locator('#app [data-view="overview"][data-state="ready"]')).toBeVisible();
    for (const [key, label] of [
      ["self", "他"],
      ["memories", "往事"],
      ["baseline", "底线"],
      ["hosts", "宿主"],
      ["devices", "设备"],
      ["audit", "记录"],
    ] as const) {
      await page.locator(`nav a[data-nav="${key}"]`).click();
      await expect(page.locator(`#app[data-view="${key}"]`)).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(label);
      await expect(page.locator('[data-situation="not-ready"]')).toHaveCount(0);
      await expect(page.locator('[data-situation="failed"]')).toHaveCount(0);
    }

    // 不变量在真守护进程上同样成立。
    await expect(page.locator('input:not([type="range"]):not([type="search"]):not([type="password"]), textarea')).toHaveCount(0);
    expect(await page.locator(".qz-btn-white").count()).toBeLessThanOrEqual(1);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('500 16px "Sora"'))).toBe(true);
    expect(problems).toEqual([]);

    await page.screenshot({ path: "test-results/real-daemon.png", fullPage: true });
  });
});
