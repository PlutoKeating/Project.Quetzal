#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! OpenCode V2 驱动（`OPENCODE_CONFIG_PROJECT_DISABLE=1`、禁 `--service`、屏蔽 `/api/pty*` 与目录级插件挂载）。

use quetzalcoatl_types::{QuetzalcoatlError, Result};

use crate::discovery::CodingAgentKind;
use crate::drivers::acp::run_plan_and_collect_events;
use crate::drivers::{
    HarnessDriver, HarnessLaunchContext, HarnessLaunchPlan, HarnessRunOutcome,
    build_common_sandbox_env,
};

#[derive(Clone, Debug, Default)]
pub struct OpenCodeDriver;

impl OpenCodeDriver {
    /// 防坑规范 #4：屏蔽裸 `/api/pty*` 端点以防绕过无容器沙箱垫片。
    #[must_use]
    pub fn is_blocked_http_path(path: &str) -> bool {
        let clean = path
            .split_once('?')
            .map_or(path, |(p, _)| p)
            .trim()
            .to_ascii_lowercase();
        let norm = clean.replace("%2f", "/");
        norm == "/api/pty" || norm.starts_with("/api/pty/") || norm.contains("/api/pty")
    }

    pub fn validate_plan(plan: &HarnessLaunchPlan) -> Result<()> {
        if plan
            .env
            .get("OPENCODE_CONFIG_PROJECT_DISABLE")
            .map(String::as_str)
            != Some("1")
        {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from(
                    "OpenCode V2 启动环境必须强制开启 OPENCODE_CONFIG_PROJECT_DISABLE=1",
                ),
            });
        }
        if plan
            .args
            .iter()
            .any(|a| a == "--service" || a.starts_with("--service="))
        {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("OpenCode V2 受管实例严禁传入 --service 单例参数"),
            });
        }
        if plan.env.get("SHELL").is_none_or(|s| s.trim().is_empty()) {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("OpenCode V2 启动环境必须绑定 SHELL 沙箱包装器"),
            });
        }
        Ok(())
    }
}

impl HarnessDriver for OpenCodeDriver {
    fn kind(&self) -> CodingAgentKind {
        CodingAgentKind::OpenCode
    }

    fn build_launch_plan(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessLaunchPlan> {
        let mut env = build_common_sandbox_env(ctx);
        env.insert(
            String::from("OPENCODE_CONFIG_PROJECT_DISABLE"),
            String::from("1"),
        );
        env.insert(
            String::from("ANTHROPIC_BASE_URL"),
            ctx.gateway_grant.run_base_url.clone(),
        );
        env.insert(
            String::from("OPENAI_BASE_URL"),
            format!("{}/openai/v1", ctx.gateway_grant.run_base_url),
        );
        env.insert(
            String::from("ANTHROPIC_API_KEY"),
            ctx.gateway_grant.ephemeral_stub_token.clone(),
        );
        env.insert(
            String::from("OPENAI_API_KEY"),
            ctx.gateway_grant.ephemeral_stub_token.clone(),
        );
        if let Some(enh_root) = &ctx.enhancers_root_dir {
            let plugin_dir = enh_root.join("opencode-v2-plugin/.opencode");
            env.insert(
                String::from("OPENCODE_CONFIG_DIR"),
                plugin_dir.to_string_lossy().into_owned(),
            );
            env.insert(
                String::from("QUETZALCOATL_OPENCODE_PLUGIN_DIR"),
                plugin_dir
                    .join("plugins/quetzalcoatl")
                    .to_string_lossy()
                    .into_owned(),
            );
        }

        let plan = HarnessLaunchPlan {
            program: ctx.binary_path.clone(),
            args: vec![
                String::from("run"),
                String::from("--format"),
                String::from("json"),
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
        run_plan_and_collect_events(
            CodingAgentKind::OpenCode,
            &plan,
            ctx.sandbox_binding.as_ref(),
        )
    }
}
