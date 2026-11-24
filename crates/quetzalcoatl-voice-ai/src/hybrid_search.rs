//! 小规模混合检索：语义嵌入 + 词法（BM25 风格）分数，附嵌入模型版本升级联动。

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};

use quetzalcoatl_types::{QuetzalcoatlError, Result};

/// 嵌入模型版本（模型标识 + 维度），跨版本向量不可比较。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddingVersion {
    pub model_id: String,
    pub dimensions: usize,
    /// 提供该向量的模型包版本（`None` 表示内置/未知）。
    pub pack_version: Option<String>,
}

impl EmbeddingVersion {
    /// 构造版本描述。
    #[must_use]
    pub fn new(model_id: impl Into<String>, dimensions: usize) -> Self {
        Self {
            model_id: model_id.into(),
            dimensions,
            pack_version: None,
        }
    }

    /// 绑定模型包版本（向量身份的一部分）。
    #[must_use]
    pub fn with_pack_version(mut self, pack_version: impl Into<String>) -> Self {
        self.pack_version = Some(pack_version.into());
        self
    }

    /// `(model_id, dim)` 是否与另一版本属于同一向量空间。
    #[must_use]
    pub fn same_vector_space(&self, other: &Self) -> bool {
        self.model_id == other.model_id && self.dimensions == other.dimensions
    }
}

/// 写入向量的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpsertOutcome {
    /// 向量与索引当前模型/包版本一致，语义分数立即生效。
    Fresh,
    /// 向量属于同模型同维度的旧包版本，已接受但入队等待重嵌入。
    QueuedForReembed,
}

/// 把“安装了新嵌入包版本”事件桥接到索引的 sink。
pub trait EmbeddingVersionSink: Send + Sync {
    /// 记录新包版本，并把受影响文档按 ID 升序入队 `reembed()`；
    /// 返回本次入队的文档 ID。实际消费走 [`HybridIndex::drain_reembed_batch`] 的有界批处理。
    fn on_embedding_pack_installed(
        &self,
        model_id: &str,
        pack_version: &str,
        dimensions: Option<usize>,
    ) -> Result<Vec<String>>;
}

/// 线程安全共享索引（供 `quetzalcoatld` 与按需包管理器共享同一 `reembed()` 队列）。
pub struct SharedHybridIndex {
    inner: Arc<Mutex<HybridIndex>>,
}

impl SharedHybridIndex {
    /// 以共享句柄包装索引。
    #[must_use]
    pub fn new(inner: Arc<Mutex<HybridIndex>>) -> Self {
        Self { inner }
    }

    /// 在锁内访问索引（供调用方插入/检索）。
    pub fn with_index<R>(&self, operation: impl FnOnce(&mut HybridIndex) -> R) -> Result<R> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("混合索引锁中毒"),
            })?;
        Ok(operation(&mut guard))
    }
}

impl EmbeddingVersionSink for SharedHybridIndex {
    fn on_embedding_pack_installed(
        &self,
        model_id: &str,
        pack_version: &str,
        dimensions: Option<usize>,
    ) -> Result<Vec<String>> {
        self.with_index(|index| {
            let dimensions = dimensions.unwrap_or(index.embedding_version().dimensions);
            index.set_embedding_version(
                EmbeddingVersion::new(model_id.to_string(), dimensions)
                    .with_pack_version(pack_version.to_string()),
            )
        })
    }
}

#[derive(Clone, Debug)]
struct Document {
    text: String,
    embedding: Vec<f32>,
    version: EmbeddingVersion,
}

/// 单条检索命中。
#[derive(Clone, Debug, PartialEq)]
pub struct HybridHit {
    pub id: String,
    pub score: f32,
    pub semantic_score: f32,
    pub lexical_score: f32,
    /// 该文档的嵌入向量是否仍来自旧模型版本（语义分数已归零）。
    pub stale_embedding: bool,
}

/// 混合索引（单 Agent 内存态，确定性排序）。
pub struct HybridIndex {
    version: EmbeddingVersion,
    documents: BTreeMap<String, Document>,
    stale: BTreeSet<String>,
    reembed_queue: VecDeque<String>,
}

const SEMANTIC_WEIGHT: f32 = 0.65;
const LEXICAL_WEIGHT: f32 = 0.35;

impl HybridIndex {
    /// 以当前嵌入模型版本初始化空索引。
    #[must_use]
    pub fn new(version: EmbeddingVersion) -> Self {
        Self {
            version,
            documents: BTreeMap::new(),
            stale: BTreeSet::new(),
            reembed_queue: VecDeque::new(),
        }
    }

    /// 当前嵌入模型版本。
    #[must_use]
    pub const fn embedding_version(&self) -> &EmbeddingVersion {
        &self.version
    }

    /// 以索引当前模型版本插入或替换文档；维度不符时拒绝。
    pub fn upsert(
        &mut self,
        id: impl Into<String>,
        text: impl Into<String>,
        embedding: Vec<f32>,
    ) -> Result<()> {
        let version = self.version.clone();
        self.upsert_embedded(id, text, embedding, &version)
            .map(|_| ())
    }

    /// 携带向量来源身份插入：
    /// - `(model_id, dim)` 与索引当前模型不同 → `IntegrityViolation`（拒绝跨模型/跨维污染）；
    /// - 同模型同维度但旧包版本 → 接受但入队 `reembed()`（语义分数归零）。
    pub fn upsert_embedded(
        &mut self,
        id: impl Into<String>,
        text: impl Into<String>,
        embedding: Vec<f32>,
        source: &EmbeddingVersion,
    ) -> Result<UpsertOutcome> {
        if !source.same_vector_space(&self.version) {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "嵌入模型身份不符: 索引为 {}/{}，收到 {}/{}",
                    self.version.model_id,
                    self.version.dimensions,
                    source.model_id,
                    source.dimensions
                ),
            });
        }
        if embedding.len() != source.dimensions {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "嵌入维度不符: 期望 {} 实际 {}",
                    source.dimensions,
                    embedding.len()
                ),
            });
        }
        let id = id.into();
        let fresh = source == &self.version;
        self.documents.insert(
            id.clone(),
            Document {
                text: text.into(),
                embedding,
                version: source.clone(),
            },
        );
        if fresh {
            self.stale.remove(&id);
            self.reembed_queue.retain(|queued| queued != &id);
            Ok(UpsertOutcome::Fresh)
        } else {
            self.stale.insert(id.clone());
            if !self.reembed_queue.contains(&id) {
                self.reembed_queue.push_back(id);
            }
            Ok(UpsertOutcome::QueuedForReembed)
        }
    }

    /// 切换嵌入模型版本：返回需要重嵌入的文档 ID（确定性升序）。
    pub fn set_embedding_version(&mut self, version: EmbeddingVersion) -> Vec<String> {
        self.version = version;
        let mut queued = Vec::new();
        self.stale.clear();
        for (id, document) in &self.documents {
            if document.version != self.version {
                self.stale.insert(id.clone());
                queued.push(id.clone());
            }
        }
        self.reembed_queue = queued.iter().cloned().collect();
        queued
    }

    /// 待重嵌入文档数。
    #[must_use]
    pub fn pending_reembed(&self) -> usize {
        self.reembed_queue.len()
    }

    /// 取出至多 `limit` 个待重嵌入 ID（先进先出，确定性）。
    pub fn drain_reembed_batch(&mut self, limit: usize) -> Vec<String> {
        let mut batch = Vec::with_capacity(limit.min(self.reembed_queue.len()));
        while batch.len() < limit {
            match self.reembed_queue.pop_front() {
                Some(id) => batch.push(id),
                None => break,
            }
        }
        batch
    }

    /// 混合检索：语义余弦 + 词法 BM25 风格分数。
    pub fn search(
        &self,
        query_text: &str,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<HybridHit>> {
        if !query_embedding.is_empty() && query_embedding.len() != self.version.dimensions {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "查询嵌入维度不符: 期望 {} 实际 {}",
                    self.version.dimensions,
                    query_embedding.len()
                ),
            });
        }
        let query_terms = tokenize(query_text);
        let document_count = self.documents.len().max(1) as f32;
        let mut document_frequency: BTreeMap<String, usize> = BTreeMap::new();
        for document in self.documents.values() {
            let unique: BTreeSet<String> = tokenize(&document.text).into_iter().collect();
            for term in unique {
                if query_terms.contains(&term) {
                    *document_frequency.entry(term).or_insert(0) += 1;
                }
            }
        }

        let mut hits = Vec::with_capacity(self.documents.len());
        for (id, document) in &self.documents {
            let stale = document.version != self.version;
            let semantic = if stale || query_embedding.len() != document.embedding.len() {
                0.0
            } else {
                cosine_similarity(query_embedding, &document.embedding)
            };
            let lexical = lexical_score(
                &query_terms,
                &document.text,
                &document_frequency,
                document_count,
            );
            let score = SEMANTIC_WEIGHT * semantic + LEXICAL_WEIGHT * lexical;
            hits.push(HybridHit {
                id: id.clone(),
                score,
                semantic_score: semantic,
                lexical_score: lexical,
                stale_embedding: stale,
            });
        }
        hits.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(core::cmp::Ordering::Equal)
                .then_with(|| left.id.cmp(&right.id))
        });
        hits.truncate(limit);
        Ok(hits)
    }
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    let mut dot = 0.0_f32;
    let mut left_norm = 0.0_f32;
    let mut right_norm = 0.0_f32;
    for (a, b) in left.iter().zip(right.iter()) {
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    if left_norm <= f32::EPSILON || right_norm <= f32::EPSILON {
        return 0.0;
    }
    (dot / (left_norm.sqrt() * right_norm.sqrt())).clamp(-1.0, 1.0)
}

fn lexical_score(
    query_terms: &[String],
    text: &str,
    document_frequency: &BTreeMap<String, usize>,
    document_count: f32,
) -> f32 {
    if query_terms.is_empty() {
        return 0.0;
    }
    let tokens = tokenize(text);
    let mut score = 0.0_f32;
    for term in query_terms {
        let frequency = tokens.iter().filter(|token| *token == term).count();
        if frequency == 0 {
            continue;
        }
        let df = document_frequency.get(term.as_str()).copied().unwrap_or(1) as f32;
        let idf = (1.0 + (document_count - df + 0.5) / (df + 0.5)).ln();
        score += idf * frequency as f32 / (frequency as f32 + 1.2);
    }
    score
}

/// 词法切分：ASCII 词小写化；CJK 逐字 + 相邻二元组。
fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut previous_cjk: Option<char> = None;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            word.push(ch.to_ascii_lowercase());
            previous_cjk = None;
            continue;
        }
        if !word.is_empty() {
            tokens.push(std::mem::take(&mut word));
        }
        if is_cjk(ch) {
            tokens.push(ch.to_string());
            if let Some(previous) = previous_cjk {
                tokens.push(format!("{previous}{ch}"));
            }
            previous_cjk = Some(ch);
        } else {
            previous_cjk = None;
        }
    }
    if !word.is_empty() {
        tokens.push(word);
    }
    tokens
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x3040..=0x30ff
    )
}
