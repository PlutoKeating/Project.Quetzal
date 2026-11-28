//! 召回的词法地板。
//!
//! 在没有语义向量的前提下，让一句自然的提问能按「共同的词」找到往事：
//! 提问与记忆各自切成词（拉丁字母与数字按单词，中日韩文字按相邻两字），取交集并按稀有度加权。
//! 全部是确定性计算，不调用任何模型。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::conscience::Conscience;
use crate::graph::{cmp_f64_desc, cmp_utf16, is_ewave_cjk, normalize_nfkc_lower_trim};

/// 不携带内容的拉丁功能词。
const LATIN_STOP_WORDS: &[&str] = &[
    "about", "agreed", "an", "and", "are", "as", "at", "be", "been", "by", "can", "could", "did",
    "do", "does", "for", "from", "had", "has", "have", "how", "if", "in", "into", "is", "it",
    "its", "me", "my", "no", "of", "on", "or", "our", "please", "should", "so", "than", "that",
    "the", "their", "them", "then", "they", "this", "to", "us", "was", "we", "were", "what",
    "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
];

/// 不携带内容的中文功能双字。它们几乎出现在任何提问里，单独命中不能算相关。
const CJK_STOP_BIGRAMS: &[&str] = &[
    "一下", "一个", "上次", "不是", "为什", "之前", "什么", "他们", "你们", "你的", "可以", "告诉",
    "多久", "多少", "如何", "怎么", "我们", "我的", "时候", "是不", "有没", "来着", "没有", "现在",
    "知道", "记得", "请问", "还是", "这个", "这些", "那个", "那些", "就是", "是否", "哪些", "哪个",
];

/// 把一段文字切成可比较的词：拉丁字母与数字连成的单词（至少两个字符），
/// 以及中日韩文字的相邻双字。功能词被剔除。
#[must_use]
pub fn lexical_terms(text: &str) -> BTreeSet<String> {
    let normalized = normalize_nfkc_lower_trim(text);
    let mut terms = BTreeSet::new();
    let mut word = String::new();
    let mut cjk_run: Vec<char> = Vec::new();

    let flush_word = |word: &mut String, terms: &mut BTreeSet<String>| {
        if word.chars().count() >= 2 && !LATIN_STOP_WORDS.contains(&word.as_str()) {
            terms.insert(std::mem::take(word));
        } else {
            word.clear();
        }
    };
    let flush_cjk = |run: &mut Vec<char>, terms: &mut BTreeSet<String>| {
        for pair in run.windows(2) {
            let bigram: String = pair.iter().collect();
            if !CJK_STOP_BIGRAMS.contains(&bigram.as_str()) {
                terms.insert(bigram);
            }
        }
        run.clear();
    };

    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() {
            flush_cjk(&mut cjk_run, &mut terms);
            word.push(ch);
        } else if is_ewave_cjk(ch) {
            flush_word(&mut word, &mut terms);
            cjk_run.push(ch);
        } else {
            flush_word(&mut word, &mut terms);
            flush_cjk(&mut cjk_run, &mut terms);
        }
    }
    flush_word(&mut word, &mut terms);
    flush_cjk(&mut cjk_run, &mut terms);
    terms
}

/// 不依赖语料统计的相关度判定：提问与这段文字至少有两个共同的词，
/// 并且它们占到提问实词的三分之一以上。用于没有进入词法索引的文字（例如记忆图节点）。
#[must_use]
pub fn shares_enough_terms(query_terms: &BTreeSet<String>, text: &str) -> bool {
    if query_terms.is_empty() {
        return false;
    }
    let matched = query_terms.intersection(&lexical_terms(text)).count();
    matched >= 2 && matched * 3 >= query_terms.len()
}

/// 一批文档的词法索引：记录每个词出现在多少篇文档里，用来衡量稀有度。
#[derive(Debug, Default)]
pub struct LexicalIndex {
    doc_terms: BTreeMap<String, BTreeSet<String>>,
    doc_freq: BTreeMap<String, usize>,
}

impl LexicalIndex {
    /// 登记一篇文档。同一个 `doc_id` 重复登记时以最后一次为准。
    pub fn insert(&mut self, doc_id: &str, text: &str) {
        let terms = lexical_terms(text);
        if let Some(previous) = self.doc_terms.insert(String::from(doc_id), terms.clone()) {
            for term in previous {
                if let Some(count) = self.doc_freq.get_mut(&term) {
                    *count = count.saturating_sub(1);
                }
            }
        }
        for term in terms {
            *self.doc_freq.entry(term).or_insert(0) += 1;
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.doc_terms.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.doc_terms.is_empty()
    }

    /// 提问与某篇文档的相关度；不相关时返回 `None`。
    ///
    /// 相关的条件（二选一）：
    /// - 至少两个共同的词，并且它们占到提问实词的三分之一以上——长文档里偶然撞上两个常见词不算；
    /// - 提问很短（不超过四个实词），并且命中了一个足够稀有的词（出现在不超过十分之一的文档里）。
    ///
    /// 分数是共同词的稀有度之和。
    #[must_use]
    pub fn relevance(&self, query_terms: &BTreeSet<String>, doc_id: &str) -> Option<f64> {
        let doc = self.doc_terms.get(doc_id)?;
        let total = self.doc_terms.len().max(1);
        let rare_ceiling = (total / 10).max(1);
        let mut matched = 0usize;
        let mut has_rare = false;
        let mut score = 0.0f64;
        for term in query_terms.intersection(doc) {
            let freq = self.doc_freq.get(term).copied().unwrap_or(1).max(1);
            matched += 1;
            if freq <= rare_ceiling {
                has_rare = true;
            }
            #[allow(clippy::cast_precision_loss)]
            {
                score += (1.0 + (total as f64) / (freq as f64)).ln();
            }
        }
        let covers_enough = matched >= 2 && matched * 3 >= query_terms.len();
        let short_and_rare = matched >= 1 && has_rare && query_terms.len() <= 4;
        if covers_enough || short_and_rare {
            Some(score)
        } else {
            None
        }
    }
}

/// 一条被找回来的往事。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecalledMemory {
    pub id: String,
    /// 所在的层（`MEMORY`、`USER_PREF` 等）。
    pub layer: String,
    pub content: String,
    /// 这件事从什么时候起成立（毫秒时间戳）。
    pub valid_from_ms: u64,
    /// 来源不可信（工具输出、外部通道）时为真：只能当参考，不能当指令。
    pub untrusted: bool,
    pub score: f64,
}

/// 按一句提问在往事里检索，最相关的排在前面，最多返回 `limit` 条。
///
/// 只看仍然成立的条目；提问里没有任何实词时返回空。全部是确定性计算。
#[must_use]
pub fn search_memories(conscience: &Conscience, query: &str, limit: usize) -> Vec<RecalledMemory> {
    let norm_query = normalize_nfkc_lower_trim(query);
    let query_terms = lexical_terms(&norm_query);
    if norm_query.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut index = LexicalIndex::default();
    for mem in conscience
        .memories
        .iter()
        .filter(|m| m.invalid_at_ms.is_none())
    {
        let mut searchable = mem.content.clone();
        for extra in mem.topic.iter().chain(mem.about.iter()) {
            searchable.push(' ');
            searchable.push_str(extra);
        }
        index.insert(&mem.id, &searchable);
    }
    let mut found: Vec<RecalledMemory> = Vec::new();
    for mem in conscience
        .memories
        .iter()
        .filter(|m| m.invalid_at_ms.is_none())
    {
        let trigger_hit = mem.triggers.iter().any(|t| {
            let nt = normalize_nfkc_lower_trim(t);
            !nt.is_empty() && norm_query.contains(&nt)
        }) || normalize_nfkc_lower_trim(&mem.content).contains(&norm_query);
        let lexical = index.relevance(&query_terms, &mem.id);
        if !trigger_hit && lexical.is_none() {
            continue;
        }
        let score = lexical.unwrap_or(0.0) + if trigger_hit { 2.0 } else { 0.0 } + mem.salience;
        found.push(RecalledMemory {
            id: mem.id.clone(),
            layer: String::from(mem.authority.as_str()),
            content: mem.content.clone(),
            valid_from_ms: mem.valid_from_ms,
            untrusted: mem.untrusted,
            score,
        });
    }
    found.sort_by(|a, b| cmp_f64_desc(a.score, b.score).then_with(|| cmp_utf16(&a.id, &b.id)));
    found.truncate(limit);
    found
}

#[cfg(test)]
mod tests {
    use super::{LexicalIndex, lexical_terms};

    #[test]
    fn terms_split_latin_words_and_cjk_bigrams_and_drop_function_words() {
        let terms = lexical_terms("What was the p99 latency？数据库迁移是什么");
        assert!(terms.contains("p99"));
        assert!(terms.contains("latency"));
        assert!(terms.contains("数据"));
        assert!(terms.contains("迁移"));
        assert!(!terms.contains("what"), "功能词不算词");
        assert!(!terms.contains("什么"), "功能双字不算词");
    }

    #[test]
    fn a_single_common_word_is_not_relevance_but_a_single_rare_word_is() {
        let mut index = LexicalIndex::default();
        for idx in 0..20 {
            index.insert(
                &format!("d{idx}"),
                &format!("周会纪要第 {idx} 期：发布流程照旧"),
            );
        }
        index.insert("cat", "家里的猫叫栗子");
        let common = lexical_terms("发布");
        assert!(
            index.relevance(&common, "d3").is_none(),
            "只共有一个到处都是的词，不算相关"
        );
        let rare = lexical_terms("栗子几岁了");
        assert!(
            index.relevance(&rare, "cat").is_some(),
            "稀有的词单独命中就算相关"
        );
        assert!(index.relevance(&rare, "d3").is_none());
    }

    #[test]
    fn two_stray_common_words_in_a_long_document_are_not_relevance() {
        let mut index = LexicalIndex::default();
        index.insert(
            "long",
            "这是一段很长的工程笔记，里面提到过函数签名的约定，也提到过异步任务的排队方式，\
             还有部署、监控、告警、回滚、值班等等很多别的话题。",
        );
        for idx in 0..12 {
            index.insert(&format!("n{idx}"), &format!("无关条目 {idx}：周末去爬山"));
        }
        let chatter = lexical_terms("帮我把这个函数改成异步的，顺便加上日志和单元测试再提交");
        assert!(
            index.relevance(&chatter, "long").is_none(),
            "一句长提问只撞上长文档里的两个词，不算相关"
        );
    }
}
