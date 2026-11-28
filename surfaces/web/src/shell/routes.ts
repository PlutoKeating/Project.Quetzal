// 九个视图：总览是进来的第一眼，其余八页各回答一个问题（docs/GOVERNANCE_SURFACE.md 第 1 节）。

export type ViewKey =
  | "overview"
  | "self"
  | "user"
  | "us"
  | "memories"
  | "baseline"
  | "hosts"
  | "devices"
  | "audit";

export interface ViewInfo {
  key: ViewKey;
  /** 地址里 `#/` 之后的那一段；总览是空串。 */
  path: string;
  label: string;
  /** 页首的一句话：这一页回答什么。 */
  lead: string;
  /** 出处栏在没有选中任何条目时说的那句话。 */
  sentence: string;
}

export const OVERVIEW: ViewInfo = {
  key: "overview",
  path: "",
  label: "总览",
  lead: "他在不在，他在哪些宿主里，有没有事在等你。",
  sentence: "第一眼只回答三件事：他在不在，他在哪些宿主里，有没有事在等你。想和他说话，去宿主。",
};

/** 导航里的八个入口，顺序固定。 */
export const PAGES: readonly ViewInfo[] = [
  {
    key: "self",
    path: "self",
    label: "他",
    lead: "他现在是谁，最近变了什么。",
    sentence: "选一条核心价值或一次变化，这里会写明它是从哪些相处里长出来的。",
  },
  {
    key: "user",
    path: "user",
    label: "我",
    lead: "他眼里的你：他据此调整做法的偏好，和他据此理解你的事实。",
    sentence: "选一条，这里会写明它来自哪次相处，有没有被纠正过。",
  },
  {
    key: "us",
    path: "us",
    label: "我们",
    lead: "你们共同的承诺，和他此刻更迎合谁。",
    sentence: "选一条承诺，这里会写明它属于哪一段关系，以及他眼里的对方。",
  },
  {
    key: "memories",
    path: "memories",
    label: "往事",
    lead: "他记得的事。搜一搜，看他记得对不对。",
    sentence: "选一件往事，这里会写明谁、在什么时候写下和改过它。",
  },
  {
    key: "baseline",
    path: "baseline",
    label: "底线",
    lead: "无论如何不许变的几件事。写下并签署之后，它们先于一切送进每一个宿主。",
    sentence: "底线只有经你亲手签署才生效。这里写明它是什么时候签下的。",
  },
  {
    key: "hosts",
    path: "hosts",
    label: "宿主",
    lead: "他住在哪些工具里，每一步通不通。",
    sentence: "选一项检查，这里会写明它查的是什么，结果是什么。",
  },
  {
    key: "devices",
    path: "devices",
    label: "设备",
    lead: "哪些设备上有他。丢了的那一台，在这里吊销。",
    sentence: "选一台设备，这里会写明它什么时候加入、最近什么时候在线。",
  },
  {
    key: "audit",
    path: "audit",
    label: "记录",
    lead: "每一次写入：谁，在什么时候，写了什么。",
    sentence: "选一条记录，这里会显示它写入的完整内容。",
  },
];

export const ALL_VIEWS: readonly ViewInfo[] = [OVERVIEW, ...PAGES];

export function viewInfo(key: ViewKey): ViewInfo {
  const info = ALL_VIEWS.find((view) => view.key === key);
  if (!info) throw new Error(`没有「${key}」这个视图`);
  return info;
}

export interface Route {
  info: ViewInfo;
  /** 路径里视图名之后的那一段，例如 `#/memories/<id>` 里的 id。 */
  param: string | null;
}

export function parseRoute(hash: string): Route {
  const [head = "", ...rest] = hash.replace(/^#\/?/u, "").split("/");
  const info = ALL_VIEWS.find((view) => view.path === head) ?? OVERVIEW;
  const tail = rest.join("/");
  let param: string | null = null;
  if (tail !== "") {
    try {
      param = decodeURIComponent(tail);
    } catch {
      param = tail;
    }
  }
  return { info, param };
}

export function hrefFor(key: ViewKey, param?: string): string {
  const base = `#/${viewInfo(key).path}`;
  return param === undefined ? base : `${base}/${encodeURIComponent(param)}`;
}
