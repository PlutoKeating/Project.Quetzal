#![deny(unsafe_code)]

//! 纯 WSS 中继端点校验（防坑规范 #17）。
//!
//! 浏览器端禁止任何明文回退：只接受 `wss://`，显式拒绝 `ws://`、`http://`、`https://`
//! （`https://` 会被降级混用，必须显式写成 `wss://`）。真正的 WSS 会话循环由 Web 端
//! （Task 4.2）驱动；本模块只负责不可绕过的端点门禁，可在原生单测中直接验证。

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransportError {
    #[error("只允许 wss:// 中继端点，拒绝 `{url}`")]
    NotWss { url: String },

    #[error("WSS 端点缺少主机名: `{url}`")]
    MissingHost { url: String },

    #[error("WSS 端点包含非法字符（空白/控制符/用户信息）: `{url}`")]
    Malformed { url: String },
}

/// 已通过 `wss://` 门禁校验的中继端点。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WssEndpoint {
    url: String,
    host: String,
}

impl WssEndpoint {
    pub fn parse(url: &str) -> Result<Self, TransportError> {
        let trimmed = url.trim();
        if trimmed.is_empty()
            || trimmed
                .bytes()
                .any(|b| b <= 0x20 || b == 0x7f || b == b'@' || b == b'\\')
        {
            return Err(TransportError::Malformed {
                url: url.to_owned(),
            });
        }
        let Some((scheme, rest)) = trimmed.split_once("://") else {
            return Err(TransportError::NotWss {
                url: url.to_owned(),
            });
        };
        if !scheme.eq_ignore_ascii_case("wss") {
            return Err(TransportError::NotWss {
                url: url.to_owned(),
            });
        }

        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let host = match authority.rsplit_once(':') {
            Some((host, port)) => {
                let bracketed = host.starts_with('[') && host.ends_with(']');
                if bracketed || port.parse::<u16>().is_ok_and(|port| port > 0) {
                    host
                } else {
                    return Err(TransportError::Malformed {
                        url: url.to_owned(),
                    });
                }
            }
            None => authority,
        };
        if host.is_empty() {
            return Err(TransportError::MissingHost {
                url: url.to_owned(),
            });
        }

        Ok(Self {
            url: format!("wss://{rest}"),
            host: host.to_owned(),
        })
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.url
    }

    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }
}
