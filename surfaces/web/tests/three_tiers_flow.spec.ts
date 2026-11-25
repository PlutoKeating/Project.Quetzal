import { describe, expect, it } from "vitest";
import { QuetzalcoatlApp } from "../src/app.js";
import { DaemonUnavailable, type AppTransport, type TransportHandlers } from "../src/transport/client.js";
import { createSpineCache } from "../src/cache/wasm_cache.js";

const encoder = new TextEncoder();

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

class FakeTransport implements AppTransport {
  handlers: TransportHandlers | null = null;
  sent: string[] = [];
  commits: string[] = [];
  closed = false;

  async commitArtifact(key: string): Promise<{ ok: boolean; detail: string }> {
    this.commits.push(key);
    return { ok: true, detail: `已提交 ${key}` };
  }

  async connect(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async sendChat(text: string): Promise<void> {
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
  }

  emit(mutate: (handlers: TransportHandlers) => void): void {
    if (!this.handlers) throw new Error("transport 未连接");
    mutate(this.handlers);
  }
}

async function boot() {
  const root = document.createElement("div");
  document.body.append(root);
  const transport = new FakeTransport();
  const storage = memoryStorage();
  const cache = await createSpineCache({ probe: async () => ({ available: false }) });
  await cache.set("draft", encoder.encode("草稿"));
  const app = new QuetzalcoatlApp(root, { transport, storage, cache });
  await app.start();
  return { root, transport, storage, app };
}

describe("三档视图端到端语义", () => {
  it("默认 Companion：零术语欢迎、64pt 触控目标与可用输入", async () => {
    const { root } = await boot();
    const tier = root.querySelector('[data-tier="companion"]');
    expect(tier).not.toBeNull();
    expect(root.querySelector('[data-role="welcome"]')?.textContent).toContain("羽蛇神");
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.classList.contains("btn")).toBe(true);
    }
    const composer = root.querySelector<HTMLTextAreaElement>("[data-role='composer-input']");
    expect(composer).not.toBeNull();
    expect(composer?.getAttribute("aria-label") ?? "").not.toBe("");
    expect(root.querySelector("[data-role='composer-submit']")).not.toBeNull();
    expect(root.querySelector("[data-cache-degraded='no-wasm']")?.textContent).toContain("内存");
  });

  it("发送消息后流式回复只出现一次，工具卡片进入断言通道", async () => {
    const { root, transport } = await boot();
    const input = root.querySelector<HTMLTextAreaElement>("[data-role='composer-input']");
    if (!input) throw new Error("缺少输入框");
    input.value = "帮我整理今天的安排";
    root.querySelector<HTMLButtonElement>("[data-role='composer-submit']")?.click();
    expect(transport.sent).toEqual(["帮我整理今天的安排"]);

    transport.emit((handlers) => {
      handlers.onToken({ messageId: "m1", seq: 1, text: "今天" });
      handlers.onToken({ messageId: "m1", seq: 2, text: "只有" });
      handlers.onToken({ messageId: "m1", seq: 3, text: "一件事。" });
      // 重发：保持幂等，不重复朗读。
      handlers.onToken({ messageId: "m1", seq: 2, text: "只有" });
      handlers.onToolCard({
        kind: "tool",
        id: "tool-1",
        title: "已整理 1 个日程",
      });
    });

    const messages = root.querySelector('[data-role="messages"]');
    const messageText = messages?.textContent ?? "";
    expect(messageText.match(/今天只有一件事。/g)).toHaveLength(1);
    const polite = root.querySelector("#qz-live-polite")?.textContent ?? "";
    expect(polite.match(/今天只有一件事。/g)).toHaveLength(1);
    const assertive = root.querySelector("#qz-live-assertive")?.textContent ?? "";
    expect(assertive).toContain("已整理 1 个日程");
    expect(assertive).not.toContain("今天只有一件事。");
    expect(root.querySelector('[data-tool-id="tool-1"]')).not.toBeNull();
  });

  it("切换 Workbench / Inspector 保留全部状态且焦点落到标题", async () => {
    const { root, storage } = await boot();
    root.querySelector<HTMLButtonElement>('[data-density="workbench"]')?.click();
    expect(root.querySelector('[data-tier="workbench"]')).not.toBeNull();
    expect(storage.getItem("qz.web.density")).toBe("workbench");
    const heading = root.querySelector<HTMLElement>('[data-tier="workbench"] h1');
    expect(heading?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);

    root.querySelector<HTMLButtonElement>('[data-density="inspector"]')?.click();
    expect(root.querySelector('[data-tier="inspector"]')).not.toBeNull();
    expect(root.querySelector('[data-tier="inspector"] [data-role="raw"]')).not.toBeNull();
    expect(storage.getItem("qz.web.density")).toBe("inspector");

    root.querySelector<HTMLButtonElement>('[data-density="companion"]')?.click();
    expect(root.querySelector('[data-tier="companion"]')).not.toBeNull();
  });

  it("Inspector 下收到 ViewPatch 仍保持原始层披露（密度不被服务端拉回）", async () => {
    const { root, transport } = await boot();
    transport.emit((handlers) => {
      handlers.onSnapshot({
        rev: 1,
        density: "workbench",
        rows: {
          "artifact/a": {
            key: "artifact/a",
            kind: "artifact",
            summary: "共享产物",
            detail: "细节层",
            raw_json: '{"oid":"abc"}',
            updated_rev: 1,
          },
        },
      });
    });
    root.querySelector<HTMLButtonElement>('[data-density="inspector"]')?.click();
    transport.emit((handlers) => {
      handlers.onPatch({
        from_rev: 1,
        to_rev: 2,
        density: "workbench",
        ops: [
          {
            op: "upsert",
            row: {
              key: "artifact/b",
              kind: "artifact",
              summary: "新产物",
              detail: "新细节",
              raw_json: '{"oid":"def"}',
              updated_rev: 2,
            },
          },
        ],
      });
    });
    const inspector = root.querySelector('[data-tier="inspector"]');
    expect(inspector).not.toBeNull();
    expect(inspector?.textContent).toContain("新产物");
    expect(inspector?.querySelector("pre.raw-block--full")?.textContent).toContain("artifact/b");
  });

  it("Alt+2 键盘切换到 Workbench（无需鼠标）", async () => {
    const { root } = await boot();
    const event = new KeyboardEvent("keydown", {
      key: "2",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(root.querySelector('[data-tier="workbench"]')).not.toBeNull();
  });

  it("审批事件在断言通道播报且卡片按钮可键盘聚焦", async () => {
    const { root, transport } = await boot();
    transport.emit((handlers) => {
      handlers.onToolCard({
        kind: "approval",
        id: "appr-1",
        title: "是否允许读取共享产物？",
      });
    });
    const card = root.querySelector('[data-approval-id="appr-1"]');
    expect(card).not.toBeNull();
    expect(root.querySelector("#qz-live-assertive")?.textContent).toContain(
      "是否允许读取共享产物？",
    );
    const approve = card?.querySelector<HTMLButtonElement>('[data-action="approve"]');
    expect(approve?.tagName).toBe("BUTTON");
    approve?.focus();
    expect(document.activeElement).toBe(approve);
  });

  it("守护进程缺失时渲染类型化降级面板，输入被禁用且不抛异常", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const transport: AppTransport = {
      connect: async () => {
        throw new DaemonUnavailable("/auth/local 503");
      },
      sendChat: async () => undefined,
      close: () => undefined,
    };
    const app = new QuetzalcoatlApp(root, { transport, storage: memoryStorage() });
    await expect(app.start()).resolves.toBeUndefined();
    const panel = root.querySelector('[data-daemon-state="unavailable"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("守护进程");
    const input = root.querySelector<HTMLTextAreaElement>("[data-role='composer-input']");
    expect(input?.disabled).toBe(true);
  });
});


function artifactSnapshot(sessionKind: "personal" | "group") {
  return {
    rev: 1,
    density: "workbench" as const,
    rows: {
      "artifact/md/SOUL.md": {
        key: "artifact/md/SOUL.md",
        kind: "artifact",
        summary: "共享产物 · SOUL.md",
        detail: "本机脊柱 Markdown 产物",
        raw_json: '{"name":"SOUL.md"}',
        updated_rev: 1,
      },
      "session/active": {
        key: "session/active",
        kind: "session",
        summary: sessionKind === "group" ? "群组会话 · room-1" : "个人会话",
        detail:
          sessionKind === "group"
            ? "提交产物会发布到当前群组纪元。"
            : "提交产物需要先加入群组房间；当前为个人会话。",
        raw_json:
          sessionKind === "group"
            ? '{"kind":"group","room_id":"room-1"}'
            : '{"kind":"personal"}',
        updated_rev: 1,
      },
    },
  };
}

describe("Ring 2：繁忙态、补丁删除与产物提交", () => {
  it("认证未决时不闪离线面板，失败后移除 aria-busy 并播报错误", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const deferred: { reject?: (error: unknown) => void } = {};
    const transport: AppTransport = {
      connect: () =>
        new Promise<void>((_resolve, reject) => {
          deferred.reject = reject;
        }),
      sendChat: async () => undefined,
      close: () => undefined,
    };
    const app = new QuetzalcoatlApp(root, { transport, storage: memoryStorage() });
    const started = app.start();
    await Promise.resolve();
    expect(root.querySelector('[data-daemon-state="unavailable"]')).toBeNull();
    expect(root.querySelector('[data-role="status"]')?.textContent).toContain("正在连接");
    expect(root.getAttribute("aria-busy")).toBe("true");

    deferred.reject?.(new DaemonUnavailable("GET /auth/local 返回 503"));
    await started;
    expect(root.querySelector('[data-daemon-state="unavailable"]')).not.toBeNull();
    expect(root.getAttribute("aria-busy")).toBeNull();
    expect(root.querySelector("#qz-live-assertive")?.textContent).toContain("守护进程");
  });

  it("补丁中的 remove 必须同步删除对话记录", async () => {
    const { root, transport } = await boot();
    transport.emit((handlers) => {
      handlers.onSnapshot({
        rev: 1,
        density: "workbench",
        rows: {
          "chat/rm-1": {
            key: "chat/rm-1",
            kind: "assistant",
            summary: "这条消息应被删除",
            updated_rev: 1,
          },
        },
      });
    });
    expect(root.querySelector('[data-role="messages"]')?.textContent).toContain("这条消息应被删除");
    transport.emit((handlers) => {
      handlers.onPatch({
        from_rev: 1,
        to_rev: 2,
        density: "workbench",
        ops: [{ op: "remove", key: "chat/rm-1" }],
      });
    });
    expect(root.querySelector('[data-role="messages"]')?.textContent).not.toContain(
      "这条消息应被删除",
    );
  });

  it("个人会话：Workbench 提交按钮禁用并解释原因", async () => {
    const { root, transport } = await boot();
    transport.emit((handlers) => handlers.onSnapshot(artifactSnapshot("personal")));
    root.querySelector<HTMLButtonElement>('[data-density="workbench"]')?.click();
    const commit = root.querySelector<HTMLButtonElement>('[data-action="commit-artifact"]');
    expect(commit?.disabled).toBe(true);
    const hint = root.querySelector('[data-role="commit-hint"]');
    expect(hint?.textContent).toContain("个人会话");
    expect(commit?.getAttribute("aria-describedby")).toBe(hint?.id);
  });

  it("群组会话：提交按钮调用真实 transport 并播报结果", async () => {
    const { root, transport } = await boot();
    transport.emit((handlers) => handlers.onSnapshot(artifactSnapshot("group")));
    root.querySelector<HTMLButtonElement>('[data-density="workbench"]')?.click();
    const commit = root.querySelector<HTMLButtonElement>('[data-action="commit-artifact"]');
    expect(commit?.disabled).toBe(false);
    commit?.click();
    await new Promise((done) => setTimeout(done, 10));
    expect(transport.commits).toEqual(["artifact/md/SOUL.md"]);
    expect(root.querySelector("#qz-live-polite")?.textContent).toContain("已提交");
  });

  it("快照中的 assistant 行按 UTF-16 码元确定性排序", async () => {
    const { root, transport } = await boot();
    transport.emit((handlers) => {
      handlers.onSnapshot({
        rev: 1,
        density: "workbench",
        rows: {
          "chat/z": {
            key: "chat/z",
            kind: "assistant",
            summary: "消息之 z",
            updated_rev: 1,
          },
          "chat/A": {
            key: "chat/A",
            kind: "assistant",
            summary: "消息之 A",
            updated_rev: 1,
          },
        },
      });
    });
    const items = [...root.querySelectorAll('[data-role="messages"] [data-message-id]')].map(
      (item) => item.getAttribute("data-message-id"),
    );
    expect(items).toEqual(["A", "z"]);
  });
});
