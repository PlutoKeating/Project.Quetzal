#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 会话级本地 MCP JSON-RPC 桥接（盲内核能力门禁、`Router` 终端/改文件硬剥夺与写入前防穿越校验）。

use std::collections::BTreeSet;
use std::fs;
use std::hint::black_box;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_ewave::{ActivateOptions, Conscience, NodeKind, SerpentineGraph, TemporalFilter};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityInvocation, CapabilitySet, EvolvedSkillSpec, GrantContext, GrantEngine,
    PrincipalRole, ScopeChain, compute_workspace_tree_manifest,
};
use quetzalcoatl_sandbox::PROTECTED_WORKSPACE_SUBPATHS;
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{QuetzalcoatlError, Result, RunId};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

const MAX_MCP_HTTP_HEADER_BYTES: usize = 32 * 1024;
const MAX_MCP_HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;

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
    ) -> Result<Option<String>> {
        let req_json: serde_json::Value = serde_json::from_str(raw_request).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析 MCP JSON-RPC 请求失败: {e}"),
            }
        })?;

        // JSON-RPC 2.0 §4.1：缺少 "id" 成员的消息属于 Notification（如 notifications/initialized），严禁回包！
        let Some(id) = req_json.get("id").cloned() else {
            return Ok(None);
        };
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

        serde_json::to_string(&response_val).map(Some).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化 MCP JSON-RPC 响应失败: {e}"),
            }
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

/// 在任何宿主文件系统创建目录或写入脚本前，严格校验相对路径不越界、不含符号链接且不触碰受保护子路径。
fn validate_and_write_safe_skill_script(
    workspace_dir: &Path,
    raw_rel_path: &str,
    script_body: Option<&str>,
) -> Result<PathBuf> {
    if raw_rel_path.is_empty()
        || raw_rel_path.starts_with('/')
        || raw_rel_path.contains('\\')
        || raw_rel_path.contains('\0')
    {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("自演化技能路径必须为干净的相对路径: `{raw_rel_path}`"),
        });
    }

    let rel = Path::new(raw_rel_path);
    if rel.is_absolute() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("拒绝绝对路径自演化技能脚本: `{raw_rel_path}`"),
        });
    }

    let mut normal_segments = Vec::<String>::new();
    for comp in rel.components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg
                    .to_str()
                    .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                        detail: String::from("自演化技能路径包含非 UTF-8 组件"),
                    })?;
                if s.is_empty() || s.contains('\0') {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: String::from("自演化技能路径包含空组件或 NUL 字节"),
                    });
                }
                normal_segments.push(String::from(s));
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!("拒绝包含目录穿越的自演化技能路径: `{raw_rel_path}`"),
                });
            }
        }
    }

    if normal_segments.is_empty() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: String::from("自演化技能路径不能为空"),
        });
    }

    let normalized_rel = normal_segments.join("/");
    if normalized_rel == ".git" || normalized_rel.starts_with(".git/") {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("禁止向 .git 目录写入自演化技能脚本: `{normalized_rel}`"),
        });
    }
    for protected in PROTECTED_WORKSPACE_SUBPATHS {
        if normalized_rel == *protected || normalized_rel.starts_with(&format!("{protected}/")) {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("禁止向受保护配置/钩子路径写入自演化技能脚本: `{normalized_rel}`"),
            });
        }
    }

    let ws_meta =
        fs::symlink_metadata(workspace_dir).map_err(|e| QuetzalcoatlError::SandboxViolation {
            detail: format!("工作区根目录不可访问 ({}): {e}", workspace_dir.display()),
        })?;
    if ws_meta.file_type().is_symlink() || !ws_meta.is_dir() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!(
                "工作区根目录必须为真实目录且非符号链接: {}",
                workspace_dir.display()
            ),
        });
    }

    // 预检所有已存在的路径组件（若任何组件是符号链接或类型不符，在落盘前立即阻断！）
    let mut probe = workspace_dir.to_path_buf();
    for (idx, seg) in normal_segments.iter().enumerate() {
        probe.push(seg);
        let is_last = idx + 1 == normal_segments.len();
        if let Ok(meta) = fs::symlink_metadata(&probe) {
            if meta.file_type().is_symlink() {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!("拒绝穿越工作区内符号链接组件写入脚本: {}", probe.display()),
                });
            }
            if is_last && !meta.is_file() {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!("目标技能脚本已存在但不是普通文件: {}", probe.display()),
                });
            }
            if !is_last && !meta.is_dir() {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!("中间路径已存在但不是普通目录: {}", probe.display()),
                });
            }
        }
    }

    if let Some(body) = script_body {
        let mut cursor = workspace_dir.to_path_buf();
        for (idx, seg) in normal_segments.iter().enumerate() {
            cursor.push(seg);
            let is_last = idx + 1 == normal_segments.len();
            if !is_last {
                match fs::symlink_metadata(&cursor) {
                    Ok(meta) => {
                        if meta.file_type().is_symlink() || !meta.is_dir() {
                            return Err(QuetzalcoatlError::SandboxViolation {
                                detail: format!("检测到并发符号链接替换: {}", cursor.display()),
                            });
                        }
                    }
                    Err(_) => {
                        fs::create_dir(&cursor).map_err(|e| QuetzalcoatlError::StorageError {
                            detail: format!("创建自演化技能子目录失败 ({}): {e}", cursor.display()),
                        })?;
                    }
                }
            } else {
                if let Ok(meta) = fs::symlink_metadata(&cursor)
                    && (meta.file_type().is_symlink() || !meta.is_file())
                {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: format!("拒绝覆盖符号链接目标: {}", cursor.display()),
                    });
                }
                fs::write(&cursor, body).map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("写入自演化技能脚本失败 ({}): {e}", cursor.display()),
                })?;
            }
        }
    }

    Ok(PathBuf::from(normalized_rel))
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
            let rel_path_raw = arguments
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
            let script_body_opt = arguments
                .get("script_body")
                .and_then(serde_json::Value::as_str);

            let ws = kernel
                .runs()
                .get_run(rid)
                .and_then(|r| r.workspace_dir.clone())
                .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                    detail: format!("Run `{rid}` 未绑定沙箱工作区目录"),
                })?;

            // 先执行严格防穿越、防受保护子路径、防符号链接校验，通过后才允许在沙箱工作区内写入普通文件！
            let clean_rel_path =
                validate_and_write_safe_skill_script(&ws, rel_path_raw, script_body_opt)?;

            let desc = kernel.synthesize_evolved_skill(
                rid,
                &session.worker_ceiling,
                &session.scope_chain,
                &session.authored_bindings,
                EvolvedSkillSpec {
                    skill_id: String::from(skill_id),
                    interface_id: String::from("sandbox.evolved"),
                    relative_script_path: clean_rel_path,
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

#[must_use]
fn ct_eq_32(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut acc = 0u8;
    for i in 0..32 {
        acc |= black_box(a[i]) ^ black_box(b[i]);
    }
    black_box(acc) == 0
}

const fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn decode_cap_32(s: &str) -> ([u8; 32], bool) {
    let raw = s.trim().as_bytes();
    if raw.len() != 64 {
        return ([0u8; 32], false);
    }
    let mut out = [0u8; 32];
    let mut ok = true;
    for (i, slot) in out.iter_mut().enumerate() {
        match (hex_nibble(raw[i * 2]), hex_nibble(raw[i * 2 + 1])) {
            (Some(h), Some(l)) => *slot = (h << 4) | l,
            _ => {
                *slot = 0;
                ok = false;
            }
        }
    }
    (out, ok)
}

/// 会话级本地 HTTP MCP JSON-RPC 服务句柄（供单个 `Worker Run` 挂载并在结束时销毁）。
pub struct McpHttpServerHandle {
    endpoint_url: String,
    bound_addr: SocketAddr,
    stop: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl McpHttpServerHandle {
    #[must_use]
    pub fn endpoint_url(&self) -> &str {
        &self.endpoint_url
    }

    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect_timeout(&self.bound_addr, Duration::from_millis(20));
        if let Some(h) = self.join_handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for McpHttpServerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 启动绑定 256-bit 路径能力密钥（`http://127.0.0.1:<port>/mcp/<cap_token>`）的会话级回环 MCP HTTP 桥接器。
pub fn serve_mcp_http_loopback<F>(dispatch_fn: F) -> Result<McpHttpServerHandle>
where
    F: Fn(&str) -> Result<Option<String>> + Send + Sync + 'static,
{
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).map_err(|e| {
        QuetzalcoatlError::StorageError {
            detail: format!("绑定会话级 MCP 回环监听失败: {e}"),
        }
    })?;
    let bound_addr = listener
        .local_addr()
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("获取 MCP 回环监听地址失败: {e}"),
        })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("设置 MCP TcpListener 非阻塞失败: {e}"),
        })?;

    let mut cap_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut cap_bytes);
    let cap_hex = hex_encode(&cap_bytes);
    let endpoint_url = format!("http://{bound_addr}/mcp/{cap_hex}");

    let stop = Arc::new(AtomicBool::new(false));
    let stop_bg = Arc::clone(&stop);
    let dispatch = Arc::new(dispatch_fn);

    let join_handle = thread::spawn(move || {
        while !stop_bg.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                    let d = Arc::clone(&dispatch);
                    thread::spawn(move || {
                        handle_single_mcp_http_conn(&mut stream, &cap_bytes, d.as_ref());
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(4));
                }
                Err(_) => break,
            }
        }
    });

    Ok(McpHttpServerHandle {
        endpoint_url,
        bound_addr,
        stop,
        join_handle: Some(join_handle),
    })
}

fn handle_single_mcp_http_conn<F>(stream: &mut TcpStream, expected_cap: &[u8; 32], dispatch: &F)
where
    F: Fn(&str) -> Result<Option<String>> + ?Sized,
{
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_MCP_HTTP_HEADER_BYTES {
            write_mcp_http_reply(stream, 400, br#"{"error":"header too large"}"#);
            return;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };

    let Ok(head_str) = std::str::from_utf8(&buf[..header_end]) else {
        write_mcp_http_reply(stream, 400, br#"{"error":"invalid utf8"}"#);
        return;
    };
    let mut lines = head_str.split("\r\n");
    let target = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    let path_only = target.split_once('?').map_or(target, |(p, _)| p);
    let Some(cap_part) = path_only.strip_prefix("/mcp/") else {
        write_mcp_http_reply(stream, 401, br#"{"error":"unauthorized"}"#);
        return;
    };
    let clean_cap = cap_part.trim_end_matches('/');
    let (cand_cap, ok) = decode_cap_32(clean_cap);
    if !ok || !ct_eq_32(&cand_cap, expected_cap) {
        write_mcp_http_reply(stream, 401, br#"{"error":"unauthorized"}"#);
        return;
    }

    let mut content_len = 0usize;
    for line in lines {
        if let Some((k, v)) = line.split_once(':')
            && k.trim().eq_ignore_ascii_case("content-length")
            && let Ok(cl) = v.trim().parse::<usize>()
        {
            if cl > MAX_MCP_HTTP_BODY_BYTES {
                write_mcp_http_reply(stream, 400, br#"{"error":"body too large"}"#);
                return;
            }
            content_len = cl;
        }
    }

    let body_start = header_end + 4;
    let mut body = Vec::with_capacity(content_len);
    if buf.len() > body_start {
        let take = (buf.len() - body_start).min(content_len);
        body.extend_from_slice(&buf[body_start..body_start + take]);
    }
    while body.len() < content_len {
        let want = (content_len - body.len()).min(chunk.len());
        match stream.read(&mut chunk[..want]) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }

    let Ok(body_utf8) = std::str::from_utf8(&body) else {
        write_mcp_http_reply(stream, 400, br#"{"error":"invalid body utf8"}"#);
        return;
    };
    match dispatch(body_utf8) {
        Ok(Some(resp_json)) => write_mcp_http_reply(stream, 200, resp_json.as_bytes()),
        Ok(None) => write_mcp_http_accepted_empty(stream),
        Err(err) => {
            let payload = serde_json::json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32000, "message": err.to_string() }
            })
            .to_string();
            write_mcp_http_reply(stream, 200, payload.as_bytes());
        }
    }
}

fn write_mcp_http_accepted_empty(stream: &mut TcpStream) {
    let head = b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let _ = stream.write_all(head);
    let _ = stream.flush();
}

fn write_mcp_http_reply(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let reason = if status == 200 {
        "OK"
    } else if status == 401 {
        "Unauthorized"
    } else {
        "Bad Request"
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}
