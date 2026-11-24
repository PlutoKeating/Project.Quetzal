#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Pi `v1.6+` RPC 驱动（`pi --mode rpc`）。

use quetzalcoatl_types::Result;

use crate::discovery::CodingAgentKind;
use crate::drivers::acp::run_plan_and_collect_events;
use crate::drivers::{
    HarnessDriver, HarnessLaunchContext, HarnessLaunchPlan, HarnessRunOutcome,
    build_common_sandbox_env,
};

#[derive(Clone, Debug, Default)]
pub struct PiDriver;

impl HarnessDriver for PiDriver {
    fn kind(&self) -> CodingAgentKind {
        CodingAgentKind::Pi
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
            String::from("ANTHROPIC_API_KEY"),
            ctx.gateway_grant.ephemeral_stub_token.clone(),
        );
        Ok(HarnessLaunchPlan {
            program: ctx.binary_path.clone(),
            args: vec![
                String::from("--mode"),
                String::from("rpc"),
                String::from("-p"),
                String::from(prompt),
            ],
            cwd: ctx.workspace_dir.clone(),
            env,
        })
    }

    fn execute_turn(&self, ctx: &HarnessLaunchContext, prompt: &str) -> Result<HarnessRunOutcome> {
        let plan = self.build_launch_plan(ctx, prompt)?;
        run_plan_and_collect_events(CodingAgentKind::Pi, &plan)
    }
}
