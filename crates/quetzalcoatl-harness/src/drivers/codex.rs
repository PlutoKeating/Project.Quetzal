#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Codex `v0.163+` 驱动（双覆盖 `-c openai_base_url` 与 `-c model_providers.<active>.base_url`，按 ChatGPT OAuth / OpenAI API Key 自动分流且严禁 `chatgpt_base_url`）。

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
        if let Some(enh_root) = &ctx.enhancers_root_dir {
            env.insert(
                String::from("QUETZALCOATL_CODEX_HOOKS_PATH"),
                enh_root
                    .join("codex-hooks/src/index.ts")
                    .to_string_lossy()
                    .into_owned(),
            );
        }

        let provider = if ctx.active_codex_provider.trim().is_empty() {
            "openai"
        } else {
            ctx.active_codex_provider.trim()
        };
        let openai_url = format!("{}/openai/v1", ctx.gateway_grant.run_base_url);
        let provider_base_url = if ctx.codex_uses_chatgpt_oauth {
            format!(
                "{}/chatgpt/backend-api/codex",
                ctx.gateway_grant.run_base_url
            )
        } else {
            openai_url.clone()
        };

        let mut args = vec![
            String::from("exec"),
            String::from("--json"),
            String::from("-c"),
            format!("openai_base_url=\"{openai_url}\""),
            String::from("-c"),
            format!("model_providers.{provider}.base_url=\"{provider_base_url}\""),
        ];
        if let Some(mcp_url) = &ctx.mcp_endpoint_url {
            args.push(String::from("-c"));
            args.push(format!("mcp_servers.quetzalcoatl.url=\"{mcp_url}\""));
        }
        args.push(String::from(prompt));

        let plan = HarnessLaunchPlan {
            program: ctx.binary_path.clone(),
            args,
            cwd: ctx.workspace_dir.clone(),
            env,
        };
        Self::validate_plan(&plan)?;
        Ok(plan)
    }

    fn execute_turn(&self, ctx: &HarnessLaunchContext, prompt: &str) -> Result<HarnessRunOutcome> {
        let plan = self.build_launch_plan(ctx, prompt)?;
        run_plan_and_collect_events(CodingAgentKind::Codex, &plan, ctx.sandbox_binding.as_ref())
    }
}
