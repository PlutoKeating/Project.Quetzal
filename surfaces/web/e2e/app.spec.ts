import { expect, test } from "@playwright/test";

function occurrences(haystack: string | null, needle: string): number {
  if (!haystack) return 0;
  return haystack.split(needle).length - 1;
}

test.describe("脚本化守护进程（mock）上的三态 Web 客户端", () => {
  test("加载即为 Companion，且经 /auth/local 同源认证 + WebSocket 传输", async ({ page }) => {
    const auth = page.waitForResponse((response) => response.url().endsWith("/auth/local"));
    await page.goto("/");
    expect((await auth).status()).toBe(200);
    await expect(page.locator('[data-tier="companion"]')).toBeVisible();
    await expect(page.locator('[data-role="status"]')).toContainText("在线");
    await expect(page.locator('[data-role="transport"]')).toContainText("WebSocket");
    await expect(page.locator('[data-cache-degraded="no-wasm"]')).toBeVisible();
  });

  test("发送消息：流式回复只出现一次于礼貌区，工具卡片只进入断言区", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-tier="companion"]')).toBeVisible();
    const input = page.getByRole("textbox", { name: /说一句话/ });
    await input.fill("帮我整理今天的安排");
    await page.locator('[data-role="composer-submit"]').click();

    const message = page
      .locator('[data-role="messages"] [data-role="message"]')
      .filter({ hasText: "已为你整理" });
    await expect(message).toHaveCount(1);
    await expect(message).toContainText("已为你整理：上午整理共享产物，下午评审路线图。");
    expect(await input.inputValue()).toBe("");

    const polite = page.locator("#qz-live-polite");
    await expect(polite).toContainText("已为你整理：");
    expect(occurrences(await polite.textContent(), "已为你整理：")).toBe(1);

    const assertive = page.locator("#qz-live-assertive");
    await expect(assertive).toContainText("已整理 1 个日程");
    await expect(page.locator('[data-tool-id="tool-1"]')).toBeVisible();
    await expect(page.locator('[data-approval-id="appr-1"]')).toBeVisible();
    expect(await assertive.textContent()).not.toContain("下午评审路线图");
  });

  test("切换 Workbench / Inspector 保留消息与产物状态，焦点落到标题，密度跨刷新保留", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("textbox", { name: /说一句话/ }).fill("整理产物");
    await page.locator('[data-role="composer-submit"]').click();
    await expect(page.locator('[data-role="messages"]')).toContainText("已为你整理");

    await page.locator('[data-density="workbench"]').click();
    await expect(page.locator('[data-tier="workbench"]')).toBeVisible();
    await expect(page.locator('[data-tier="workbench"]')).toContainText("共享产物");
    await expect(page.locator('[data-tier="workbench"] [data-role="messages"]')).toContainText(
      "已为你整理",
    );
    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      tabindex: document.activeElement?.getAttribute("tabindex") ?? "",
      tier: document.activeElement?.closest("[data-tier]")?.getAttribute("data-tier") ?? "",
    }));
    expect(focused.tag).toBe("H1");
    expect(focused.tabindex).toBe("-1");
    expect(focused.tier).toBe("workbench");

    await page.locator('[data-density="inspector"]').click();
    await expect(page.locator('[data-tier="inspector"]')).toBeVisible();
    await expect(page.locator('[data-tier="inspector"] pre.raw-block--full')).toContainText(
      "artifact/roadmap",
    );

    await page.reload();
    await expect(page.locator('[data-tier="inspector"]')).toBeVisible();
  });

  test("键盘-only：Alt+2/Alt+3 切换，无需鼠标", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-tier="companion"]')).toBeVisible();
    await page.keyboard.press("Alt+2");
    await expect(page.locator('[data-tier="workbench"]')).toBeVisible();
    await page.keyboard.press("Alt+3");
    await expect(page.locator('[data-tier="inspector"]')).toBeVisible();
    await page.keyboard.press("Alt+1");
    await expect(page.locator('[data-tier="companion"]')).toBeVisible();
  });

  test("320px 宽 + 200% 字号：零横向溢出、零裁切、主按钮仍 ≥64pt", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/");
    await expect(page.locator('[data-tier="companion"]')).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.waitForTimeout(150);

    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const clipped: string[] = [];
      const selectors = [
        ".btn",
        "h1",
        "[data-role='welcome']",
        "[data-role='composer-input']",
        "[data-role='status']",
      ];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          if (element.scrollWidth > element.clientWidth + 1) {
            clipped.push(`${selector}:${element.textContent?.slice(0, 20) ?? ""}`);
          }
        }
      }
      const buttons = [...document.querySelectorAll<HTMLElement>(".btn")].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          label: (button.textContent ?? "").trim(),
          left: rect.left,
          right: rect.right,
          height: rect.height,
          width: rect.width,
        };
      });
      return {
        horizontalOverflow: root.scrollWidth - root.clientWidth,
        bodyOverflow: document.body.scrollWidth - 320,
        clipped,
        buttons,
      };
    });

    expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(layout.bodyOverflow).toBeLessThanOrEqual(1);
    expect(layout.clipped).toEqual([]);
    expect(layout.buttons.length).toBeGreaterThan(0);
    for (const button of layout.buttons) {
      expect(button.width).toBeGreaterThan(0);
      expect(button.left).toBeGreaterThanOrEqual(-1);
      expect(button.right).toBeLessThanOrEqual(321);
      expect(button.height).toBeGreaterThanOrEqual(64);
    }
    await page.screenshot({ path: "test-results/companion-320px-200pct.png", fullPage: true });
  });

  test("守护进程缺失：类型化降级视图可读、可操作、不白屏", async ({ page }) => {
    await page.route("**/auth/local", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline"}' }),
    );
    await page.goto("/");
    const panel = page.locator('[data-daemon-state="unavailable"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("守护进程");
    await expect(page.locator('[data-role="composer-input"]')).toBeDisabled();
    await expect(page.locator('[data-tier="companion"]')).toBeVisible();
    await expect(page.locator("#qz-live-assertive")).toContainText("守护进程");
    // 离线 alert 绝不能落在 aria-busy 子树中（否则可能被辅助技术抑制）。
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  });

  test("十秒引导可跳过并跨刷新记忆", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-role="onboarding"]')).toBeVisible();
    await page.locator('[data-role="onboarding-skip"]').click();
    await expect(page.locator('[data-role="onboarding"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-tier="companion"]')).toBeVisible();
    await expect(page.locator('[data-role="onboarding"]')).toHaveCount(0);
  });

  test("个人会话下 Workbench 产物提交被禁用并解释原因", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-density="workbench"]').click();
    const commit = page.locator('[data-action="commit-artifact"]').first();
    await expect(commit).toBeDisabled();
    await expect(page.locator('[data-role="commit-hint"]')).toContainText("个人会话");
    await expect(page.locator('[data-role="session"]')).toContainText("个人会话");
  });
});
