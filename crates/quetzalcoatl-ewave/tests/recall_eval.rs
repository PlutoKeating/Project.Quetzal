#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 召回评测：一份小的、可复现的中英文数据，量两件用户感觉得到的事。
//!
//! 1. **自动带入**：用户说一句话，相关的那条往事有没有被带进去；说的是无关的事时，是不是什么都不带。
//! 2. **主动查**：模型用一句话去查，目标排在第几。
//!
//! 提问分三类，难度递增：和往事用了同样的词、只共用一个关键词、完全换了说法（没有共同的实词）。
//! 第三类是按词匹配的召回做不到的；把它量出来，是为了决定要不要引入本机语义向量。
//!
//! 全部是合成数据，全部是确定性计算。生成报告：
//!
//! ```bash
//! RECALL_EVAL_REPORT_DIR=docs/bench \
//!   cargo test -p quetzalcoatl-ewave --test recall_eval -- --nocapture
//! ```

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

use quetzalcoatl_crypto::AccountRootKey;
use quetzalcoatl_ewave::{
    AssemblyRequest, Authority, BudgetProfile, Conscience, ConscienceManifest, ContextAssembler,
    FocusConfig, GraphOptions, InjectionSurface, MemoryEntry, MemoryKind, Mutability,
    ObserveOptions, ProtectedDirective, ProvenanceRecord, SerpentineGraph, search_memories,
};

type TestResult = Result<(), Box<dyn Error>>;

const BASE_MS: u64 = 1_795_400_000_000;
const REPORT_DATE: &str = "2026-11-28";

/// 往事：编号与正文。每个话题四条，话题之间互不相干。
const MEMORIES: &[(&str, &str)] = &[
    // 发布流程
    (
        "rel-1",
        "鸢尾花计划的发布日定在每周四，发版前必须跑完全量门禁",
    ),
    ("rel-2", "发布说明要写给用户看，不写内部任务编号"),
    (
        "rel-3",
        "回滚预案：发布后两小时内指标异常就回退到上一个标签",
    ),
    (
        "rel-4",
        "The release checklist lives in the ops handbook, section 4",
    ),
    // 数据库
    ("db-1", "生产数据库的迁移要先在预发环境演练一遍"),
    ("db-2", "订单表按月分区，历史分区只读"),
    ("db-3", "连接池上限是 40，超过会触发告警"),
    (
        "db-4",
        "Postgres major upgrades are scheduled for the first weekend of each quarter",
    ),
    // 个人偏好
    ("pref-1", "用户喜欢简短的总结，先给结论再给理由"),
    ("pref-2", "用户不喝咖啡，下午只喝白茶"),
    ("pref-3", "用户习惯在早上九点之前处理邮件"),
    (
        "pref-4",
        "The user prefers tabs over spaces in Makefiles only",
    ),
    // 家庭
    ("fam-1", "女儿的钢琴课在周三晚上七点"),
    ("fam-2", "母亲对青霉素过敏，就医时要提醒医生"),
    ("fam-3", "家里的猫叫栗子，今年四岁"),
    (
        "fam-4",
        "The family reunion is planned for the lunar new year in Chengdu",
    ),
    // 论文
    ("paper-1", "论文第三章的消融实验还缺两组对照"),
    ("paper-2", "审稿人二要求补充与基线方法的显著性检验"),
    ("paper-3", "投稿截止日期是三月十五日，摘要提前一周交"),
    (
        "paper-4",
        "The related work section must cite the 2024 survey on memory agents",
    ),
    // 健身
    ("fit-1", "膝盖受过伤，跑步每次不超过五公里"),
    ("fit-2", "每周二和周五去游泳，各一千米"),
    ("fit-3", "体检报告显示维生素 D 偏低，医生建议多晒太阳"),
    (
        "fit-4",
        "Deadlift personal record is 120 kilograms, set last spring",
    ),
    // 旅行
    ("trip-1", "十月去京都的行程：住在鸭川附近，第三天去岚山"),
    ("trip-2", "护照明年六月到期，出行前要先换发"),
    ("trip-3", "晕船，轮渡行程要提前吃药"),
    (
        "trip-4",
        "Frequent flyer number is stored in the password manager under travel",
    ),
    // 团队
    ("team-1", "周会改到周一上午十点，时长压到三十分钟"),
    ("team-2", "新来的后端同事负责支付网关的重构"),
    ("team-3", "代码评审要求至少一位非作者批准才能合并"),
    (
        "team-4",
        "The on-call rotation switches every Tuesday at noon",
    ),
    // 财务
    ("fin-1", "房贷每月十五日扣款，账户里要留足余额"),
    ("fin-2", "年度个税汇算要在六月底之前完成"),
    ("fin-3", "给父母的生活费每季度转一次"),
    (
        "fin-4",
        "The emergency fund target is six months of expenses",
    ),
    // 工具
    ("tool-1", "这个仓库用 pnpm 管理依赖，不要用 npm 安装"),
    ("tool-2", "部署脚本要求先登录内网代理，否则拉不到镜像"),
    ("tool-3", "格式化统一用仓库自带的配置，不接受个人风格"),
    (
        "tool-4",
        "Shell aliases are kept in a dotfiles repository, synced weekly",
    ),
    // 阅读
    ("read-1", "正在读一本讲系统思考的书，读到第六章反馈回路"),
    ("read-2", "不喜欢读电子书，长篇只读纸质版"),
    ("read-3", "读书笔记按主题归档，不按时间"),
    (
        "read-4",
        "The book club meets on the last Sunday of every month",
    ),
    // 硬件
    ("hw-1", "台式机的显卡是二手的，高负载时风扇很吵"),
    ("hw-2", "笔记本的电池健康度降到百分之七十八，准备年底更换"),
    ("hw-3", "家里的路由器刷了开源固件，端口转发规则记在备忘里"),
    (
        "hw-4",
        "The home server backs up to an external drive every night at two",
    ),
];

/// 难度一：提问和往事用了同样的词。
const SAME_WORDS: &[(&str, &str)] = &[
    ("鸢尾花计划的发布日是哪天", "rel-1"),
    ("生产数据库迁移之前要做什么", "db-1"),
    ("母亲对什么药过敏", "fam-2"),
    ("女儿的钢琴课是什么时候", "fam-1"),
    ("论文的投稿截止日期", "paper-3"),
    ("护照什么时候到期", "trip-2"),
    ("周会现在是几点", "team-1"),
    ("房贷哪天扣款", "fin-1"),
    ("这个仓库用什么管理依赖", "tool-1"),
    ("笔记本的电池健康度怎么样", "hw-2"),
    ("where is the release checklist", "rel-4"),
    ("when does the on-call rotation switch", "team-4"),
    ("what is the emergency fund target", "fin-4"),
    ("when does the book club meet", "read-4"),
];

/// 难度二：只共用一个关键词，其余换了说法。
const ONE_KEYWORD: &[(&str, &str)] = &[
    ("出了问题怎么回滚", "rel-3"),
    ("连接池设得多大", "db-3"),
    ("下午给我泡点什么喝", "pref-2"),
    ("栗子多大了", "fam-3"),
    ("审稿人二提了什么意见", "paper-2"),
    ("我每次跑步能跑多远", "fit-1"),
    ("去京都住哪里", "trip-1"),
    ("支付网关现在谁在做", "team-2"),
    ("个税的事要什么时候办完", "fin-2"),
    ("为什么拉不到镜像", "tool-2"),
    ("那本系统思考的书看到哪了", "read-1"),
    ("路由器的端口转发规则在哪", "hw-3"),
    ("what was my deadlift record", "fit-4"),
    ("how often is the home server backed up", "hw-4"),
];

/// 难度三：完全换了说法，没有共同的实词。按词匹配做不到，量出来留作基线。
const PARAPHRASE: &[(&str, &str)] = &[
    ("我们什么时候上线新版本", "rel-1"),
    ("改表结构之前有什么规矩", "db-1"),
    ("汇报时我希望怎么组织内容", "pref-1"),
    ("妈妈看病要注意什么", "fam-2"),
    ("稿子最晚哪天交", "paper-3"),
    ("我的腿有什么毛病", "fit-1"),
    ("出国证件还能用多久", "trip-2"),
    ("例会安排有什么变化", "team-1"),
    ("按揭的钱什么时候划走", "fin-1"),
    ("装包应该用哪个命令", "tool-1"),
    ("我看小说用什么载体", "read-2"),
    ("那台旧电脑为什么这么响", "hw-1"),
];

/// 无关的提问：日常的工作指令，不该带入任何往事。
const UNRELATED: &[&str] = &[
    "把这个函数的返回值改成 Result",
    "解释一下这段正则表达式",
    "帮我把这个 JSON 格式化",
    "这个报错是什么意思",
    "写一个二分查找",
    "把变量名改成蛇形命名",
    "run the test suite again",
    "explain what this closure captures",
    "add a docstring to this method",
    "why does this loop never terminate",
    "把这两个分支合并一下",
    "继续",
];

fn memory(id: &str, content: &str, index: u64) -> MemoryEntry {
    MemoryEntry {
        id: String::from(id),
        kind: MemoryKind::Fact,
        topic: None,
        content: String::from(content),
        about: Vec::new(),
        salience: 0.6,
        evidence_count: 1,
        constant: false,
        untrusted: false,
        muted: false,
        pressure_flags: Vec::new(),
        authority: Authority::Memory,
        mutability: Mutability::memory_free(),
        valid_from_ms: BASE_MS + index * 60_000,
        invalid_at_ms: None,
        triggers: Vec::new(),
        provenance: ProvenanceRecord {
            written_by: String::from("owner"),
            at_ms: BASE_MS + index * 60_000,
            source_event_ids: Vec::new(),
            model: None,
            supersedes: None,
        },
    }
}

fn build_sea() -> Result<(Conscience, SerpentineGraph), Box<dyn Error>> {
    let root_key = AccountRootKey::from_bytes([0x51u8; 32]);
    let root_directives: Vec<ProtectedDirective> = Vec::new();
    let operator_directives: Vec<ProtectedDirective> = Vec::new();
    let manifest = ConscienceManifest::sign_with_root(
        &root_key,
        &root_directives,
        &operator_directives,
        BASE_MS,
    )?;
    let mut conscience = Conscience {
        schema_version: String::from("ewave-conscience/v1"),
        root_directives,
        operator_directives,
        manifest,
        identity: Vec::new(),
        values: Vec::new(),
        relationships: Vec::new(),
        memories: Vec::new(),
        focus: FocusConfig::default(),
        grants_given: Vec::new(),
        grants_received: Vec::new(),
        episodes: Vec::new(),
        peer_links: BTreeMap::new(),
        pending_disclosures: Vec::new(),
    };
    let mut graph = SerpentineGraph::new(GraphOptions::default())?;
    for (index, (id, content)) in MEMORIES.iter().enumerate() {
        let entry = memory(id, content, index as u64);
        graph.observe(
            serde_json::json!({"memory_id": id}),
            ObserveOptions {
                id: Some(String::from(*id)),
                text: Some(String::from(*content)),
                at: Some(entry.valid_from_ms),
                ..Default::default()
            },
        )?;
        conscience.memories.push(entry);
    }
    Ok((conscience, graph))
}

#[derive(Default)]
struct ClassResult {
    queries: usize,
    /// 自动带入里有目标。
    injected_hits: usize,
    /// 自动带入的条数合计。
    injected_total: usize,
    /// 主动查：目标排第一。
    tool_top1: usize,
    /// 主动查：目标在前五。
    tool_top5: usize,
    reciprocal_rank_sum: f64,
    misses: Vec<String>,
}

impl ClassResult {
    fn rate(hits: usize, total: usize) -> f64 {
        if total == 0 {
            0.0
        } else {
            hits as f64 / total as f64
        }
    }
    fn injected_rate(&self) -> f64 {
        Self::rate(self.injected_hits, self.queries)
    }
    fn top1_rate(&self) -> f64 {
        Self::rate(self.tool_top1, self.queries)
    }
    fn top5_rate(&self) -> f64 {
        Self::rate(self.tool_top5, self.queries)
    }
    fn mrr(&self) -> f64 {
        if self.queries == 0 {
            0.0
        } else {
            self.reciprocal_rank_sum / self.queries as f64
        }
    }
    fn mean_injected(&self) -> f64 {
        if self.queries == 0 {
            0.0
        } else {
            self.injected_total as f64 / self.queries as f64
        }
    }
}

fn inject(
    conscience: &Conscience,
    graph: &SerpentineGraph,
    query: &str,
) -> Result<Vec<String>, Box<dyn Error>> {
    let mut request = AssemblyRequest::new(BudgetProfile::Standard, BASE_MS + 86_400_000);
    request.surface = InjectionSurface::HostSession;
    request.query = Some(String::from(query));
    Ok(ContextAssembler::assemble(conscience, graph, &request)?.inlined_recall_ids)
}

fn evaluate(
    conscience: &Conscience,
    graph: &SerpentineGraph,
    cases: &[(&str, &str)],
) -> Result<ClassResult, Box<dyn Error>> {
    let mut result = ClassResult {
        queries: cases.len(),
        ..ClassResult::default()
    };
    for (query, target) in cases {
        let injected = inject(conscience, graph, query)?;
        result.injected_total += injected.len();
        let injected_hit = injected.iter().any(|id| id == target);
        if injected_hit {
            result.injected_hits += 1;
        }
        let ranked = search_memories(conscience, query, 8);
        let rank = ranked.iter().position(|item| item.id == *target);
        if let Some(rank) = rank {
            if rank == 0 {
                result.tool_top1 += 1;
            }
            if rank < 5 {
                result.tool_top5 += 1;
            }
            result.reciprocal_rank_sum += 1.0 / (rank as f64 + 1.0);
        }
        if !injected_hit {
            result.misses.push(format!("{query} → {target}"));
        }
    }
    Ok(result)
}

fn percent(value: f64) -> String {
    format!("{:.0}%", value * 100.0)
}

fn render_report(
    same: &ClassResult,
    keyword: &ClassResult,
    paraphrase: &ClassResult,
    silent: usize,
    noisy: &[String],
) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# 召回评测基线（{REPORT_DATE}）\n");
    let _ = writeln!(
        out,
        "合成数据：{} 条往事（12 个互不相干的话题，中英文混合），{} 句提问。全部是确定性计算，不调用任何模型。\n",
        MEMORIES.len(),
        SAME_WORDS.len() + ONE_KEYWORD.len() + PARAPHRASE.len() + UNRELATED.len()
    );
    let _ = writeln!(out, "## 结论\n");
    let _ = writeln!(
        out,
        "- 提问里有往事里的词时，召回可用：同词 {}、单关键词 {} 被自动带入。",
        percent(same.injected_rate()),
        percent(keyword.injected_rate())
    );
    let _ = writeln!(
        out,
        "- 完全换了说法时基本带不进来（{}）。这是按词匹配的上限，不是缺陷修得掉的。",
        percent(paraphrase.injected_rate())
    );
    let _ = writeln!(
        out,
        "- 说无关的事时保持安静：{} 句里 {} 句什么都不带。\n",
        UNRELATED.len(),
        silent
    );
    let _ = writeln!(out, "## 数字\n");
    let _ = writeln!(
        out,
        "| 提问类型 | 句数 | 自动带入命中 | 平均带入条数 | 主动查排第一 | 主动查前五 | MRR |"
    );
    let _ = writeln!(out, "|---|---|---|---|---|---|---|");
    for (name, result) in [
        ("和往事用了同样的词", same),
        ("只共用一个关键词", keyword),
        ("完全换了说法", paraphrase),
    ] {
        let _ = writeln!(
            out,
            "| {name} | {} | {} | {:.1} | {} | {} | {:.2} |",
            result.queries,
            percent(result.injected_rate()),
            result.mean_injected(),
            percent(result.top1_rate()),
            percent(result.top5_rate()),
            result.mrr()
        );
    }
    let _ = writeln!(
        out,
        "\n无关提问：{} 句，{} 句保持安静（{}）。",
        UNRELATED.len(),
        silent,
        percent(ClassResult::rate(silent, UNRELATED.len()))
    );
    let _ = writeln!(out, "\n## 没有带入的提问\n");
    for (name, result) in [
        ("和往事用了同样的词", same),
        ("只共用一个关键词", keyword),
        ("完全换了说法", paraphrase),
    ] {
        let _ = writeln!(out, "**{name}**\n");
        if result.misses.is_empty() {
            let _ = writeln!(out, "- （全部带入）");
        }
        for miss in &result.misses {
            let _ = writeln!(out, "- {miss}");
        }
        let _ = writeln!(out);
    }
    if !noisy.is_empty() {
        let _ = writeln!(out, "**无关提问却带入了往事**\n");
        for line in noisy {
            let _ = writeln!(out, "- {line}");
        }
        let _ = writeln!(out);
    }
    let _ = writeln!(out, "## 复现\n");
    let _ = writeln!(
        out,
        "```bash\nRECALL_EVAL_REPORT_DIR=docs/bench \\\n  cargo test -p quetzalcoatl-ewave --test recall_eval -- --nocapture\n```"
    );
    out
}

#[test]
fn recall_baseline_holds_and_the_report_is_reproducible() -> TestResult {
    let (conscience, graph) = build_sea()?;
    let same = evaluate(&conscience, &graph, SAME_WORDS)?;
    let keyword = evaluate(&conscience, &graph, ONE_KEYWORD)?;
    let paraphrase = evaluate(&conscience, &graph, PARAPHRASE)?;

    let mut silent = 0usize;
    let mut noisy = Vec::new();
    for query in UNRELATED {
        let injected = inject(&conscience, &graph, query)?;
        if injected.is_empty() {
            silent += 1;
        } else {
            noisy.push(format!("{query} → {}", injected.join("、")));
        }
    }

    let report = render_report(&same, &keyword, &paraphrase, silent, &noisy);
    println!("{report}");
    if let Some(dir) = std::env::var_os("RECALL_EVAL_REPORT_DIR") {
        // 测试的工作目录是本 crate；相对路径按仓库根解释。
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(PathBuf::from(dir));
        fs::create_dir_all(&dir)?;
        fs::write(dir.join(format!("recall-eval-{REPORT_DATE}.md")), &report)?;
    }

    // 回归地板：比量到的基线略低，防止以后改坏。
    assert!(
        same.injected_rate() >= 0.85,
        "同词提问的自动带入不得低于 85%: {}",
        percent(same.injected_rate())
    );
    assert!(
        keyword.injected_rate() >= 0.6,
        "单关键词提问的自动带入不得低于 60%: {}",
        percent(keyword.injected_rate())
    );
    assert!(
        silent * 10 >= UNRELATED.len() * 9,
        "无关提问至少九成保持安静: {silent}/{}",
        UNRELATED.len()
    );
    assert!(
        same.mean_injected() <= 3.0 && keyword.mean_injected() <= 3.0,
        "带入要克制：平均不超过三条"
    );
    Ok(())
}
