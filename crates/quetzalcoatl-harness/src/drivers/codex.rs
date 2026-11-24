#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Codex `v0.163+` 驱动（双覆盖 `-c openai_base_url` 与 `-c model_providers.<active>.base_url`，严禁 `chatgpt_base_url`）。

use quetzalcoatl_types::{QuetzalcoatlError, Result};

use crate::discovery::CodingAgentKind;
use crate::drivers::acp::run_plan_and_collect_events;
use crate::drivers::{
    HarnessDriver, HarnessLaunchContext, HarnessLaunchPlan, HarnessRunOutcome,
    build_common_sandbox_env,
};

#[derive(Clone, Debug, Default)]
pub struct CodexDriver;

impl CodexDriver {
    pub fn validate_plan(plan: &HarnessLaunchPlan) -> Result<()> {
        let joined = plan.args.join(" ");
        if joined.contains("chatgpt_base_url")
            || plan
                .env
                .keys()
                .any(|k| k.eq_ignore_ascii_case("chatgpt_base_url"))
        {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("防坑规范 #3：Codex 启动参数严禁设置 chatgpt_base_url"),
            });
        }
        if !joined.contains("openai_base_url=") || !joined.contains(".base_url=") {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from(
                    "防坑规范 #3：Codex 必须同时覆盖 -c openai_base_url 与 -c model_providers.<active>.base_url",
                ),
            });
        }
        Ok(())
    }
}

impl HarnessDriver for CodexDriver {
    fn kind(&self) -> CodingAgentKind {
        CodingAgentKind::Codex
    }

    fn build_launch_plan(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessLaunchPlan> {
        let mut env = build_common_sandbox_env(ctx);
        env.insert(
            String::from("OPENAI_API_KEY"),
            ctx.gateway_grant.ephemeral_stub_token.clone(),
        );
        let provider = if ctx.active_codex_provider.trim().is_empty() {
            "openai"
        } else {
            ctx.active_codex_provider.trim()
        };
        let openai_url = format!("{}/openai/v1", ctx.gateway_grant.run_base_url);
        let codex_backend_url = format!(
            "{}/chatgpt/backend-api/codex",
            ctx.gateway_grant.run_base_url
        );

        let plan = HarnessLaunchPlan {
            program: ctx.binary_path.clone(),
            args: vec![
                String::from("exec"),
                String::from("--json"),
                String::from("-c"),
                format!("openai_base_url=\"{openai_url}\""),
                String::from("-c"),
                format!("model_providers.{provider}.base_url=\"{codex_backend_url}\""),
                String::from(prompt),
            ],
            cwd: ctx.workspace_dir.clone(),
            env,
        };
        Self::validate_plan(&plan)?;
        Ok(plan)
    }

    fn execute_turn(&self, ctx: &HarnessLaunchContext, prompt: &str) -> Result<HarnessRunOutcome> {
        let plan = self.build_launch_plan(ctx, prompt)?;
        run_plan_and_collect_events(CodingAgentKind::Codex, &plan)
    }
}
