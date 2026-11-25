import { expect, test } from "@playwright/test";

// WASM 缓存宿主是可选构建资产（scripts/build-web-wasm.sh）。
// 默认构建不含 wasm，因此本用例默认跳过；以 `QZ_WEB_WITH_WASM=1` 构建并把
// `QZ_WEB_EXPECT_WASM=1` 传给 Playwright 时，本用例必须在真实 Chromium 上通过。
const enabled = process.env.QZ_WEB_EXPECT_WASM === "1";

test.describe("WASM OPFS 单写者缓存（可选资产）", () => {
  test.skip(!enabled, "未以 QZ_WEB_WITH_WASM=1 构建时跳过该可选资产用例");

  test("真实 Chromium 写入 OPFS，并在刷新后自动恢复草稿", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-role="cache"]')).toContainText("OPFS 单写者");
    await expect(page.locator('[data-cache-degraded]')).toHaveCount(0);

    const input = page.getByRole("textbox", { name: /说一句话/ });
    await input.fill("OPFS 持久草稿");
    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.getByRole("textbox", { name: /说一句话/ })).toHaveValue("OPFS 持久草稿");
  });
});
