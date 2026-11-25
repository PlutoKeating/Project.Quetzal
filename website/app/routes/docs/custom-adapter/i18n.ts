import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "自定义 Agent 适配器",
    doc: {
      title: "自定义 Agent 适配器",
      description: "HarnessDriver 契约：内置驱动、事件流映射、网关环境变量与为什么暂不支持运行时加载第三方适配器。",
      lead:
        "Quetzalcoatl 不重造底层 ReAct 编码循环。它纳管你已经在用的编码 Agent；要新增一种 Agent，就实现一个 `HarnessDriver`。",
      blocks: [
        { kind: "h2", id: "builtin", text: "内置驱动" },
        {
          kind: "table",
          head: ["Agent", "驱动", "备注"],
          rows: [
            ["OpenCode V2", "`OpenCodeDriver`", "默认推荐；`opencode run --format json` 事件流"],
            ["Claude Code", "`ClaudeDriver`", "`stream-json` 输出；凭据由回环网关托管"],
            ["Codex CLI", "`CodexDriver`", "`codex exec --json`；WebSocket 426 时自动回退 HTTP SSE"],
            ["Pi", "`AcpJsonRpcDriver`", "`pi` 与数学工具同名，必须用 `--version` 特征串正验"],
            ["Goose / Hermes / 其它 ACP", "`AcpJsonRpcDriver`", "按 ACP / JSON-RPC 行协议解析"],
          ],
        },
        { kind: "h2", id: "contract", text: "驱动契约" },
        {
          kind: "code",
          title: "rust",
          text: `pub trait HarnessDriver: Send + Sync {
    fn kind(&self) -> CodingAgentKind;

    /// 只负责「怎么启动」：命令、参数、环境与沙箱包裹方式。
    fn build_launch_plan(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessLaunchPlan>;

    /// 跑完一轮，把子进程事件映射成 HarnessEvent 序列。
    fn execute_turn(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessRunOutcome>;
}`,
        },
        {
          kind: "p",
          text:
            "`HarnessRunOutcome` 里的 `changed_files` 与 `unified_diff` 是洁净室验收的输入；不要把未提交的改动留在 worktree 里让验收自己去猜。",
        },
        { kind: "h2", id: "rules", text: "必须遵守的约束" },
        {
          kind: "ul",
          items: [
            "**供应商名不进内核**：模型名、通道名、CLI 名只出现在 harness crate 的驱动里。",
            "**不直连模型 API**：子进程只拿到网关地址 `QUETZALCOATL_GATEWAY_URL` 与工作区 `QUETZALCOATL_SANDBOX_WORKSPACE`；真正的订阅令牌在网关外，由 `quetzalcoatld` 出站瞬间换上。",
            "**事件必须结构化**：每行输出映射为 `HarnessEvent`（增量文本、工具调用、审批请求、结束原因），不要只回传一整段 stdout。",
            "**默认沙箱**：通过 `quetzalcoatl-sandbox-exec` 包裹执行；驱动不得自行放宽文件系统或网络权限。",
            "**可复现的测试**：用假 CLI 脚本回放固定的 JSON 行，断言事件序列与 diff，不联网。",
          ],
        },
        {
          kind: "code",
          title: "text",
          text: `QUETZALCOATL_GATEWAY_URL=http://127.0.0.1:<port>/run/<cap_token>
QUETZALCOATL_SANDBOX_WORKSPACE=/path/to/isolated/worktree
SHELL=<quetzalcoatl-sandbox-exec>
# 没有供应商 API Key，也不应该有`,
        },
        { kind: "h2", id: "loading", text: "注册与加载：编译期，而不是运行时插件" },
        {
          kind: "p",
          text:
            "目前新增驱动需要新建一个 crate 并编译进 harness（工作区 `[lints] workspace = true`，`#![forbid(unsafe_code)]`）。运行时 dlopen 第三方 `.so` / `.dll` 尚未开放：它会绕过 Rust 的静态检查与发布签名这条供应链，代价大于收益。等有明确的签名与权限模型后再谈。",
        },
        { kind: "h2", id: "when-not", text: "什么时候不该写适配器" },
        {
          kind: "ul",
          items: [
            "只是换模型或改系统提示词——用底层 Agent 自己的配置，Quetzalcoatl 只注入良知与记忆。",
            "只是想要不同的输出格式——先看驱动是否只是事件映射问题。",
            "想绕过沙箱或网关——这不是适配器的职责，也不会被接受。",
          ],
        },
        {
          kind: "p",
          text:
            "参考实现见仓库的 `crates/quetzalcoatl-harness/src/drivers/`（`opencode.rs`、`claude.rs`、`codex.rs`、`pi.rs`、`acp.rs`）。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Custom agent adapters",
    doc: {
      title: "Custom agent adapters",
      description: "The HarnessDriver contract: built-in drivers, event stream mapping, gateway environment and why runtime-loaded third-party adapters are not supported yet.",
      lead:
        "Quetzalcoatl does not rebuild the underlying ReAct coding loop. It manages coding agents you already use; supporting a new one means implementing a `HarnessDriver`.",
      blocks: [
        { kind: "h2", id: "builtin", text: "Built-in drivers" },
        {
          kind: "table",
          head: ["Agent", "Driver", "Notes"],
          rows: [
            ["OpenCode V2", "`OpenCodeDriver`", "Default recommendation; `opencode run --format json` event stream"],
            ["Claude Code", "`ClaudeDriver`", "`stream-json` output; credentials are held by the loopback gateway"],
            ["Codex CLI", "`CodexDriver`", "`codex exec --json`; falls back to HTTP SSE on a WebSocket 426"],
            ["Pi", "`AcpJsonRpcDriver`", "`pi` collides with a maths tool, so its `--version` fingerprint is required"],
            ["Goose / Hermes / other ACP", "`AcpJsonRpcDriver`", "Parsed as an ACP / JSON-RPC line protocol"],
          ],
        },
        { kind: "h2", id: "contract", text: "The driver contract" },
        {
          kind: "code",
          title: "rust",
          text: `pub trait HarnessDriver: Send + Sync {
    fn kind(&self) -> CodingAgentKind;

    /// Only "how to launch": command, arguments, environment and sandbox wrapping.
    fn build_launch_plan(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessLaunchPlan>;

    /// Run one turn and map child-process events to a HarnessEvent stream.
    fn execute_turn(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessRunOutcome>;
}`,
        },
        {
          kind: "p",
          text:
            "`changed_files` and `unified_diff` in `HarnessRunOutcome` feed the clean-room acceptance step. Do not leave uncommitted changes in the worktree and expect the verifier to infer them.",
        },
        { kind: "h2", id: "rules", text: "Rules you must follow" },
        {
          kind: "ul",
          items: [
            "**No vendor names in the kernel**: model names, channel names and CLI names appear only inside drivers in the harness crate.",
            "**Never talk to model APIs directly**: the child gets `QUETZALCOATL_GATEWAY_URL` and `QUETZALCOATL_SANDBOX_WORKSPACE`; real subscription tokens live outside the sandbox and are swapped in by `quetzalcoatld` at egress.",
            "**Structure the events**: map every line to a `HarnessEvent` (delta text, tool call, approval request, stop reason) instead of returning one blob of stdout.",
            "**Sandbox by default**: run through `quetzalcoatl-sandbox-exec`; a driver may not widen filesystem or network permissions.",
            "**Reproducible tests**: replay fixed JSON lines from a fake CLI and assert the event sequence and diff; no network.",
          ],
        },
        {
          kind: "code",
          title: "text",
          text: `QUETZALCOATL_GATEWAY_URL=http://127.0.0.1:<port>/run/<cap_token>
QUETZALCOATL_SANDBOX_WORKSPACE=/path/to/isolated/worktree
SHELL=<quetzalcoatl-sandbox-exec>
# no vendor API keys, and there should not be any`,
        },
        { kind: "h2", id: "loading", text: "Registration: compile-time, not a runtime plugin" },
        {
          kind: "p",
          text:
            "Adding a driver today means a new crate compiled into the harness (workspace lints, `#![forbid(unsafe_code)]`). Loading third-party `.so` / `.dll` at runtime is deliberately not supported: it would bypass Rust's static checks and the signed release supply chain. That conversation can reopen once there is a signature and permission model for plugins.",
        },
        { kind: "h2", id: "when-not", text: "When not to write an adapter" },
        {
          kind: "ul",
          items: [
            "You only want another model or a different system prompt — use the underlying agent's own configuration. Quetzalcoatl injects conscience and memory.",
            "You only want a different output shape — check whether it is just an event-mapping change in an existing driver.",
            "You want to bypass the sandbox or gateway — that is not an adapter's job and will not be accepted.",
          ],
        },
        {
          kind: "p",
          text: "See the reference implementations in `crates/quetzalcoatl-harness/src/drivers/` (`opencode.rs`, `claude.rs`, `codex.rs`, `pi.rs`, `acp.rs`).",
        },
      ],
    },
  },
};
