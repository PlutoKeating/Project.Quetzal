#![forbid(unsafe_code)]

//! 面向人的降级说明：把类型化客户端错误翻译成零术语、可操作的提示。
//!
//! 原则：`Companion` 只出现「还没连上 / 请这样做」这类日常语言；原始错误码、
//! `SQLITE_BUSY`、socket 路径等术语只允许出现在 `Inspector` 的审计区。

use quetzalcoatl_client_core::ClientError;

/// 一段给用户看的降级说明（标题 + 一句解释 + 一个动作）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DegradedView {
    /// 面向普通用户的短标题。
    pub title: String,
    /// 零术语的一句话解释。
    pub detail: String,
    /// 明确的下一步动作。
    pub hint: String,
    /// 给开发者/审计者看的技术原因（仅 `Inspector` 展示）。
    pub technical: String,
}

impl DegradedView {
    /// 供 `Inspector` 单行展示的技术摘要。
    #[must_use]
    pub fn technical_line(&self) -> String {
        if self.technical.is_empty() {
            self.detail.clone()
        } else {
            self.technical.clone()
        }
    }
}

/// 把 `quetzalcoatl-client-core` 的类型化错误翻译为面向人的说明。
#[must_use]
pub fn explain_client_error(err: &ClientError) -> DegradedView {
    match err {
        ClientError::DaemonUnavailable { detail } => DegradedView {
            title: String::from("本机的 Quetzalcoatl 助手还没启动"),
            detail: String::from("这个窗口已经准备好了，只是暂时联系不上本机的助手。"),
            hint: String::from(
                "在终端运行 `qz up` 启动本机守护进程（安装器已写好 systemd 用户单元），然后点「重新连接」。",
            ),
            technical: detail.clone(),
        },
        ClientError::InsecureRuntimeFiles { detail } => DegradedView {
            title: String::from("助手的运行凭证权限不安全，已主动拒绝连接"),
            detail: String::from("为了保护你的数据，助手在凭证权限过宽时不会接受任何连接。"),
            hint: String::from("把 ~/.quetzalcoatl/run/daemon.token 的权限改成 0600 后重试。"),
            technical: detail.clone(),
        },
        ClientError::IpcTransport { detail } => DegradedView {
            title: String::from("本机助手暂时没有响应"),
            detail: String::from("助手可能正在重启，稍等一下再试就好。"),
            hint: String::from("点「重新连接」；如果一直这样，请重启 quetzalcoatld。"),
            technical: detail.clone(),
        },
        ClientError::IpcRemote { code, detail } => DegradedView {
            title: String::from("本机助手拒绝了这次请求"),
            detail: String::from("助手没有接受这次操作，你的原有数据没有变化。"),
            hint: String::from("确认操作对象后重试；也可以在「检视」里查看原因。"),
            technical: format!("{code}: {detail}"),
        },
    }
}

/// 离线态的极简构造（无具体错误时使用）。
#[must_use]
pub fn offline_default() -> DegradedView {
    DegradedView {
        title: String::from("本机的 Quetzalcoatl 助手还没启动"),
        detail: String::from("这个窗口已经准备好了，只是暂时联系不上本机的助手。"),
        hint: String::from(
            "在终端运行 `qz up` 启动本机守护进程（安装器已写好 systemd 用户单元），然后点「重新连接」。",
        ),
        technical: String::from("quetzalcoatld 运行时文件缺失"),
    }
}

/// 对话被拒绝时给用户看的「下一步」文案：常见拒绝要说人话，技术细节留在断言区。
#[must_use]
pub fn chat_error_notice(code: &str) -> String {
    match code {
        "MODEL_NOT_CONFIGURED" => String::from(
            "还没有配置模型：在本机登录 Claude Code（claude → /login）或 Codex（codex login），\
             或设置 QUETZALCOATL_UPSTREAM_BEARER_TOKEN 后重启 qz up。",
        ),
        "CREDENTIAL_REJECTED" => String::from(
            "模型凭据被上游拒绝：检查订阅是否过期，或在控制台/环境变量里更新凭据后重试。",
        ),
        "SANDBOX_VIOLATION" => String::from(
            "这次请求被沙箱拒绝：确认 quetzalcoatl-sandbox-exec 仍在安装目录里，然后重试。",
        ),
        _ => String::from("这次没有收到回复，请稍后重试。"),
    }
}

#[cfg(test)]
mod tests {
    use super::chat_error_notice;

    #[test]
    fn model_not_configured_notice_names_the_real_paths() {
        let notice = chat_error_notice("MODEL_NOT_CONFIGURED");
        for expected in [
            "Claude Code",
            "codex login",
            "QUETZALCOATL_UPSTREAM_BEARER_TOKEN",
            "qz up",
        ] {
            assert!(
                notice.contains(expected),
                "缺少可执行指引 {expected}: {notice}"
            );
        }
        assert!(chat_error_notice("PERMISSION_DENIED").contains("请稍后重试"));
    }
}
