#![deny(unsafe_code)]

//! 可注入的单写者存储租约契约 + 原生临时目录实现。
//!
//! 契约（浏览器 OPFS 后端必须遵守同一语义）：
//!
//! * [`SingleWriterStorage::try_acquire_writer`] **必须立即返回**：已被其他写者持有时
//!   返回 [`StorageError::WriterBusy`]，绝不阻塞、绝不无锁降级写入。
//! * 任何 `write`/`remove` 都必须携带有效 [`WriterLease`]；租约失效即
//!   [`StorageError::LeaseRevoked`]。
//! * 租约 `Drop` 时立即释放（进程内登记 + 文件锁标记双重释放）。
//!
//! 原生实现 [`TempDirStorage`] 用 `create_new` 独占标记文件同时覆盖进程内与跨进程语义；
//! 浏览器 `opfs` 模块用 `navigator.locks` 的独占锁 + `ifAvailable: true` 实现同一契约。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("已有写者持有租约 scope={scope}")]
    WriterBusy { scope: String },

    #[error("写租约已失效 scope={scope}")]
    LeaseRevoked { scope: String },

    #[error("存储键非法: {detail}")]
    InvalidKey { detail: String },

    #[error("存储 I/O 失败: {detail}")]
    Io { detail: String },
}

/// 写租约：持有期间独占该 scope 的写入权。
pub struct WriterLease {
    scope: String,
    token: u64,
    release: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl std::fmt::Debug for WriterLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriterLease")
            .field("scope", &self.scope)
            .field("token", &self.token)
            .finish_non_exhaustive()
    }
}

impl WriterLease {
    #[must_use]
    pub fn scope(&self) -> &str {
        &self.scope
    }

    #[must_use]
    pub const fn token(&self) -> u64 {
        self.token
    }
}

impl Drop for WriterLease {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release();
        }
    }
}

/// 可注入的单写者存储后端。
pub trait SingleWriterStorage {
    /// 尝试取写租约：busy 时立即失败（绝不阻塞）。
    fn try_acquire_writer(&self, scope: &str) -> Result<WriterLease, StorageError>;

    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError>;

    fn write(&self, lease: &WriterLease, key: &str, bytes: &[u8]) -> Result<(), StorageError>;

    fn remove(&self, lease: &WriterLease, key: &str) -> Result<(), StorageError>;

    fn list(&self, prefix: &str) -> Result<Vec<String>, StorageError>;
}

fn validate_key(key: &str) -> Result<(), StorageError> {
    if key.is_empty() || key.len() > 200 {
        return Err(StorageError::InvalidKey {
            detail: String::from("key 长度必须在 1..=200"),
        });
    }
    if key.contains('/') || key.contains('\\') || key == "." || key == ".." || key.contains("..") {
        return Err(StorageError::InvalidKey {
            detail: format!("key 含路径分隔或上跳语义: {key}"),
        });
    }
    if !key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(StorageError::InvalidKey {
            detail: format!("key 含非白名单字符: {key}"),
        });
    }
    Ok(())
}

struct ActiveWriter {
    scope: String,
    token: u64,
}

/// 原生临时目录单写者存储（测试与桌面离线回放用）。
pub struct TempDirStorage {
    root: PathBuf,
    active: Arc<Mutex<Option<ActiveWriter>>>,
    next_token: Arc<Mutex<u64>>,
}

impl TempDirStorage {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|e| StorageError::Io {
            detail: format!("创建存储根目录失败 ({}): {e}", root.display()),
        })?;
        Ok(Self {
            root,
            active: Arc::new(Mutex::new(None)),
            next_token: Arc::new(Mutex::new(1)),
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn lock_active(&self) -> Result<MutexGuard<'_, Option<ActiveWriter>>, StorageError> {
        self.active.lock().map_err(|_| StorageError::Io {
            detail: String::from("存储租约锁中毒"),
        })
    }

    fn allocate_token(&self) -> Result<u64, StorageError> {
        let mut guard = self.next_token.lock().map_err(|_| StorageError::Io {
            detail: String::from("存储令牌计数器锁中毒"),
        })?;
        let token = *guard;
        *guard = guard.saturating_add(1);
        Ok(token)
    }

    fn path_for(&self, key: &str) -> Result<PathBuf, StorageError> {
        validate_key(key)?;
        Ok(self.root.join(key))
    }

    fn assert_lease(&self, lease: &WriterLease) -> Result<(), StorageError> {
        let guard = self.lock_active()?;
        match guard.as_ref() {
            Some(active) if active.token == lease.token && active.scope == lease.scope => Ok(()),
            _ => Err(StorageError::LeaseRevoked {
                scope: lease.scope.clone(),
            }),
        }
    }
}

impl SingleWriterStorage for TempDirStorage {
    fn try_acquire_writer(&self, scope: &str) -> Result<WriterLease, StorageError> {
        if scope.trim().is_empty() {
            return Err(StorageError::InvalidKey {
                detail: String::from("scope 不能为空"),
            });
        }
        let mut guard = self.lock_active()?;
        if let Some(active) = guard.as_ref() {
            return Err(StorageError::WriterBusy {
                scope: active.scope.clone(),
            });
        }

        // 跨进程独占标记：`create_new` 原子失败即代表其他进程在写。
        let marker = self.root.join(format!(".writer-{scope}.lock"));
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&marker)
        {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(StorageError::WriterBusy {
                    scope: scope.to_owned(),
                });
            }
            Err(e) => {
                return Err(StorageError::Io {
                    detail: format!("创建写者标记失败 ({}): {e}", marker.display()),
                });
            }
        }

        let token = self.allocate_token()?;
        *guard = Some(ActiveWriter {
            scope: scope.to_owned(),
            token,
        });

        let active = Arc::clone(&self.active);
        let marker_for_release = marker.clone();
        Ok(WriterLease {
            scope: scope.to_owned(),
            token,
            release: Some(Box::new(move || {
                let _ = fs::remove_file(&marker_for_release);
                if let Ok(mut guard) = active.lock()
                    && guard.as_ref().is_some_and(|writer| writer.token == token)
                {
                    *guard = None;
                }
            })),
        })
    }

    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let path = self.path_for(key)?;
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(StorageError::Io {
                detail: format!("读取 {} 失败: {e}", path.display()),
            }),
        }
    }

    fn write(&self, lease: &WriterLease, key: &str, bytes: &[u8]) -> Result<(), StorageError> {
        self.assert_lease(lease)?;
        let path = self.path_for(key)?;
        let tmp = self.root.join(format!(".{key}.tmp-{}", lease.token));
        fs::write(&tmp, bytes).map_err(|e| StorageError::Io {
            detail: format!("写入临时文件 {} 失败: {e}", tmp.display()),
        })?;
        fs::rename(&tmp, &path).map_err(|e| StorageError::Io {
            detail: format!("原子替换 {} 失败: {e}", path.display()),
        })
    }

    fn remove(&self, lease: &WriterLease, key: &str) -> Result<(), StorageError> {
        self.assert_lease(lease)?;
        let path = self.path_for(key)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StorageError::Io {
                detail: format!("删除 {} 失败: {e}", path.display()),
            }),
        }
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, StorageError> {
        let mut keys = Vec::new();
        let entries = fs::read_dir(&self.root).map_err(|e| StorageError::Io {
            detail: format!("列出 {} 失败: {e}", self.root.display()),
        })?;
        for entry in entries {
            let entry = entry.map_err(|e| StorageError::Io {
                detail: format!("遍历存储目录失败: {e}"),
            })?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !name.starts_with(prefix) {
                continue;
            }
            keys.push(name);
        }
        keys.sort_unstable();
        Ok(keys)
    }
}
