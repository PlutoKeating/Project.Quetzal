#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 会话级本地 MCP JSON-RPC 桥接（盲内核能力门禁、`Router` 终端/改文件硬剥夺）。

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use quetzalcoatl_ewave::{ActivateOptions, Conscience, NodeKind, SerpentineGraph, TemporalFilter};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityInvocation, CapabilitySet, EvolvedSkillSpec, GrantContext, GrantEngine,
    PrincipalRole, ScopeChain, compute_workspace_tree_manifest,
};
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpToolDescriptor {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
}

pub struct McpBridgeSession {
    pub principal: PrincipalRole,
    pub run_id: Option<RunId>,
    pub worker_ceiling: CapabilitySet,
    pub scope_chain: ScopeChain,
    pub authored_bindings: BTreeSet<String>,
}

impl McpBridgeSession {
    #[must_use]
    pub fn router_default(authored_bindings: BTreeSet<String>) -> Self {
        Self {
            principal: PrincipalRole::Router,
            run_id: None,
            worker_ceiling: CapabilitySet::All,
            scope_chain: ScopeChain::unrestricted(),
            authored_bindings,
        }
    }

    #[must_use]
    pub fn worker_for_run(run_id: RunId, authored_bindings: BTreeSet<String>) -> Self {
        Self {
            principal: PrincipalRole::Worker,
            run_id: Some(run_id),
            worker_ceiling: CapabilitySet::All,
            scope_chain: ScopeChain::unrestricted(),
            authored_bindings,
        }
    }

    #[must_use]
    pub fn list_tools<S: MaterializedStore>(
        &self,
        kernel: &BlindKernel<S>,
    ) -> Vec<McpToolDescriptor> {
        let run_mode = self
            .run_id
            .and_then(|rid| kernel.runs().get_run(rid))
            .map(|r| r.mode);

        let ctx = GrantContext {
            principal: self.principal,
            run_id: self.run_id,
            run_mode,
            worker_ceiling: self.worker_ceiling.clone(),
            scope_chain: self.scope_chain.clone(),
            authored_bindings: self.authored_bindings.clone(),
            lease_posture: kernel.lease_posture(),
        };

        let effective = GrantEngine::compute_effective_grant(kernel.registry(), &ctx);
        effective
            .into_iter()
            .map(|cap_id| McpToolDescriptor {
                description: describe_tool(&cap_id),
                input_schema: schema_for_tool(&cap_id),
                name: cap_id,
            })
            .collect()
    }

    pub fn handle_jsonrpc<S: MaterializedStore>(
        &self,
        kernel: &mut BlindKernel<S>,
        conscience: &Conscience,
        graph: &SerpentineGraph,
        raw_request: &str,
        now_wall_ms: u64,
    ) -> Result<String> {
        let req_json: serde_json::Value = serde_json::from_str(raw_request).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析 MCP JSON-RPC 请求失败: {e}"),
            }
        })?;

        let id = req_json
            .get("id")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let method = req_json
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");

        let response_val = match method {
            "initialize" => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "quetzalcoatl-mcp-bridge",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }),
            "notifications/initialized" => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {}
            }),
            "tools/list" => {
                let tools = self.list_tools(kernel);
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "tools": tools
                    }
                })
            }
            "tools/call" => {
                let params = req_json
                    .get("params")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let tool_name = params
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let args_json =
                    serde_json::to_string(&arguments).unwrap_or_else(|_| String::from("{}"));

                match kernel.authorize_capability(
                    self.principal,
                    self.run_id,
                    self.worker_ceiling.clone(),
                    self.scope_chain.clone(),
                    self.authored_bindings.clone(),
                    &CapabilityInvocation::new(tool_name, args_json),
                    now_wall_ms,
                ) {
                    Ok(decision) => {
                        match execute_gated_mcp_tool(
                            self,
                            kernel,
                            conscience,
                            graph,
                            tool_name,
                            &arguments,
                            now_wall_ms,
                        ) {
                            Ok(payload) => serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "movement_id": decision.granted.movement_id,
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": payload
                                        }
                                    ]
                                }
                            }),
                            Err(tool_err) => jsonrpc_error(&id, -32004, &tool_err),
                        }
                    }
                    Err(auth_err) => jsonrpc_error(&id, -32003, &auth_err),
                }
            }
            other => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Method not found: {other}")
                }
            }),
        };

        serde_json::to_string(&response_val).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("序列化 MCP JSON-RPC 响应失败: {e}"),
        })
    }
}

fn jsonrpc_error(
    id: &serde_json::Value,
    rpc_code: i32,
    err: &QuetzalcoatlError,
) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": rpc_code,
            "message": err.to_string(),
            "data": {
                "error_code": err.code().as_str()
            }
        }
    })
}

fn execute_gated_mcp_tool<S: MaterializedStore>(
    session: &McpBridgeSession,
    kernel: &mut BlindKernel<S>,
    conscience: &Conscience,
    graph: &SerpentineGraph,
    tool_name: &str,
    arguments: &serde_json::Value,
    now_wall_ms: u64,
) -> Result<String> {
    match tool_name {
        "ewave.recall" => {
            let query = arguments
                .get("query")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let requested_ids: Vec<&str> = arguments
                .get("ids")
                .and_then(serde_json::Value::as_array)
                .map(|arr| arr.iter().filter_map(serde_json::Value::as_str).collect())
                .unwrap_or_default();

            let mut lines = Vec::new();
            for mem in &conscience.memories {
                if mem.invalid_at_ms.is_some() {
                    continue;
                }
                let by_id = requested_ids.contains(&mem.id.as_str());
                let by_q = !query.is_empty()
                    && mem
                        .content
                        .to_ascii_lowercase()
                        .contains(&query.to_ascii_lowercase());
                if by_id || by_q || (query.is_empty() && requested_ids.is_empty()) {
                    lines.push(format!("[memory:{}] {}", mem.id, mem.content));
                }
            }
            if !query.trim().is_empty() && graph.size() > 1 {
                let regions = graph.activate(
                    query,
                    ActivateOptions {
                        k: 3,
                        depth: 1,
                        filter: TemporalFilter::default(),
                    },
                )?;
                for reg in regions {
                    if reg.anchor.kind != NodeKind::Root {
                        lines.push(format!(
                            "[graph:{} score={:.3}] {}",
                            reg.anchor.id,
                            reg.score,
                            reg.anchor.text.as_deref().unwrap_or("")
                        ));
                    }
                }
            }
            Ok(lines.join("\n"))
        }
        "skill.synthesize" => {
            let rid = session
                .run_id
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: String::from("skill.synthesize 必须绑定活跃 Worker RunId"),
                })?;
            let skill_id = arguments
                .get("skill_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("skill.evolved");
            let rel_path = arguments
                .get("relative_script_path")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("skills/evolved.sh");
            let interpreter = arguments
                .get("interpreter")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("/bin/sh");
            let description = arguments
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("sandbox evolved skill");

            if let Some(script_body) = arguments
                .get("script_body")
                .and_then(serde_json::Value::as_str)
                && let Some(ws) = kernel
                    .runs()
                    .get_run(rid)
                    .and_then(|r| r.workspace_dir.clone())
            {
                let full_script_path = ws.join(rel_path);
                if let Some(parent) = full_script_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("创建自演化技能目录失败: {e}"),
                    })?;
                }
                fs::write(&full_script_path, script_body).map_err(|e| {
                    QuetzalcoatlError::StorageError {
                        detail: format!("写入自演化技能脚本失败: {e}"),
                    }
                })?;
            }

            let desc = kernel.synthesize_evolved_skill(
                rid,
                &session.worker_ceiling,
                &session.scope_chain,
                &session.authored_bindings,
                EvolvedSkillSpec {
                    skill_id: String::from(skill_id),
                    interface_id: String::from("sandbox.evolved"),
                    relative_script_path: PathBuf::from(rel_path),
                    interpreter: String::from(interpreter),
                    description: String::from(description),
                },
                now_wall_ms,
            )?;
            Ok(format!(
                "synthesized skill {} (blake3={})",
                desc.skill_id, desc.script_blake3
            ))
        }
        "task.artifact" => {
            if let Some(rid) = session.run_id
                && let Some(ws) = kernel
                    .runs()
                    .get_run(rid)
                    .and_then(|r| r.workspace_dir.as_ref())
            {
                let manifest = compute_workspace_tree_manifest(ws)?;
                return Ok(serde_json::json!({
                    "tree_blake3": manifest.tree_blake3,
                    "entry_count": manifest.entries.len(),
                })
                .to_string());
            }
            Ok(String::from("{\"tree_blake3\":null,\"entry_count\":0}"))
        }
        other => Ok(format!("authorized:{other}")),
    }
}

fn describe_tool(cap_id: &str) -> String {
    match cap_id {
        "ewave.recall" => {
            String::from("Recall bounded eWave memories and serpentine graph regions")
        }
        "skill.synthesize" => String::from("Synthesize an evolved local skill inside CoW sandbox"),
        "task.artifact" => String::from("Inspect content-addressed workspace artifact manifest"),
        other => format!("Blind-kernel gated capability: {other}"),
    }
}

fn schema_for_tool(cap_id: &str) -> serde_json::Value {
    match cap_id {
        "ewave.recall" => serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "ids": { "type": "array", "items": { "type": "string" } }
            }
        }),
        "skill.synthesize" => serde_json::json!({
            "type": "object",
            "properties": {
                "skill_id": { "type": "string" },
                "relative_script_path": { "type": "string" },
                "interpreter": { "type": "string" },
                "description": { "type": "string" },
                "script_body": { "type": "string" }
            },
            "required": ["skill_id", "relative_script_path"]
        }),
        _ => serde_json::json!({ "type": "object" }),
    }
}
