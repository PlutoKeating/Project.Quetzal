#![forbid(unsafe_code)]

//! 守护进程联系不上时的话：零术语、可操作。
//!
//! 整页保留上一次的内容；导航上方一行琥珀色状态词与下一步（在终端运行 `qz up`）；写动作不可用。
//! 原始错误、socket 路径等术语只进 stderr 日志，不进界面。

use crate::api::ApiError;

/// 导航上方那一行的琥珀状态词。
pub const STATUS_WORD: &str = "联系不上";

/// 导航上方那一行的说明（后面接着命令 `qz up`）。
pub const STATUS_TEXT: &str =
    "本机的守护进程没有响应。页面保留着上一次读到的内容，写动作暂时不可用。在终端运行";

/// 下一步要运行的命令。
pub const NEXT_STEP_COMMAND: &str = "qz up";

/// 整页读不出来时的标题。
pub const UNREACHABLE_TITLE: &str = "联系不上本机的守护进程";

/// 整页读不出来时的说明。
pub const UNREACHABLE_BODY: &str =
    "治理面的每一页都从它读取。它没有在运行，或者刚刚被重启。启动之后这一页会自己读出来。";

/// 一段给人看的降级说明。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Degraded {
    pub word: &'static str,
    pub title: String,
    pub body: String,
    pub next_step: Option<&'static str>,
}

/// 把一次失败翻译成给人看的说明。
#[must_use]
pub fn explain(error: &ApiError) -> Degraded {
    match error {
        ApiError::Unreachable(_) => Degraded {
            word: STATUS_WORD,
            title: UNREACHABLE_TITLE.to_owned(),
            body: UNREACHABLE_BODY.to_owned(),
            next_step: Some(NEXT_STEP_COMMAND),
        },
        other => Degraded {
            word: "读取失败",
            title: String::from("这一页没有读出来"),
            body: other.describe(),
            next_step: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreachable_points_at_qz_up_and_hides_technical_detail() {
        let explained = explain(&ApiError::Unreachable(String::from(
            "socket /run/x refused",
        )));
        assert_eq!(explained.next_step, Some("qz up"));
        assert!(!explained.body.contains("socket"));
    }

    #[test]
    fn remote_errors_show_the_daemons_own_sentence() {
        let explained = explain(&ApiError::Remote {
            code: String::from("X"),
            detail: String::from("口令不对。"),
        });
        assert_eq!(explained.body, "口令不对。");
        assert_eq!(explained.next_step, None);
    }
}
