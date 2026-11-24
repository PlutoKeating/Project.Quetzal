#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 混合检索（嵌入 + 词法）与嵌入模型版本升级的确定性 `reembed()` 队列。

use quetzalcoatl_voice_ai::hybrid_search::{EmbeddingVersion, HybridIndex};

fn version(id: &str, dims: usize) -> EmbeddingVersion {
    EmbeddingVersion::new(id, dims)
}

#[test]
fn hybrid_scores_combine_semantic_and_lexical_signals() {
    let mut index = HybridIndex::new(version("multilingual-embed-v1", 4));
    index
        .upsert("a", "声学回声消除与打断检测", vec![1.0, 0.0, 0.0, 0.0])
        .expect("插入 a");
    index
        .upsert("b", "端侧模型按需下载与验签", vec![0.0, 1.0, 0.0, 0.0])
        .expect("插入 b");
    index
        .upsert("c", "群组消息水位线", vec![0.0, 0.0, 1.0, 0.0])
        .expect("插入 c");

    let hits = index
        .search("回声消除", &[0.9, 0.1, 0.0, 0.0], 3)
        .expect("检索");
    assert_eq!(hits.len(), 3);
    assert_eq!(hits[0].id, "a", "语义与词法双重命中应排第一");
    assert!(hits[0].semantic_score > hits[1].semantic_score);
    assert!(hits[0].lexical_score > 0.0);
    assert!(hits[0].score >= hits[1].score && hits[1].score >= hits[2].score);

    let lexical_only = index
        .search("按需下载", &[0.0, 0.0, 0.0, 0.0], 1)
        .expect("检索");
    assert_eq!(lexical_only[0].id, "b", "零查询向量时词法仍须可用");
}

#[test]
fn embedding_version_change_enqueues_deterministic_reembed_queue() {
    let mut index = HybridIndex::new(version("multilingual-embed-v1", 3));
    for (id, text) in [("c", "第三"), ("a", "第一"), ("b", "第二")] {
        index.upsert(id, text, vec![0.1, 0.2, 0.3]).expect("插入");
    }

    let queued = index.set_embedding_version(version("multilingual-embed-v2", 3));
    assert_eq!(queued, vec!["a", "b", "c"], "重嵌入队列必须确定性排序");

    // 版本不匹配期间语义分数归零（词法 + 结构），避免跨维/跨模型污染。
    let stale = index.search("第一", &[0.1, 0.2, 0.3], 3).expect("检索");
    assert!(stale.iter().all(|hit| hit.semantic_score == 0.0));
    assert!(stale.iter().all(|hit| hit.stale_embedding));

    let batch = index.drain_reembed_batch(2);
    assert_eq!(batch, vec!["a", "b"]);
    assert_eq!(index.pending_reembed(), 1);

    index
        .upsert("a", "第一", vec![0.9, 0.1, 0.0])
        .expect("重嵌入 a");
    assert_eq!(index.pending_reembed(), 1);

    let hits = index.search("第一", &[0.9, 0.1, 0.0], 3).expect("检索");
    let a = hits.iter().find(|hit| hit.id == "a").expect("a 命中");
    assert!(a.semantic_score > 0.0, "重嵌入后 a 应恢复语义分数");
    assert!(!a.stale_embedding);
    assert_eq!(index.pending_reembed(), 1, "其余文档仍需重嵌入");
}

#[test]
fn upsert_rejects_dimension_mismatch() {
    let mut index = HybridIndex::new(version("embed", 8));
    let error = index
        .upsert("bad", "维度不符", vec![0.1, 0.2])
        .expect_err("维度不符必须拒绝");
    assert!(matches!(
        error,
        quetzalcoatl_types::QuetzalcoatlError::IntegrityViolation { .. }
    ));
}

/// 异源模型/维度向量必须被拒绝；同模型但旧 pack 版本必须重新入队。
#[test]
fn upsert_rejects_foreign_identity_and_requeues_stale_pack_version() {
    use quetzalcoatl_voice_ai::hybrid_search::UpsertOutcome;

    let mut index = HybridIndex::new(version("embed-a", 4).with_pack_version("1.0.0"));
    let fresh = index
        .upsert_embedded(
            "doc",
            "声学回声消除",
            vec![1.0, 0.0, 0.0, 0.0],
            &version("embed-a", 4).with_pack_version("1.0.0"),
        )
        .expect("同源向量");
    assert_eq!(fresh, UpsertOutcome::Fresh);

    for foreign in [version("embed-b", 4), version("embed-a", 8)] {
        let error = index
            .upsert_embedded("doc", "异源", vec![0.1; foreign.dimensions], &foreign)
            .expect_err("异源模型/维度必须拒绝");
        assert!(matches!(
            error,
            quetzalcoatl_types::QuetzalcoatlError::IntegrityViolation { .. }
        ));
    }

    let outcome = index
        .upsert_embedded(
            "doc",
            "声学回声消除",
            vec![0.9, 0.1, 0.0, 0.0],
            &version("embed-a", 4).with_pack_version("2.0.0"),
        )
        .expect("同模型旧包版本可接收但需重嵌入");
    assert_eq!(outcome, UpsertOutcome::QueuedForReembed);
    assert_eq!(index.pending_reembed(), 1);
    assert_eq!(index.drain_reembed_batch(1), vec!["doc"]);
}

/// 安装新的 Embedding 包版本必须经 sink 把受影响的文档批量入队。
#[test]
fn installing_new_embedding_pack_enqueues_documents_via_sink() {
    use std::sync::{Arc, Mutex};

    use quetzalcoatl_voice_ai::hybrid_search::SharedHybridIndex;

    let index = Arc::new(Mutex::new(HybridIndex::new(
        version("embed-a", 4).with_pack_version("1.0.0"),
    )));
    index
        .lock()
        .expect("索引锁")
        .upsert("a", "声学回声消除", vec![1.0, 0.0, 0.0, 0.0])
        .expect("插入 a");
    index
        .lock()
        .expect("索引锁")
        .upsert("b", "端侧模型验签", vec![0.0, 1.0, 0.0, 0.0])
        .expect("插入 b");

    let sink = SharedHybridIndex::new(Arc::clone(&index));
    let queued =
        quetzalcoatl_voice_ai::hybrid_search::EmbeddingVersionSink::on_embedding_pack_installed(
            &sink,
            "embed-a",
            "2.0.0",
            Some(4),
        )
        .expect("sink 通知");
    assert_eq!(queued, vec!["a", "b"]);
    assert_eq!(index.lock().expect("索引锁").pending_reembed(), 2);
    // 有界批处理 API：一次只消费 1 个。
    assert_eq!(
        index.lock().expect("索引锁").drain_reembed_batch(1).len(),
        1
    );
    assert_eq!(index.lock().expect("索引锁").pending_reembed(), 1);
}
