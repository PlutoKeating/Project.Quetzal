#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Claude Code 驱动（剥离 `refresh_token` 的 `CLAUDE_CONFIG_DIR` 挂载、无 OAuth 时 `ANTHROPIC_API_KEY` 存根兜底与渐进钩子绑定）。

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

        let has_oauth_stub = ctx.claude_stub_dir.as_ref().is_some_and(|dir| {
            dir.join(".credentials.json").is_file() || dir.join("credentials.json").is_file()
        });
        if !has_oauth_stub {
            env.insert(
                String::from("ANTHROPIC_API_KEY"),
                ctx.gateway_grant.ephemeral_stub_token.clone(),
            );
        }

        if let Some(enh_root) = &ctx.enhancers_root_dir {
            env.insert(
                String::from("QUETZALCOATL_CLAUDE_HOOKS_PATH"),
                enh_root
                    .join("claude-code-hooks/src/index.ts")
                    .to_string_lossy()
                    .into_owned(),
            );
        }

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
        run_plan_and_collect_events(
            CodingAgentKind::ClaudeCode,
            &plan,
            ctx.sandbox_binding.as_ref(),
        )
    }
}
