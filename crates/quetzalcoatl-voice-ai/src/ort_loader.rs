//! 按需本地模型包（`libonnxruntime` / SenseVoice / Kokoro / 多语种嵌入）：
//! Ed25519 验签 + BLAKE3 完整性 + 原子落盘 + 双轴零遥测。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use quetzalcoatl_types::{QuetzalcoatlError, Result};

/// 关闭 ONNX Runtime POSIX 1DS 遥测的环境变量（Windows ETW 由 API 侧关闭）。
pub const ORT_DISABLE_TELEMETRY: &str = "ORT_DISABLE_TELEMETRY";
/// 动态 `ort` 初始化必须使用的 API 形态（双杀第二轴）。
pub const ORT_TELEMETRY_API_CALL: &str =
    "ort::init_from(model_or_library_path).with_telemetry(false)";

/// 清单 schema 版本。
pub const MANIFEST_SCHEMA: u32 = 1;
/// 清单文件名。
pub const MANIFEST_FILE: &str = "manifest.json";

/// 模型包类别。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiPackKind {
    /// 动态 ONNX Runtime 共享库。
    OnnxRuntime,
    /// SenseVoice 语音识别。
    SpeechRecognition,
    /// Kokoro 语音合成。
    SpeechSynthesis,
    /// 多语种语义嵌入。
    Embedding,
}

impl AiPackKind {
    /// 类别子目录名。
    #[must_use]
    pub const fn directory_name(self) -> &'static str {
        match self {
            Self::OnnxRuntime => "ort-runtime",
            Self::SpeechRecognition => "sensevoice",
            Self::SpeechSynthesis => "kokoro",
            Self::Embedding => "multilingual-embed",
        }
    }
}

/// 清单中的单个文件（下载地址 + 期望 BLAKE3 + 期望大小）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackFileEntry {
    /// 包内相对路径。
    pub path: String,
    /// 下载 URL（由宿主注入的 [`PackSource`] 解析，本 crate 不直接联网）。
    pub url: String,
    /// 期望 BLAKE3 十六进制摘要。
    pub blake3: String,
    /// 期望字节数。
    pub size: u64,
}

/// 签名清单。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackManifest {
    pub schema: u32,
    pub pack: String,
    pub kind: AiPackKind,
    pub version: String,
    pub model_id: String,
    pub files: Vec<PackFileEntry>,
    /// Ed25519 签名（十六进制，覆盖 [`PackManifest::canonical_bytes`]）。
    pub signature: String,
}

#[derive(Serialize)]
struct CanonicalFile<'a> {
    path: &'a str,
    url: &'a str,
    blake3: &'a str,
    size: u64,
}

#[derive(Serialize)]
struct CanonicalManifest<'a> {
    schema: u32,
    pack: &'a str,
    kind: AiPackKind,
    version: &'a str,
    model_id: &'a str,
    files: Vec<CanonicalFile<'a>>,
}

impl PackManifest {
    /// 构造未签名清单。
    #[must_use]
    pub fn new(
        pack: impl Into<String>,
        kind: AiPackKind,
        version: impl Into<String>,
        model_id: impl Into<String>,
        files: Vec<PackFileEntry>,
    ) -> Self {
        Self {
            schema: MANIFEST_SCHEMA,
            pack: pack.into(),
            kind,
            version: version.into(),
            model_id: model_id.into(),
            files,
            signature: String::new(),
        }
    }

    /// 参与签名的确定性规范化字节（文件按路径排序，字段顺序固定）。
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        let mut files: Vec<CanonicalFile<'_>> = self
            .files
            .iter()
            .map(|file| CanonicalFile {
                path: &file.path,
                url: &file.url,
                blake3: &file.blake3,
                size: file.size,
            })
            .collect();
        files.sort_by(|left, right| left.path.cmp(right.path));
        let canonical = CanonicalManifest {
            schema: self.schema,
            pack: &self.pack,
            kind: self.kind,
            version: &self.version,
            model_id: &self.model_id,
            files,
        };
        serde_json::to_vec(&canonical).map_err(|error| QuetzalcoatlError::SerializationError {
            detail: format!("规范化模型清单失败: {error}"),
        })
    }

    /// 使用发布密钥签名。
    pub fn sign_with(&mut self, key: &SigningKey) -> Result<()> {
        let signature = key.sign(&self.canonical_bytes()?);
        self.signature = hex_encode(&signature.to_bytes());
        Ok(())
    }

    /// 严格验签（拒绝非规范签名/低阶公钥）。
    pub fn verify_signature(&self, key: &VerifyingKey) -> Result<()> {
        let signature = hex_decode(&self.signature)?;
        let signature = Signature::from_slice(&signature).map_err(|error| {
            QuetzalcoatlError::IntegrityViolation {
                detail: format!("模型清单签名格式非法: {error}"),
            }
        })?;
        key.verify_strict(&self.canonical_bytes()?, &signature)
            .map_err(|error| QuetzalcoatlError::IntegrityViolation {
                detail: format!("模型清单 Ed25519 验签失败: {error}"),
            })
    }
}

/// 宿主注入的下载源（保持本 crate 零网络依赖，便于密封子进程与离线测试）。
pub trait PackSource: Send + Sync {
    /// 拉取指定 URL 的完整字节。
    fn fetch(&self, url: &str) -> Result<Vec<u8>>;
}

/// 已安装并校验通过的模型包。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledPack {
    pub kind: AiPackKind,
    pub pack: String,
    pub version: String,
    pub model_id: String,
    pub path: PathBuf,
    pub manifest: PackManifest,
    env: BTreeMap<String, String>,
}

impl InstalledPack {
    /// 加载该包时必须注入的进程环境（始终包含 [`ORT_DISABLE_TELEMETRY`]）。
    #[must_use]
    pub const fn env(&self) -> &BTreeMap<String, String> {
        &self.env
    }

    /// 读取单个环境变量。
    #[must_use]
    pub fn env_value(&self, key: &str) -> Option<&str> {
        self.env.get(key).map(String::as_str)
    }

    /// 把加载器环境注入任意子进程（`std::process::Command::envs` 兼容）。
    pub fn apply_env(&self, command: &mut std::process::Command) {
        command.envs(self.env.iter());
    }
}

/// 动态 `ort` 初始化计划：双轴关闭遥测的显式声明。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrtInitPlan {
    /// 环境轴：`ORT_DISABLE_TELEMETRY` 必须为 `"1"`。
    pub disable_telemetry_env: &'static str,
    /// API 轴：必须调用 `with_telemetry(false)`。
    pub api_call: &'static str,
    /// 该调用仅在对应 Cargo feature 开启时启用。
    pub feature_gate: &'static str,
}

impl Default for OrtInitPlan {
    fn default() -> Self {
        Self {
            disable_telemetry_env: "1",
            api_call: ORT_TELEMETRY_API_CALL,
            feature_gate: "dynamic-ort",
        }
    }
}

/// 按需模型包管理器。
pub struct OnDemandAiPackManager {
    root: PathBuf,
    source: Arc<dyn PackSource>,
    verifying_key: VerifyingKey,
}

impl OnDemandAiPackManager {
    /// 在 `$QUETZALCOATL_HOME/models` 下初始化管理器。
    pub fn new(
        home: impl AsRef<Path>,
        source: Arc<dyn PackSource>,
        verifying_key: VerifyingKey,
    ) -> Result<Self> {
        let root = home.as_ref().join("models");
        secure_dir(&root)?;
        Ok(Self {
            root,
            source,
            verifying_key,
        })
    }

    /// 模型根目录。
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 传播给加载器/子进程的遥测关闭环境。
    #[must_use]
    pub fn loader_environment(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert(String::from(ORT_DISABLE_TELEMETRY), String::from("1"));
        env
    }

    /// 动态 `ort` 初始化计划。
    #[must_use]
    pub const fn ort_init_plan(&self) -> OrtInitPlan {
        OrtInitPlan {
            disable_telemetry_env: "1",
            api_call: ORT_TELEMETRY_API_CALL,
            feature_gate: "dynamic-ort",
        }
    }

    /// 验签并原子安装模型包（已安装且校验通过时幂等返回）。
    pub fn install_pack(&self, manifest: &PackManifest) -> Result<InstalledPack> {
        validate_slug(&manifest.pack)?;
        validate_slug(&manifest.version)?;
        if manifest.schema != MANIFEST_SCHEMA {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!("不支持的模型清单 schema: {}", manifest.schema),
            });
        }
        if manifest.files.is_empty() {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("模型清单不得为空"),
            });
        }
        manifest.verify_signature(&self.verifying_key)?;
        let mut seen = BTreeSet::new();
        for file in &manifest.files {
            validate_relative_file_path(&file.path)?;
            if !seen.insert(file.path.as_str()) {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!("模型清单包含重复路径: {}", file.path),
                });
            }
        }

        let pack_root = self.root.join(&manifest.pack);
        let target = pack_root.join(&manifest.version);
        if target.exists() {
            return self.verify_installed(&target);
        }

        let staging = self.root.join(format!(
            ".staging-{}-{}-{}",
            manifest.pack,
            manifest.version,
            std::process::id()
        ));
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(storage_error)?;
        }
        let result = self.stage_pack(manifest, &staging);
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }

        secure_dir(&pack_root)?;
        if let Err(error) = fs::rename(&staging, &target) {
            let _ = fs::remove_dir_all(&staging);
            if target.exists() {
                return self.verify_installed(&target);
            }
            return Err(storage_error(error));
        }
        self.verify_installed(&target)
    }

    fn stage_pack(&self, manifest: &PackManifest, staging: &Path) -> Result<()> {
        secure_dir(staging)?;
        for file in &manifest.files {
            let bytes = self.source.fetch(&file.url)?;
            if bytes.len() as u64 != file.size {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!(
                        "模型文件 {} 大小不符: 期望 {} 实际 {}",
                        file.path,
                        file.size,
                        bytes.len()
                    ),
                });
            }
            let digest = blake3::hash(&bytes).to_hex().to_string();
            if digest != file.blake3 {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!("模型文件 {} BLAKE3 不符", file.path),
                });
            }
            let destination = staging.join(&file.path);
            if let Some(parent) = destination.parent() {
                secure_dir(parent)?;
            }
            let mut handle = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&destination)
                .map_err(storage_error)?;
            handle.write_all(&bytes).map_err(storage_error)?;
            handle.sync_all().map_err(storage_error)?;
            secure_file(&destination)?;
        }
        let manifest_bytes = serde_json::to_vec(manifest).map_err(|error| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化模型清单失败: {error}"),
            }
        })?;
        let manifest_path = staging.join(MANIFEST_FILE);
        let mut handle = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&manifest_path)
            .map_err(storage_error)?;
        handle.write_all(&manifest_bytes).map_err(storage_error)?;
        handle.sync_all().map_err(storage_error)?;
        secure_file(&manifest_path)?;
        Ok(())
    }

    fn verify_installed(&self, target: &Path) -> Result<InstalledPack> {
        let manifest_path = target.join(MANIFEST_FILE);
        let bytes =
            fs::read(&manifest_path).map_err(|error| QuetzalcoatlError::IntegrityViolation {
                detail: format!("模型包缺少清单 {}: {error}", manifest_path.display()),
            })?;
        let manifest: PackManifest = serde_json::from_slice(&bytes).map_err(|error| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析模型清单失败: {error}"),
            }
        })?;
        manifest.verify_signature(&self.verifying_key)?;
        for file in &manifest.files {
            validate_relative_file_path(&file.path)?;
            let path = target.join(&file.path);
            let metadata =
                fs::metadata(&path).map_err(|error| QuetzalcoatlError::IntegrityViolation {
                    detail: format!("模型文件缺失 {}: {error}", path.display()),
                })?;
            if metadata.len() != file.size {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!("模型文件 {} 大小不符", file.path),
                });
            }
            let contents = fs::read(&path).map_err(storage_error)?;
            if blake3::hash(&contents).to_hex().to_string() != file.blake3 {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!("模型文件 {} 已损坏（BLAKE3 不符）", file.path),
                });
            }
        }
        let mut env = self.loader_environment();
        env.insert(
            String::from("QUETZALCOATL_AI_PACK_DIR"),
            target.display().to_string(),
        );
        Ok(InstalledPack {
            kind: manifest.kind,
            pack: manifest.pack.clone(),
            version: manifest.version.clone(),
            model_id: manifest.model_id.clone(),
            path: target.to_path_buf(),
            manifest,
            env,
        })
    }

    /// 枚举全部已安装且校验通过的模型包。
    pub fn installed_packs(&self) -> Result<Vec<InstalledPack>> {
        let mut packs = Vec::new();
        let entries = fs::read_dir(&self.root).map_err(storage_error)?;
        for entry in entries {
            let entry = entry.map_err(storage_error)?;
            let path = entry.path();
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !entry.file_type().map_err(storage_error)?.is_dir() || name.starts_with('.') {
                continue;
            }
            let versions = fs::read_dir(&path).map_err(storage_error)?;
            for version in versions {
                let version = version.map_err(storage_error)?;
                if !version.file_type().map_err(storage_error)?.is_dir() {
                    continue;
                }
                if let Ok(pack) = self.verify_installed(&version.path()) {
                    packs.push(pack);
                }
            }
        }
        packs.sort_by(|left, right| {
            (left.kind, &left.pack, &left.version, &left.path).cmp(&(
                right.kind,
                &right.pack,
                &right.version,
                &right.path,
            ))
        });
        Ok(packs)
    }

    /// 按类别与版本加载（重新验签 + 全量 BLAKE3 校验）。
    pub fn load_pack(&self, kind: AiPackKind, version: &str) -> Result<InstalledPack> {
        validate_slug(version)?;
        let packs = self.installed_packs()?;
        packs
            .into_iter()
            .find(|pack| pack.kind == kind && pack.version == version)
            .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                detail: format!("未找到已验签的模型包 {}/{version}", kind.directory_name()),
            })
    }
}

fn validate_slug(value: &str) -> Result<()> {
    let valid = !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('.')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
    if valid {
        Ok(())
    } else {
        Err(QuetzalcoatlError::PermissionDenied {
            detail: format!("非法模型包标识（疑似路径穿越）: {value}"),
        })
    }
}

fn validate_relative_file_path(path: &str) -> Result<()> {
    let candidate = Path::new(path);
    let valid = !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if valid {
        Ok(())
    } else {
        Err(QuetzalcoatlError::PermissionDenied {
            detail: format!("模型包内文件路径可能逃逸根目录: {path}"),
        })
    }
}

fn secure_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(storage_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(storage_error)?;
    }
    Ok(())
}

fn secure_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(storage_error)?;
    }
    Ok(())
}

fn storage_error(error: std::io::Error) -> QuetzalcoatlError {
    QuetzalcoatlError::StorageError {
        detail: format!("模型包文件操作失败: {error}"),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

fn hex_decode(text: &str) -> Result<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: String::from("十六进制签名长度为奇数"),
        });
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        let high = hex_digit(bytes[index])?;
        let low = hex_digit(bytes[index + 1])?;
        out.push(high << 4 | low);
        index += 2;
    }
    Ok(out)
}

fn hex_digit(byte: u8) -> Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(QuetzalcoatlError::IntegrityViolation {
            detail: String::from("十六进制签名包含非法字符"),
        }),
    }
}

/// 可选动态 `ort` 加载器：宿主实现该 trait 并调用 `ort::init_from(...).with_telemetry(false)`。
///
/// 默认构建不链接 `ort`；`--features dynamic-ort` 仅启用该桥接层，实际 `ort` 依赖由
/// 桌面/移动宿主 surface 显式引入，避免基础构建被 C++ 动态库污染。
pub trait DynamicOrtInitializer {
    /// 使用给定共享库路径初始化 ONNX Runtime，并**在 API 侧同步关闭遥测**。
    fn init_from_with_telemetry_disabled(&self, library: &Path) -> Result<()>;
}

/// 把加载器遥测环境注入子进程。
pub fn apply_loader_env(command: &mut std::process::Command) {
    command.env(ORT_DISABLE_TELEMETRY, "1");
}
