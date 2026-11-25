import { expect, test } from "@playwright/test";

test.describe("真实 quetzalcoatld 同源托管验收", () => {
  test("浏览器经 /auth/local 认证并渲染 Companion 外壳（WebSocket /rpc）", async ({ page }) => {
    const baseUrl = process.env.QZ_REAL_DAEMON_URL;
    // 验收路径：环境原因不许 skip，必须大声失败。
    expect(baseUrl, "globalSetup 必须启动真实 quetzalcoatld").toBeTruthy();
    if (!baseUrl) throw new Error("缺少 QZ_REAL_DAEMON_URL");

    const auth = page.waitForResponse((response) => response.url().endsWith("/auth/local"));
    await page.goto(`${baseUrl}/`);
    const authResponse = await auth;
    expect(authResponse.status()).toBe(200);
    expect(authResponse.headers()["content-type"] ?? "").toContain("application/json");

    await expect(page.locator('[data-tier="companion"]')).toBeVisible();
    await expect(page.locator('[data-role="status"]')).toContainText("在线");
    await expect(page.locator('[data-role="transport"]')).toContainText("WebSocket");

    const health = await page.request.get(`${baseUrl}/health`);
    expect(health.status()).toBe(200);
    const healthBody = (await health.json()) as { status?: string; web?: boolean };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.web).toBe(true);

    // 同源页面确实执行了静态资源与 CSP 头，而非空壳 HTML。
    const csp = (await page.request.get(`${baseUrl}/`)).headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    await page.screenshot({
      path: "test-results/real-daemon-companion.png",
      fullPage: true,
    });
  });

  test("真实守护进程的状态经 ViewPatch 落到 Workbench 与 Inspector", async ({ page }) => {
    const baseUrl = process.env.QZ_REAL_DAEMON_URL;
    if (!baseUrl) throw new Error("缺少 QZ_REAL_DAEMON_URL");
    await page.goto(`${baseUrl}/`);
    await expect(page.locator('[data-tier="companion"]')).toBeVisible();

    await page.locator('[data-density="workbench"]').click();
    await expect(page.locator('[data-tier="workbench"]')).toBeVisible();
    await expect(page.locator('[data-tier="workbench"]')).toContainText("本机守护进程");
    // 真实脊柱 Markdown 产物必须作为 artifact 行出现，且个人会话禁止提交。
    const artifact = page.locator('[data-tier="workbench"] [data-row-kind="artifact"]').first();
    await expect(artifact).toBeVisible();
    await expect(artifact).toContainText("SOUL.md");
    await expect(page.locator('[data-action="commit-artifact"]').first()).toBeDisabled();
    await expect(page.locator('[data-role="commit-hint"]')).toContainText("个人会话");

    await page.locator('[data-density="inspector"]').click();
    const raw = page.locator('[data-tier="inspector"] pre.raw-block--full');
    await expect(raw).toBeVisible();
    await expect(raw).toContainText("agent_id");
    // 真实良知树必须渲染，且只披露结构字段（ROOT/OPERATOR 层级）。
    await expect(
      page.locator('[data-tier="inspector"] [data-row-kind="conscience"]').first(),
    ).toBeVisible();
    await expect(page.locator('[data-tier="inspector"]')).toContainText("ROOT 100");
    await expect(page.locator('[data-tier="inspector"]')).toContainText("受保护条目");
    await page.screenshot({ path: "test-results/real-daemon-inspector.png", fullPage: true });
  });
});
