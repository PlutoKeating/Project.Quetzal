use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::error::Error;

use quetzalcoatl_ewave::{
    ActivateOptions, AlignOptions, AttachOptions, BranchOptions, CollapseTimeOptions,
    DEFAULT_EMB_DIM, EdgeKind, EwaveSnapshot, GraphOptions, LinkOptions, LockActor, LockMode,
    LogicPolarity, MergeOptions, NodeKind, ObserveAction, ObserveOptions, SayItIngestContext,
    SayItIngestStatus, SerpentineGraph, SplitOptions, TemporalFilter, TemporalInput, TemporalMode,
    cmp_utf16, fnv1a_utf16, hash_embed_64,
};

type TestResult = Result<(), Box<dyn Error>>;

/// 由 `@plutokeating/ewave@0.2.0` 构造的黄金 JSON-v2 快照：
/// 包含多父归属（`n_spine` 主干 `b_work` + 次级父 `b_philo` 权重 0.75）、
/// 跨 `α_t` 切片（`2026-W47` 与 `2026-W48`）、`+1`（`supports`）与 `-1`（`contradicts`）有向逻辑边、
/// 64 维 UTF-16 FNV-1a 词法哈希向量以及 `structure_frozen` 机械锁。
const GOLDEN_EWAVE_V2_SNAPSHOT_JSON: &str = r#"{
  "format": "ewave",
  "version": 2,
  "name": "golden-v2-compat",
  "createdAt": 1795400000100,
  "updatedAt": 1795400005500,
  "nodes": [
    {
      "id": "b_philo",
      "kind": "branch",
      "data": null,
      "text": "两段式权威与 Buber 关系边界",
      "label": "哲学与良知边界",
      "embedding": [
        0, 0, 0.18668141738611654, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, -0.09334070869305829, 0, 0.18668141738611654, 0.18668141738611654, -0.18668141738611654, 0, 0,
        0, 0, -0.2800221260791748, 0, 0.18668141738611654, 0, -0.2800221260791748, 0,
        0, 0.4667035434652914, 0, 0, 0, -0.2800221260791748, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0.2800221260791748, 0, 0, -0.2800221260791748, 0, 0, 0.15556784782176378, 0.18668141738611654,
        0, 0.18668141738611654, 0, -0.18668141738611654, 0, 0, 0, -0.2800221260791748
      ],
      "parents": ["root"],
      "primaryParent": "root",
      "children": ["n_spine", "n_conscience"],
      "links": [],
      "outLinks": [],
      "inLinks": [],
      "time": {
        "at": 1795400002000,
        "endAt": null,
        "sliceId": "2026-W47",
        "validFrom": 1795400002000,
        "invalidAt": null
      },
      "createdAt": 1795400001200,
      "updatedAt": 1795400004000,
      "meta": {}
    },
    {
      "id": "b_work",
      "kind": "branch",
      "data": null,
      "text": "Quetzalcoatl V2 与 eWave 蛇形四维空间设计",
      "label": "工作与系统架构",
      "embedding": [
        0, 0, 0.034627168053222177, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0.3116445124789997, 0.3116445124789997, 0.3116445124789997, 0, 0, 0,
        0, 0.20776300831933311, 0, -0.20776300831933311, 0, 0, 0, 0.3116445124789997,
        0, 0, 0.3116445124789997, 0, 0, 0, 0.20776300831933311, 0,
        0, 0, 0, 0, -0.17313584026611092, -0.20776300831933311, -0.20776300831933311, 0,
        0, 0, -0.20776300831933311, 0.3116445124789997, 0, 0, 0, -0.17313584026611092,
        0.3116445124789997, 0, 0, 0, 0, 0, 0, 0
      ],
      "parents": ["root"],
      "primaryParent": "root",
      "children": ["n_spine"],
      "links": [],
      "outLinks": [],
      "inLinks": [],
      "time": {
        "at": 1795400001000,
        "endAt": null,
        "sliceId": "2026-W47",
        "validFrom": 1795400001000,
        "invalidAt": null
      },
      "createdAt": 1795400000500,
      "updatedAt": 1795400002900,
      "meta": {}
    },
    {
      "id": "b_work_w48",
      "kind": "branch",
      "data": null,
      "text": "跨时间切片压缩验证",
      "label": "工作与系统架构",
      "embedding": [
        0, -0.31980107453341566, 0, 0.21320071635561041, 0, 0, 0, 0,
        0, 0.21320071635561041, -0.21320071635561041, 0, 0, 0, 0, 0.31980107453341566,
        0, 0, 0, 0, 0, 0, -0.31980107453341566, 0,
        0, 0, 0, 0, -0.21320071635561041, 0, 0, 0,
        -0.31980107453341566, 0, 0, 0, 0.21320071635561041, 0, 0, 0,
        0, 0, 0, -0.31980107453341566, 0, 0, 0, 0.31980107453341566,
        0.21320071635561041, 0, 0, 0, 0.31980107453341566, 0, 0, 0,
        0, 0, 0, 0.10660035817780524, 0, 0, 0, 0
      ],
      "parents": ["root"],
      "primaryParent": "root",
      "children": ["n_conflict"],
      "links": [],
      "outLinks": [],
      "inLinks": [],
      "time": {
        "at": 1796000001000,
        "endAt": null,
        "sliceId": "2026-W48",
        "validFrom": 1796000001000,
        "invalidAt": null
      },
      "createdAt": 1795400001900,
      "updatedAt": 1795400004700,
      "meta": {}
    },
    {
      "id": "n_conflict",
      "kind": "leaf",
      "data": { "role": "dilemma" },
      "text": "扁平上下文压缩会导致治理衰减 Governance Decay",
      "label": "压缩洗白风险",
      "embedding": [
        -0.20109535297593834, -0.20109535297593834, -0.20109535297593834, 0.13406356865062558, 0, 0, -0.13406356865062558, 0,
        0, 0.26812713730125115, -0.20109535297593834, 0, -0.06703178432531279, 0, 0, 0,
        0, 0.13406356865062558, 0, 0, 0, 0.13406356865062558, 0, 0,
        0.3351589216265639, 0, 0.13406356865062558, 0, 0, 0, 0, 0,
        0, 0, -0.11171964054218796, 0, -0.13406356865062558, 0, 0, 0,
        0, 0, 0, 0.20109535297593834, 0, -0.13406356865062558, 0, 0.40219070595187667,
        -0.20109535297593834, 0, 0, -0.20109535297593834, 0, 0.40219070595187667, 0.13406356865062558, 0,
        0.11171964054218796, -0.13406356865062558, 0, -0.13406356865062558, 0, 0, 0, 0
      ],
      "parents": ["b_work_w48"],
      "primaryParent": "b_work_w48",
      "children": [],
      "links": ["n_conscience"],
      "outLinks": ["n_conscience"],
      "inLinks": [],
      "time": {
        "at": 1796000002000,
        "endAt": null,
        "sliceId": "2026-W48",
        "validFrom": 1796000002000,
        "invalidAt": null
      },
      "createdAt": 1795400004400,
      "updatedAt": 1795400005200,
      "meta": {}
    },
    {
      "id": "n_conscience",
      "kind": "leaf",
      "data": { "role": "thought" },
      "text": "绝对段 ROOT=100 与 SELF_CORE=70 拒绝单轮施压篡改",
      "label": "良知稳态",
      "embedding": [
        0, 0.2677338527889283, 0.17848923519261886, 0, 0, 0, 0, -0.2677338527889283,
        0, 0.17848923519261886, 0, 0.2677338527889283, 0, 0, 0, 0,
        0, 0, 0.2677338527889283, 0, 0, 0, 0, 0.17848923519261886,
        0, 0, 0, -0.32723026451980125, 0, 0, -0.17848923519261886, 0.17848923519261886,
        0, 0, -0.17848923519261886, 0, 0, 0, 0, 0.1487410293271824,
        0, -0.2677338527889283, 0, 0.2677338527889283, 0.2677338527889283, 0, 0, 0,
        -0.2677338527889283, 0, 0, 0.1487410293271824, 0.1487410293271824, 0, 0.1487410293271824, 0.17848923519261886,
        0, 0, 0, 0, 0, 0, 0, -0.0892446175963094
      ],
      "parents": ["b_philo"],
      "primaryParent": "b_philo",
      "children": [],
      "links": ["n_spine", "n_conflict"],
      "outLinks": [],
      "inLinks": ["n_spine", "n_conflict"],
      "time": {
        "at": 1795400004000,
        "endAt": null,
        "sliceId": "2026-W47",
        "validFrom": 1795400004000,
        "invalidAt": null
      },
      "createdAt": 1795400003700,
      "updatedAt": 1795400005200,
      "meta": {}
    },
    {
      "id": "n_spine",
      "kind": "leaf",
      "data": { "role": "fact" },
      "text": "Primary spine preserves leaf count conservation while CF aggregates multi-parent weights",
      "label": "主干守恒定律",
      "embedding": [
        0, 0, 0, 0, 0.30151134457776363, -0.30151134457776363, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, -0.6030226891555273, 0, 0, 0, -0.30151134457776363, 0, 0,
        0, 0, 0.30151134457776363, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, -0.30151134457776363, 0, 0, 0, 0,
        0, -0.30151134457776363, 0, 0.30151134457776363, 0, 0, 0, 0
      ],
      "parents": ["b_work", "b_philo"],
      "primaryParent": "b_work",
      "children": [],
      "links": ["n_conscience"],
      "outLinks": ["n_conscience"],
      "inLinks": [],
      "time": {
        "at": 1795400003000,
        "endAt": null,
        "sliceId": "2026-W47",
        "validFrom": 1795400003000,
        "invalidAt": null
      },
      "createdAt": 1795400002600,
      "updatedAt": 1795400005000,
      "meta": {}
    },
    {
      "id": "root",
      "kind": "root",
      "data": null,
      "text": null,
      "label": null,
      "embedding": null,
      "parents": [],
      "primaryParent": null,
      "children": ["b_work", "b_philo", "b_work_w48"],
      "links": [],
      "outLinks": [],
      "inLinks": [],
      "time": {
        "at": 1795400000200,
        "endAt": null,
        "sliceId": "default",
        "validFrom": 1795400000200,
        "invalidAt": null
      },
      "createdAt": 1795400000200,
      "updatedAt": 1795400002200,
      "meta": {}
    }
  ],
  "edges": [
    {
      "from": "b_philo",
      "to": "n_conscience",
      "kind": "hierarchy",
      "weight": 1,
      "polarity": 1,
      "relation": null,
      "createdAt": 1795400003900
    },
    {
      "from": "b_philo",
      "to": "n_spine",
      "kind": "hierarchy",
      "weight": 0.75,
      "polarity": 1,
      "relation": "grounds",
      "createdAt": 1795400003200
    },
    {
      "from": "b_work_w48",
      "to": "n_conflict",
      "kind": "hierarchy",
      "weight": 1,
      "polarity": 1,
      "relation": null,
      "createdAt": 1795400004600
    },
    {
      "from": "b_work",
      "to": "n_spine",
      "kind": "hierarchy",
      "weight": 1,
      "polarity": 1,
      "relation": null,
      "createdAt": 1795400002800
    },
    {
      "from": "root",
      "to": "b_philo",
      "kind": "hierarchy",
      "weight": 1,
      "polarity": 1,
      "relation": null,
      "createdAt": 1795400001400
    },
    {
      "from": "root",
      "to": "b_work",
      "kind": "hierarchy",
      "weight": 1,
      "polarity": 1,
      "relation": null,
      "createdAt": 1795400000700
    },
    {
      "from": "root",
      "to": "b_work_w48",
      "kind": "hierarchy",
      "weight": 1,
      "polarity": 1,
      "relation": null,
      "createdAt": 1795400002100
    },
    {
      "from": "n_conflict",
      "to": "n_conscience",
      "kind": "link",
      "weight": 0.65,
      "polarity": -1,
      "relation": "contradicts",
      "createdAt": 1795400005200
    },
    {
      "from": "n_spine",
      "to": "n_conscience",
      "kind": "link",
      "weight": 0.9,
      "polarity": 1,
      "relation": "supports",
      "createdAt": 1795400005000
    }
  ],
  "locks": [
    {
      "scopeRoot": "b_philo",
      "mode": "structure_frozen",
      "setBy": "owner",
      "reason": "pin philosophy",
      "createdAt": 1795400005400
    }
  ]
}"#;

#[test]
fn golden_v2_snapshot_roundtrips_and_matches_ts_ewave_aggregates() -> TestResult {
    let graph = SerpentineGraph::from_json_v2(GOLDEN_EWAVE_V2_SNAPSHOT_JSON)?;
    assert_eq!(graph.verify(), Vec::<String>::new());
    graph.verify_strict()?;
    assert_eq!(graph.size(), 7);
    assert_eq!(graph.dimension(), Some(DEFAULT_EMB_DIM));

    // 主干叶计数守恒 vs 多父 memberCount 精确分离（对照 @plutokeating/ewave@0.2.0 实测值）
    let root = graph.root()?;
    assert_eq!(root.count, 3, "全局主干叶计数必须严格等于有效叶节点总数 3");

    let b_philo = graph.get("b_philo").ok_or("缺少 b_philo")?;
    assert_eq!(
        b_philo.count, 1,
        "b_philo 仅含 1 个 primary 叶 n_conscience"
    );
    assert!(
        (b_philo.member_count - 1.75).abs() < 1e-12,
        "b_philo.member_count 应为 1.0 + 0.75 = 1.75，实际 {}",
        b_philo.member_count
    );
    let centroid = b_philo.centroid.as_ref().ok_or("b_philo 缺少 centroid")?;
    assert!((centroid[1] - 0.225_113_279_108_085_57).abs() < 1e-12);
    assert!((centroid[2] - 0.150_075_519_405_390_38).abs() < 1e-12);
    assert!((b_philo.radius - 0.800_478_819_851_880_4).abs() < 1e-12);

    // 校验有向逻辑边极性 +1 / -1 与机械锁
    let pos_edge = graph
        .edge("n_spine", "n_conscience", EdgeKind::Link)
        .ok_or("缺少正向逻辑边")?;
    assert_eq!(pos_edge.polarity, LogicPolarity::Positive);
    assert!((pos_edge.signed_weight() - 0.9).abs() < 1e-12);

    let neg_edge = graph
        .edge("n_conflict", "n_conscience", EdgeKind::Link)
        .ok_or("缺少负向逻辑边")?;
    assert_eq!(neg_edge.polarity, LogicPolarity::Negative);
    assert!((neg_edge.signed_weight() - (-0.65)).abs() < 1e-12);

    assert_eq!(graph.lock_mode("b_philo"), Some(LockMode::StructureFrozen));
    assert_eq!(
        graph.lock_mode("n_conscience"),
        Some(LockMode::StructureFrozen)
    );

    // 防坑规范 #11 ④：确定性 UTF-16 码元排序（'>' = 0x3e < '_' = 0x5f，不受宿主 locale 影响）
    assert_eq!(
        cmp_utf16(
            "hierarchy:b_work>n_spine",
            "hierarchy:b_work_w48>n_conflict"
        ),
        Ordering::Less
    );
    let exported_json = graph.to_json_v2()?;
    let reloaded = SerpentineGraph::from_json_v2(&exported_json)?;
    assert_eq!(reloaded.verify(), Vec::<String>::new());
    let reexported_json = reloaded.to_json_v2()?;
    assert_eq!(
        exported_json, reexported_json,
        "JSON-v2 导出再导入必须逐字节恒等"
    );

    let snap = reloaded.to_snapshot();
    let idx_work = snap
        .edges
        .iter()
        .position(|e| e.from == "b_work" && e.to == "n_spine")
        .ok_or("缺少 b_work->n_spine")?;
    let idx_w48 = snap
        .edges
        .iter()
        .position(|e| e.from == "b_work_w48" && e.to == "n_conflict")
        .ok_or("缺少 b_work_w48->n_conflict")?;
    assert!(
        idx_work < idx_w48,
        "确定性 UTF-16 排序下 hierarchy:b_work>n_spine 必须排在 hierarchy:b_work_w48>n_conflict 之前"
    );

    Ok(())
}

#[test]
fn hash_embedder_utf16_fnv1a_matches_typescript_reference() -> TestResult {
    assert_eq!(fnv1a_utf16("w:ewave"), 0x8f48_c142_u32);
    let vec = hash_embed_64("ＥＷＡＶＥ 结构记忆 core's v2-test")?;
    assert_eq!(vec.len(), 64);

    let norm: f64 = vec.iter().map(|v| v * v).sum::<f64>().sqrt();
    assert!((norm - 1.0).abs() < 1e-12);

    // 对照 V8 @plutokeating/ewave@0.2.0 hashEmbedder() 精确前 8 维输出
    let expected_prefix = [
        0.0,
        -0.478_344_603_107_460_5,
        -0.265_747_001_726_366_95,
        0.0,
        0.0,
        0.0,
        0.0,
        0.265_747_001_726_366_95,
    ];
    for (idx, exp) in expected_prefix.iter().enumerate() {
        assert!(
            (vec[idx] - exp).abs() < 1e-12,
            "维度 {idx} 与 TypeScript hashEmbedder 不一致: got={}, expected={exp}",
            vec[idx]
        );
    }
    Ok(())
}

#[test]
fn observe_promote_split_collapse_time_and_activate_polarity_separation() -> TestResult {
    // 1. 从黄金快照验证 activate 正反逻辑边分离与跨 α_t 切片压缩至 α_T
    let golden = SerpentineGraph::from_json_v2(GOLDEN_EWAVE_V2_SNAPSHOT_JSON)?;
    let regions = golden.activate(
        "绝对段 ROOT=100 与 SELF_CORE=70 拒绝单轮施压篡改",
        ActivateOptions {
            k: 1,
            depth: 1,
            filter: TemporalFilter::default(),
        },
    )?;
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].anchor.id, "n_conscience");
    assert_eq!(regions[0].supporting.len(), 1);
    assert_eq!(regions[0].supporting[0].node.id, "n_spine");
    assert_eq!(regions[0].supporting[0].polarity, LogicPolarity::Positive);
    assert_eq!(regions[0].conflicting.len(), 1);
    assert_eq!(regions[0].conflicting[0].node.id, "n_conflict");
    assert_eq!(regions[0].conflicting[0].polarity, LogicPolarity::Negative);
    assert_eq!(
        regions[0].slices,
        vec![String::from("2026-W47"), String::from("2026-W48")]
    );

    // 压缩时间维 α_t -> α_T：跨切片同名分支 "工作与系统架构" 归并，多父归属与 +1/-1 边完整保留
    let collapsed = golden.collapse_time(CollapseTimeOptions::default())?;
    assert_eq!(collapsed.verify(), Vec::<String>::new());
    let slices = collapsed.slices();
    assert_eq!(slices.len(), 1);
    assert_eq!(slices[0].slice_id, "alpha_T");
    assert_eq!(collapsed.project_roots(None).len(), 2);
    assert_eq!(collapsed.leaves(None).len(), 3);
    assert!(
        collapsed
            .edge("n_conflict", "n_conscience", EdgeKind::Link)
            .is_some()
    );

    // 2. 验证 observe、Page-Hinkley cusum 漂移、最远点对确定性分裂与 promote
    let mut dynamic = SerpentineGraph::new(GraphOptions {
        emb_dim: 3,
        threshold: 0.3,
        auto_split: false,
        adaptive_threshold: true,
        grow_branch_on_far: true,
        min_children: 4,
        ..GraphOptions::default()
    })?;

    let o1 = dynamic.observe(
        serde_json::json!("alpha"),
        ObserveOptions {
            text: Some(String::from("alpha")),
            embedding: Some(vec![1.0, 0.0, 0.0]),
            ..ObserveOptions::default()
        },
    )?;
    assert_eq!(o1.action, ObserveAction::Attached);

    let o2 = dynamic.observe(
        serde_json::json!("far_topic"),
        ObserveOptions {
            text: Some(String::from("far_topic")),
            label: Some(String::from("远端新簇")),
            embedding: Some(vec![0.0, 1.0, 0.0]),
            ..ObserveOptions::default()
        },
    )?;
    assert_eq!(o2.action, ObserveAction::Branched);
    assert_eq!(o2.parent.kind, NodeKind::Branch);

    // 将叶节点 promote 为分支并在其下挂载 4 个分属两极的子叶以验证最远点对确定性 split
    let promoted = dynamic.promote(&o1.node.id)?;
    assert_eq!(promoted.kind, NodeKind::Branch);
    for (idx, emb) in [
        vec![1.0, 0.0, 0.0],
        vec![0.98, 0.1, 0.0],
        vec![0.0, 0.0, 1.0],
        vec![0.1, 0.0, 0.98],
    ]
    .into_iter()
    .enumerate()
    {
        dynamic.add(
            serde_json::json!(format!("item_{idx}")),
            ObserveOptions {
                text: Some(format!("item_{idx}")),
                parent: Some(promoted.id.clone()),
                embedding: Some(emb),
                ..ObserveOptions::default()
            },
        )?;
    }

    let split_res = dynamic
        .split(&promoted.id, SplitOptions::default())?
        .ok_or("4 个两极子节点必须触发确定性最远点对二分分裂")?;
    assert_eq!(split_res.branches.len(), 2);
    assert_eq!(split_res.moved.len(), 4);
    dynamic.link(
        &split_res.branches[0].id,
        &split_res.branches[1].id,
        LinkOptions {
            weight: 0.5,
            polarity: LogicPolarity::Negative,
            relation: Some(String::from("excludes")),
            meta: BTreeMap::new(),
        },
    )?;
    dynamic.lock(
        &split_res.branches[0].id,
        LockMode::ReadOnly,
        LockActor::Owner,
        "freeze left split",
    )?;
    assert_eq!(dynamic.verify(), Vec::<String>::new());

    Ok(())
}

#[test]
fn sayit_pitfall_11_foreign_emb_reembed_offline_fallback_role_granularity_and_refile_invalidation()
-> TestResult {
    let mut spine_graph = SerpentineGraph::new(GraphOptions {
        name: Some(String::from("gleanit-main")),
        auto_split: false,
        ..GraphOptions::default()
    })?;

    // 主图中预置一个 role="project" 的项目分支 "架构演进"
    let proj_arch = spine_graph.add_branch(BranchOptions {
        id: Some(String::from("proj_arch")),
        label: Some(String::from("架构演进")),
        text: Some(String::from("Quetzalcoatl 系统架构演进项目")),
        data: Some(serde_json::json!({ "role": "project" })),
        ..BranchOptions::default()
    })?;

    // 构造一棵异源 8 维嵌入模型（foreign-8d）的 SayIt 子树：
    // 含一个同名但粒度为 role="section" 的分支（防坑 #11 ② 必须拒绝与 role="project" 错位合并），
    // 以及一个同粒度 role="project" 的分支 "架构演进"。
    let mut foreign_sub = SerpentineGraph::new(GraphOptions {
        name: Some(String::from("sayit-session-1")),
        emb_model_id: String::from("sayit-foreign-8d-v1"),
        emb_dim: 8,
        auto_split: false,
        ..GraphOptions::default()
    })?;
    let f_proj = foreign_sub.add_branch(BranchOptions {
        id: Some(String::from("s_proj")),
        label: Some(String::from("架构演进")),
        text: Some(String::from("Quetzalcoatl 系统架构演进项目")),
        data: Some(serde_json::json!({ "role": "project", "sessionId": "ses_01" })),
        embedding: Some(vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ..BranchOptions::default()
    })?;
    let f_sec_same_name = foreign_sub.add_branch(BranchOptions {
        id: Some(String::from("s_sec")),
        label: Some(String::from("架构演进")),
        text: Some(String::from("第一节：架构演进细节")),
        parent: Some(f_proj.id.clone()),
        data: Some(serde_json::json!({ "role": "section", "sessionId": "ses_01" })),
        embedding: Some(vec![0.9, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ..BranchOptions::default()
    })?;
    foreign_sub.add(
        serde_json::json!({ "role": "fact", "sessionId": "ses_01" }),
        ObserveOptions {
            id: Some(String::from("s_leaf_1")),
            text: Some(String::from("SayIt 异源嵌入子树自动重算 64 维向量")),
            parent: Some(f_sec_same_name.id.clone()),
            embedding: Some(vec![0.8, 0.4, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
            ..ObserveOptions::default()
        },
    )?;

    let mut foreign_snap: EwaveSnapshot = foreign_sub.to_snapshot();
    let mut snap_meta = BTreeMap::new();
    snap_meta.insert(
        String::from("emb_model_id"),
        serde_json::json!("sayit-foreign-8d-v1"),
    );
    snap_meta.insert(String::from("emb_dim"), serde_json::json!(8));
    foreign_snap.meta = Some(snap_meta.clone());

    // 防坑 #11 ① 在线模式：异源 8 维快照合入 64 维主图时不报 EWAVE_DIMENSION，自动用主图 64 维嵌入器重算
    // 防坑 #11 ②：role="project" 合并至 proj_arch，而同名但 role="section" 的分支保持独立子分支不与 project 混同！
    // 防坑 #11 ③：记录 (sayit_user_hash, slice_id, session_id, snapshot_sha256)
    let ingest_v1 = spine_graph.ingest_sayit_subtree(
        foreign_snap.clone(),
        SayItIngestContext {
            sayit_user_hash: String::from("u_alice_hash"),
            slice_id: String::from("2026-W47"),
            session_id: String::from("ses_01"),
            snapshot_sha256: String::from("sha256_v1_initial"),
            now_ms: 1_795_500_000_000,
            merge_options: MergeOptions::default(),
        },
    )?;
    assert_eq!(ingest_v1.status, SayItIngestStatus::IngestedNew);
    let merge_v1 = ingest_v1.merge_result.ok_or("首次导入应返回 MergeResult")?;
    assert!(merge_v1.alignment.reembedded_foreign_vectors);
    assert_eq!(
        merge_v1.node_map.get("s_proj"),
        Some(&proj_arch.id),
        "同粒度 role=project 必须对齐合并到既有 proj_arch"
    );
    let mapped_sec_id = merge_v1
        .node_map
        .get("s_sec")
        .ok_or("s_sec 必须映射为独立子分支")?
        .clone();
    assert_ne!(
        mapped_sec_id, proj_arch.id,
        "role=section 严禁错位合并进同名 role=project 分支"
    );
    let mapped_leaf_v1_id = merge_v1
        .node_map
        .get("s_leaf_1")
        .ok_or("缺少 s_leaf_1 映射")?
        .clone();
    assert_eq!(
        spine_graph
            .get(&mapped_leaf_v1_id)
            .and_then(|n| n.embedding.as_ref())
            .map(Vec::len),
        Some(64),
        "异源 8 维叶节点必须已重算为主图规范 64 维向量"
    );

    // 重复提交完全相同的 (user_hash, slice_id, session_id, snapshot_sha256) 必须幂等无操作
    let dup_ingest = spine_graph.ingest_sayit_subtree(
        foreign_snap,
        SayItIngestContext {
            sayit_user_hash: String::from("u_alice_hash"),
            slice_id: String::from("2026-W47"),
            session_id: String::from("ses_01"),
            snapshot_sha256: String::from("sha256_v1_initial"),
            now_ms: 1_795_500_001_000,
            merge_options: MergeOptions::default(),
        },
    )?;
    assert_eq!(dup_ingest.status, SayItIngestStatus::DuplicateNoOp);

    // 防坑 #11 ③ + ①（离线模式）：用户在 SayIt 将同 sessionId="ses_01" 改归属至新项目 "生活健康" 重编译（sha256_v2），
    // 且此时主图处于离线状态（embedder_online = false）：
    // 1) 先双时态 invalidate() 旧版 ses_01 独占节点（mapped_leaf_v1_id 与 mapped_sec_id），保留 proj_arch 有效；
    // 2) 走 semanticWeight=0 词法+结构对齐安全合并异源维度快照，入队后台 reembed()；
    // 3) 恢复在线后调用 reembed_pending() 补齐 64 维向量并重算 CF。
    spine_graph.set_embedder_online(false);

    let mut refiled_sub = SerpentineGraph::new(GraphOptions {
        name: Some(String::from("sayit-session-1-refiled")),
        emb_model_id: String::from("sayit-foreign-8d-v1"),
        emb_dim: 8,
        auto_split: false,
        ..GraphOptions::default()
    })?;
    let r_proj = refiled_sub.add_branch(BranchOptions {
        id: Some(String::from("s_proj_health")),
        label: Some(String::from("生活健康")),
        text: Some(String::from("作息与体能管理")),
        data: Some(serde_json::json!({ "role": "project", "sessionId": "ses_01" })),
        embedding: Some(vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ..BranchOptions::default()
    })?;
    refiled_sub.add(
        serde_json::json!({ "role": "todo", "sessionId": "ses_01" }),
        ObserveOptions {
            id: Some(String::from("s_leaf_refiled")),
            text: Some(String::from("每晚十一点前入睡恢复精力")),
            parent: Some(r_proj.id.clone()),
            embedding: Some(vec![0.0, 0.9, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0]),
            ..ObserveOptions::default()
        },
    )?;
    let mut refiled_snap = refiled_sub.to_snapshot();
    refiled_snap.meta = Some(snap_meta);

    let ingest_v2 = spine_graph.ingest_sayit_subtree(
        refiled_snap,
        SayItIngestContext {
            sayit_user_hash: String::from("u_alice_hash"),
            slice_id: String::from("2026-W47"),
            session_id: String::from("ses_01"),
            snapshot_sha256: String::from("sha256_v2_refiled"),
            now_ms: 1_795_500_050_000,
            merge_options: MergeOptions::default(),
        },
    )?;
    assert_eq!(ingest_v2.status, SayItIngestStatus::RefiledUpdated);
    assert!(ingest_v2.invalidated_node_ids.contains(&mapped_leaf_v1_id));
    assert!(ingest_v2.invalidated_node_ids.contains(&mapped_sec_id));
    assert!(
        !spine_graph
            .get(&mapped_leaf_v1_id)
            .ok_or("旧叶仍应保留双时态历史")?
            .is_valid(),
        "改归属重编译后旧独占叶节点必须双时态失效"
    );
    assert!(
        spine_graph
            .get(&proj_arch.id)
            .ok_or("共享项目分支不应被删")?
            .is_valid(),
        "原先已存在的主图项目分支 proj_arch 必须保持有效"
    );

    let merge_v2 = ingest_v2
        .merge_result
        .ok_or("重归档合并应返回 MergeResult")?;
    assert!(merge_v2.alignment.used_offline_lexical_fallback);
    assert!(!merge_v2.queued_reembed_ids.is_empty());
    assert!(!spine_graph.pending_reembed_ids().is_empty());
    assert_eq!(spine_graph.verify(), Vec::<String>::new());

    // 恢复在线并执行后台 reembed_pending()
    spine_graph.set_embedder_online(true);
    let reembedded_cnt = spine_graph.reembed_pending()?;
    assert!(reembedded_cnt >= 2);
    assert!(spine_graph.pending_reembed_ids().is_empty());
    assert_eq!(spine_graph.verify(), Vec::<String>::new());

    // 校验多父次级 attach 与 detach 不变量
    let health_proj_id = merge_v2
        .node_map
        .get("s_proj_health")
        .ok_or("缺少 s_proj_health 映射")?
        .clone();
    let refiled_leaf_id = merge_v2
        .node_map
        .get("s_leaf_refiled")
        .ok_or("缺少 s_leaf_refiled 映射")?
        .clone();
    spine_graph.attach(
        &refiled_leaf_id,
        &proj_arch.id,
        AttachOptions {
            primary: false,
            weight: Some(0.5),
            relation: Some(String::from("cross_context")),
            meta: BTreeMap::new(),
        },
    )?;
    assert_eq!(
        spine_graph.get(&refiled_leaf_id).map(|n| n.parents.len()),
        Some(2)
    );
    spine_graph.detach(&refiled_leaf_id, &proj_arch.id)?;
    assert_eq!(
        spine_graph
            .get(&refiled_leaf_id)
            .map(|n| n.primary_parent.as_deref()),
        Some(Some(health_proj_id.as_str()))
    );
    assert_eq!(spine_graph.verify(), Vec::<String>::new());

    let _ = TemporalInput::default();
    let _ = TemporalMode::Collapsed;
    let _ = AlignOptions::default();

    Ok(())
}

#[test]
fn legacy_v1_upgrade_and_broken_invariant_snapshot_rejection() -> TestResult {
    let v1_json = r#"{
      "format": "ewave",
      "version": 1,
      "name": "legacy-v1",
      "createdAt": 1000,
      "updatedAt": 1000,
      "nodes": [
        {
          "id": "root",
          "kind": "root",
          "data": null,
          "text": null,
          "label": null,
          "embedding": null,
          "parents": [],
          "primaryParent": null,
          "children": ["n_0001", "n_0002"],
          "links": [],
          "createdAt": 1000,
          "updatedAt": 1000,
          "meta": {}
        },
        {
          "id": "n_0001",
          "kind": "leaf",
          "data": "alpha",
          "text": "alpha",
          "label": null,
          "embedding": [1, 0, 0],
          "parents": ["root"],
          "primaryParent": "root",
          "children": [],
          "links": ["n_0002"],
          "createdAt": 1000,
          "updatedAt": 1000,
          "meta": {}
        },
        {
          "id": "n_0002",
          "kind": "leaf",
          "data": "beta",
          "text": "beta",
          "label": null,
          "embedding": [0, 1, 0],
          "parents": ["root"],
          "primaryParent": "root",
          "children": [],
          "links": ["n_0001"],
          "createdAt": 1000,
          "updatedAt": 1000,
          "meta": {}
        }
      ],
      "edges": [
        { "from": "root", "to": "n_0001", "kind": "hierarchy", "weight": 1, "createdAt": 1000 },
        { "from": "root", "to": "n_0002", "kind": "hierarchy", "weight": 1, "createdAt": 1000 },
        { "from": "n_0001", "to": "n_0002", "kind": "link", "weight": 1, "createdAt": 1000 }
      ]
    }"#;

    let upgraded = SerpentineGraph::from_json_v2(v1_json)?;
    assert_eq!(upgraded.verify(), Vec::<String>::new());
    assert_eq!(upgraded.to_snapshot().version, 2);
    assert_eq!(
        upgraded
            .edge("n_0001", "n_0002", EdgeKind::Link)
            .map(|e| e.polarity),
        Some(LogicPolarity::Positive)
    );

    // 破坏 primaryParent 指向不存在节点的损坏快照必须被拒收
    let mut broken = upgraded.to_snapshot();
    if let Some(leaf) = broken.nodes.iter_mut().find(|n| n.id == "n_0001") {
        leaf.primary_parent = Some(String::from("missing_parent"));
    }
    assert!(SerpentineGraph::from_snapshot(broken).is_err());

    Ok(())
}

#[test]
fn regression_important_2_sayit_ledger_and_pending_reembed_survive_json_v2_roundtrip() -> TestResult
{
    let mut main_graph = SerpentineGraph::new(GraphOptions {
        name: Some(String::from("persist-roundtrip-main")),
        auto_split: false,
        ..GraphOptions::default()
    })?;
    // 无 SayIt 记录时，root.meta 保持完全干净（不注入额外字段）
    assert!(
        main_graph
            .to_snapshot()
            .nodes
            .iter()
            .find(|n| n.id == "root")
            .is_some_and(|r| r.meta.is_empty())
    );

    // 离线状态下导入一棵异源 8 维 SayIt 子树：产生 pending_reembed 队列与 SayIt 会话记录
    main_graph.set_embedder_online(false);

    let mut sub_v1 = SerpentineGraph::new(GraphOptions {
        emb_model_id: String::from("foreign-8d"),
        emb_dim: 8,
        auto_split: false,
        ..GraphOptions::default()
    })?;
    let p1 = sub_v1.add_branch(BranchOptions {
        id: Some(String::from("p_alpha")),
        label: Some(String::from("项目Alpha")),
        text: Some(String::from("项目Alpha描述")),
        data: Some(serde_json::json!({ "role": "project", "sessionId": "ses_rt" })),
        embedding: Some(vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ..BranchOptions::default()
    })?;
    sub_v1.add(
        serde_json::json!({ "role": "fact", "sessionId": "ses_rt" }),
        ObserveOptions {
            id: Some(String::from("leaf_rt_v1")),
            text: Some(String::from("持久化前首次归档条目")),
            parent: Some(p1.id),
            embedding: Some(vec![0.9, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
            ..ObserveOptions::default()
        },
    )?;
    let mut snap_v1 = sub_v1.to_snapshot();
    let mut fmeta = BTreeMap::new();
    fmeta.insert(
        String::from("emb_model_id"),
        serde_json::json!("foreign-8d"),
    );
    fmeta.insert(String::from("emb_dim"), serde_json::json!(8));
    snap_v1.meta = Some(fmeta.clone());

    let ing_v1 = main_graph.ingest_sayit_subtree(
        snap_v1.clone(),
        SayItIngestContext {
            sayit_user_hash: String::from("u_persist"),
            slice_id: String::from("2026-W48"),
            session_id: String::from("ses_rt"),
            snapshot_sha256: String::from("sha_rt_v1"),
            now_ms: 1_795_600_000_000,
            merge_options: MergeOptions::default(),
        },
    )?;
    let old_leaf_id = ing_v1
        .merge_result
        .as_ref()
        .and_then(|m| m.node_map.get("leaf_rt_v1"))
        .ok_or("缺少 leaf_rt_v1 映射")?
        .clone();
    assert!(!main_graph.pending_reembed_ids().is_empty());

    // 执行 JSON-v2 序列化落盘并冷启动恢复为全新实例
    let persisted_json = main_graph.to_json_v2()?;
    let mut restored = SerpentineGraph::from_json_v2(&persisted_json)?;
    assert_eq!(restored.to_json_v2()?, persisted_json);

    // 1) 验证 pending_reembed 队列在 JSON-v2 往返后未丢失，恢复在线后可成功补算 64 维向量
    assert!(
        !restored.pending_reembed_ids().is_empty(),
        "JSON-v2 往返后 pending_reembed 队列不得丢失"
    );
    restored.set_embedder_online(true);
    let reembedded = restored.reembed_pending()?;
    assert!(reembedded >= 2);
    assert!(restored.pending_reembed_ids().is_empty());

    // 2) 验证 SayIt 账本在 JSON-v2 往返后未丢失：重复导入 v1 为幂等无操作，改归属重编译 v2 自动双时态失效旧独占节点！
    let dup_after_reload = restored.ingest_sayit_subtree(
        snap_v1,
        SayItIngestContext {
            sayit_user_hash: String::from("u_persist"),
            slice_id: String::from("2026-W48"),
            session_id: String::from("ses_rt"),
            snapshot_sha256: String::from("sha_rt_v1"),
            now_ms: 1_795_600_010_000,
            merge_options: MergeOptions::default(),
        },
    )?;
    assert_eq!(dup_after_reload.status, SayItIngestStatus::DuplicateNoOp);

    let mut sub_v2 = SerpentineGraph::new(GraphOptions {
        emb_model_id: String::from("foreign-8d"),
        emb_dim: 8,
        auto_split: false,
        ..GraphOptions::default()
    })?;
    let p2 = sub_v2.add_branch(BranchOptions {
        id: Some(String::from("p_beta")),
        label: Some(String::from("项目Beta")),
        text: Some(String::from("项目Beta描述")),
        data: Some(serde_json::json!({ "role": "project", "sessionId": "ses_rt" })),
        embedding: Some(vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ..BranchOptions::default()
    })?;
    sub_v2.add(
        serde_json::json!({ "role": "fact", "sessionId": "ses_rt" }),
        ObserveOptions {
            id: Some(String::from("leaf_rt_v2")),
            text: Some(String::from("持久化恢复后改归属的新条目")),
            parent: Some(p2.id),
            embedding: Some(vec![0.0, 0.9, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0]),
            ..ObserveOptions::default()
        },
    )?;
    let mut snap_v2 = sub_v2.to_snapshot();
    snap_v2.meta = Some(fmeta);

    let refile_after_reload = restored.ingest_sayit_subtree(
        snap_v2,
        SayItIngestContext {
            sayit_user_hash: String::from("u_persist"),
            slice_id: String::from("2026-W48"),
            session_id: String::from("ses_rt"),
            snapshot_sha256: String::from("sha_rt_v2"),
            now_ms: 1_795_600_020_000,
            merge_options: MergeOptions::default(),
        },
    )?;
    assert_eq!(
        refile_after_reload.status,
        SayItIngestStatus::RefiledUpdated
    );
    assert!(
        refile_after_reload
            .invalidated_node_ids
            .contains(&old_leaf_id)
    );
    assert!(
        !restored
            .get(&old_leaf_id)
            .ok_or("旧节点应保留历史")?
            .is_valid()
    );
    assert_eq!(restored.verify(), Vec::<String>::new());

    Ok(())
}
