#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-harness` — 桌面通用双模 Harness 原子宿主。

pub mod discovery;
pub mod drivers;
pub mod gateway;
pub mod mcp_bridge;

pub use discovery::{
    CodingAgentKind, DiscoveredAgent, DiscoveryConfig, DiscoveryReport, RejectedCandidate,
    can_probe_linux_secret_service, discover_coding_agents, matches_agent_version_signature,
};
pub use drivers::{
    EwaveCheckTag, HarnessDriver, HarnessEvent, HarnessLaunchContext, HarnessLaunchPlan,
    HarnessRunOutcome, SandboxLaunchBinding, WorktreeLease, WorktreeManager, acp::AcpJsonRpcDriver,
    claude::ClaudeCodeDriver, codex::CodexDriver, ensure_secure_private_dir,
    opencode::OpenCodeDriver, parse_ewave_check_tag, pi::PiDriver,
};
pub use gateway::{
    ExtractedOAuthCredentials, GatewayConfig, GatewayServerHandle, GatewaySessionConfig,
    GatewaySessionGrant, GatewayUpstreamEndpoints, HttpsUpstreamTransport, LoopbackGateway,
    StrippedOAuthStubBundle, count_anthropic_cache_controls, gemini_cli_env, host_oauth_available,
    prepare_stripped_oauth_stubs,
};
pub use mcp_bridge::{
    McpBridgeSession, McpHttpServerHandle, McpToolDescriptor, serve_mcp_http_loopback,
};

use std::sync::Arc;

use quetzalcoatl_sandbox::UpstreamTransport;
use quetzalcoatl_types::Result;

/// 桌面通用双模 Harness 宿主门面（整合 `<10ms` 嗅探器、回环 LLM 网关与驱动池）。
pub struct HarnessHost {
    discovery_config: DiscoveryConfig,
    gateway: LoopbackGateway,
}

impl HarnessHost {
    #[must_use]
    pub fn new(discovery_config: DiscoveryConfig, gateway: LoopbackGateway) -> Self {
        Self {
            discovery_config,
            gateway,
        }
    }

    pub fn with_default_transport(
        discovery_config: DiscoveryConfig,
        endpoints: GatewayUpstreamEndpoints,
        transport: Arc<dyn UpstreamTransport>,
    ) -> Self {
        let gateway = LoopbackGateway::new(GatewayConfig { endpoints }, transport);
        Self::new(discovery_config, gateway)
    }

    #[must_use]
    pub const fn gateway(&self) -> &LoopbackGateway {
        &self.gateway
    }

    pub fn discover(&self) -> Result<DiscoveryReport> {
        discover_coding_agents(&self.discovery_config)
    }
}
