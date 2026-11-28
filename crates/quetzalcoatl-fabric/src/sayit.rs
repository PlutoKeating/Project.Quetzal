//! SayIt 对外只读接口 v1 的客户端：按修订号增量取记录、上报游标。
//!
//! 只读；全部接口里唯一的写是上报游标，不写任何内容。

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::endpoint::build_rustls_client_config;

/// 官方 SayIt 的地址。
pub const SAYIT_BASE_URL: &str = "https://sayit.plutokeating.beer";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SayItAccount {
    #[serde(default)]
    pub user_hash: String,
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub head_rev: u64,
}

/// 一条记录（或它的删除标记）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SayItRecord {
    pub id: String,
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub captured_at: Option<String>,
    #[serde(default)]
    pub markdown: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SayItRecordPage {
    #[serde(default)]
    pub records: Vec<SayItRecord>,
    #[serde(default)]
    pub next: u64,
    #[serde(default)]
    pub more: bool,
    #[serde(default)]
    pub head_rev: u64,
}

pub struct SayItClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

fn net(what: &str, e: impl std::fmt::Display) -> QuetzalcoatlError {
    QuetzalcoatlError::StorageError {
        detail: format!("SayIt {what} 失败: {e}"),
    }
}

impl SayItClient {
    pub fn new(base_url: &str, token: &str) -> Result<Self> {
        let tls = build_rustls_client_config(&[])?;
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| net("客户端初始化", e))?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_owned(),
            token: token.trim().to_owned(),
        })
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let resp = self
            .http
            .get(format!("{}{path}", self.base_url))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| net("请求", e))?;
        let status = resp.status();
        let body = resp.bytes().await.map_err(|e| net("读取应答", e))?;
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("SayIt 不认这个令牌（可能已吊销）：在 SayIt 里重新创建一个。"),
            });
        }
        if !status.is_success() {
            return Err(net(
                "请求",
                format!("{status} {}", String::from_utf8_lossy(&body)),
            ));
        }
        serde_json::from_slice(&body).map_err(|e| net("解析应答", e))
    }

    pub async fn me(&self) -> Result<SayItAccount> {
        self.get_json("/v1/me").await
    }

    pub async fn records(&self, after: u64, limit: u32) -> Result<SayItRecordPage> {
        self.get_json(&format!("/v1/records?after={after}&limit={limit}"))
            .await
    }

    /// 已经合并并落盘之后才调用。
    pub async fn put_cursor(&self, consumer_id: &str, rev: u64) -> Result<()> {
        let resp = self
            .http
            .put(format!(
                "{}/v1/consumers/{consumer_id}/cursor",
                self.base_url
            ))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "rev": rev }))
            .send()
            .await
            .map_err(|e| net("上报游标", e))?;
        if !resp.status().is_success() {
            return Err(net("上报游标", resp.status()));
        }
        Ok(())
    }
}
