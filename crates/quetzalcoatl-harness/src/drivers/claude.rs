#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Claude Code 驱动（剥离 `refresh_token` 的 `CLAUDE_CONFIG_DIR` 挂载与 stream-json/ACP 桥接）。

use quetzalcoatl_types::Result;

use crate::discovery::CodingAgentKind;
use crate::drivers::acp::run_plan_and_collect_events;
use crate::drivers::{
    HarnessDriver, HarnessLaunchContext, HarnessLaunchPlan, HarnessRunOutcome,
    build_common_sandbox_env,
};

#[derive(Clone, Debug, Default)]
pub struct ClaudeCodeDriver;

impl HarnessDriver for ClaudeCodeDriver {
    fn kind(&self) -> CodingAgentKind {
        CodingAgentKind::ClaudeCode
    }

    fn build_launch_plan(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessLaunchPlan> {
        let mut env = build_common_sandbox_env(ctx);
        env.insert(
            String::from("ANTHROPIC_BASE_URL"),
            ctx.gateway_grant.run_base_url.clone(),
        );
        env.insert(
            String::from("ANTHROPIC_CUSTOM_HEADERS"),
            format!("x-qz-token: {}", ctx.gateway_grant.qz_token),
        );
        Ok(HarnessLaunchPlan {
            program: ctx.binary_path.clone(),
            args: vec![
                String::from("-p"),
                String::from("--output-format"),
                String::from("stream-json"),
                String::from("--verbose"),
                String::from("--setting-sources"),
                String::from("user"),
                String::from(prompt),
            ],
            cwd: ctx.workspace_dir.clone(),
            env,
        })
    }

    fn execute_turn(&self, ctx: &HarnessLaunchContext, prompt: &str) -> Result<HarnessRunOutcome> {
        let plan = self.build_launch_plan(ctx, prompt)?;
        run_plan_and_collect_events(CodingAgentKind::ClaudeCode, &plan)
    }
}
