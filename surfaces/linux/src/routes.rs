#![forbid(unsafe_code)]

//! 九页：总览是进来的第一眼，其余八页各回答一个问题（`docs/GOVERNANCE_SURFACE.md` 第 1 节）。

/// 九个视图的键，顺序即导航顺序。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PageKey {
    Overview,
    SelfPage,
    User,
    Us,
    Memories,
    Baseline,
    Hosts,
    Devices,
    Audit,
}

/// 一页的名字与说明。
#[derive(Clone, Copy, Debug)]
pub struct PageInfo {
    pub key: PageKey,
    /// 稳定的机器名（控件名、自检输出、测试）。
    pub slug: &'static str,
    pub label: &'static str,
    /// 页首的一句话：这一页回答什么。
    pub lead: &'static str,
    /// 出处栏在没有选中任何条目时说的那句话。
    pub sentence: &'static str,
}

/// 九页，顺序固定。
pub const PAGES: [PageInfo; 9] = [
    PageInfo {
        key: PageKey::Overview,
        slug: "overview",
        label: "总览",
        lead: "他在不在，他在哪些宿主里，有没有事在等你。",
        sentence: "第一眼只回答三件事：他在不在，他在哪些宿主里，有没有事在等你。想和他说话，去宿主。",
    },
    PageInfo {
        key: PageKey::SelfPage,
        slug: "self",
        label: "他",
        lead: "他现在是谁，最近变了什么。",
        sentence: "选一条核心价值或一次变化，这里会写明它是从哪些相处里长出来的。",
    },
    PageInfo {
        key: PageKey::User,
        slug: "user",
        label: "我",
        lead: "他眼里的你：他据此调整做法的偏好，和他据此理解你的事实。",
        sentence: "选一条，这里会写明它来自哪次相处，有没有被纠正过。",
    },
    PageInfo {
        key: PageKey::Us,
        slug: "us",
        label: "我们",
        lead: "你们共同的承诺，和他此刻更迎合谁。",
        sentence: "选一条承诺，这里会写明它属于哪一段关系，以及他眼里的对方。",
    },
    PageInfo {
        key: PageKey::Memories,
        slug: "memories",
        label: "往事",
        lead: "他记得的事。搜一搜，看他记得对不对。",
        sentence: "选一件往事，这里会写明谁、在什么时候写下和改过它。",
    },
    PageInfo {
        key: PageKey::Baseline,
        slug: "baseline",
        label: "底线",
        lead: "无论如何不许变的几件事。写下并签署之后，它们先于一切送进每一个宿主。",
        sentence: "底线只有经你亲手签署才生效。这里写明它是什么时候签下的。",
    },
    PageInfo {
        key: PageKey::Hosts,
        slug: "hosts",
        label: "宿主",
        lead: "他住在哪些工具里，每一步通不通。",
        sentence: "选一项检查，这里会写明它查的是什么，结果是什么。",
    },
    PageInfo {
        key: PageKey::Devices,
        slug: "devices",
        label: "设备",
        lead: "哪些设备上有他。丢了的那一台，在这里吊销。",
        sentence: "选一台设备，这里会写明它什么时候加入、最近什么时候在线。",
    },
    PageInfo {
        key: PageKey::Audit,
        slug: "audit",
        label: "记录",
        lead: "每一次写入：谁，在什么时候，写了什么。",
        sentence: "选一条记录，这里会显示它写入的完整内容。",
    },
];

impl PageKey {
    /// 这一页的名字与说明。
    #[must_use]
    pub fn info(self) -> &'static PageInfo {
        PAGES
            .iter()
            .find(|info| info.key == self)
            .unwrap_or(&PAGES[0])
    }

    /// 按机器名找页。
    #[must_use]
    pub fn from_slug(slug: &str) -> Option<Self> {
        PAGES
            .iter()
            .find(|info| info.slug == slug)
            .map(|info| info.key)
    }
}
