import type { Lang } from "~/i18n/core";
import type { RailCell } from "~/lib/content";

export type Os = "linux" | "macos" | "windows";

export type DownloadMessages = {
  metaTitle: string;
  metaDescription: string;
  /** 标题里品牌名前后的文字；品牌名本身用光谱字标 */
  title: { before: string; after: string };
  lead: string;
  choose: string;
  os: Record<Os, string>;
  /** 命令条下面的一行说明 */
  under: { installer: string[]; source: string[] };
  steps: { title: string; lead: string; cells: RailCell[]; verify: string };
  release: {
    lead: string;
    loading: string;
    failed: string;
    none: string;
    retry: string;
    signed: string;
    prerelease: string;
    archive: string;
    size: string;
    missing: string;
    noPackage: { title: string; text: string };
    fromSource: { title: string; text: string };
  };
  close: { title: string; note: string; connect: string };
};

const zh: DownloadMessages = {
  metaTitle: "下载",
  metaDescription: "一行命令安装 Quetzalcoatl。安装器先验证签名、再核对内容，最后一步自动接进本机已有的宿主。",
  title: { before: "下载 ", after: "" },
  lead: "一行命令。安装器先验证签名，再核对内容，最后一步把它接进本机已有的宿主。",
  choose: "选择你的系统",
  os: { linux: "Linux", macos: "macOS", windows: "Windows" },
  under: {
    installer: ["x64 与 arm64 自动识别", "先验签，后安装"],
    source: ["这个平台目前只有源码构建", "构建后运行 qz connect"],
  },
  steps: {
    title: "安装器做的三件事",
    lead: "顺序固定。前一步对不上，后一步不会发生。",
    cells: [
      { num: "01", title: "验证签名", text: "安装包的清单带签名，公钥写在安装器里。签名对不上，什么都不会装。" },
      { num: "02", title: "核对内容", text: "下载到的每个文件，都和签过名的清单逐一核对。" },
      { num: "03", tone: "ice", title: "接上宿主", text: "安装的最后一步，自动把它接进本机已有的宿主。", accent: true },
    ],
    verify: "自己动手验签",
  },
  release: {
    lead: "这里只列出带完整签名清单的发布。",
    loading: "正在读取版本信息",
    failed: "版本信息暂时读不到。上面的安装命令不受影响。",
    none: "目前还没有带完整签名清单的发布。",
    retry: "重试",
    signed: "已签名",
    prerelease: "预发布",
    archive: "下载压缩包",
    size: "大小",
    missing: "这个版本没有这个架构的安装包。",
    noPackage: { title: "安装包", text: "这个平台目前没有安装包。" },
    fromSource: { title: "从源码构建", text: "在本机构建出同样的命令行与后台服务，再把它接上宿主。" },
  },
  close: { title: "装好之后，打开你的宿主。", note: "状态栏上出现他的名字，就是接上了。", connect: "接上宿主" },
};

const en: DownloadMessages = {
  metaTitle: "Download",
  metaDescription: "Install Quetzalcoatl with one command. The installer verifies the signature, checks the contents, and as its last step connects it to the hosts already on this machine.",
  title: { before: "Download ", after: "" },
  lead: "One command. The installer verifies the signature, checks the contents, and as its last step connects it to the hosts already on this machine.",
  choose: "Choose your system",
  os: { linux: "Linux", macos: "macOS", windows: "Windows" },
  under: {
    installer: ["x64 and arm64 detected for you", "verified before it installs"],
    source: ["this platform builds from source for now", "then run qz connect"],
  },
  steps: {
    title: "Three things the installer does",
    lead: "The order is fixed. If one step does not match, the next never happens.",
    cells: [
      { num: "01", title: "Verify the signature", text: "The package manifest is signed, and the public key is written into the installer. If the signature does not match, nothing is installed." },
      { num: "02", title: "Check the contents", text: "Every downloaded file is checked against the signed manifest." },
      { num: "03", tone: "ice", title: "Connect the host", text: "As its last step, the installer connects it to the hosts already on this machine.", accent: true },
    ],
    verify: "Verify it by hand",
  },
  release: {
    lead: "Only releases with a complete signed manifest are listed here.",
    loading: "Reading release information",
    failed: "Release information is unavailable right now. The install command above is unaffected.",
    none: "There is no release with a complete signed manifest yet.",
    retry: "Retry",
    signed: "signed",
    prerelease: "pre-release",
    archive: "Download the archive",
    size: "Size",
    missing: "This release has no package for this architecture.",
    noPackage: { title: "Packages", text: "There is no package for this platform yet." },
    fromSource: { title: "Build from source", text: "Build the same command line and background service on your machine, then connect it to a host." },
  },
  close: { title: "Once it is installed, open your host.", note: "When the name appears in the status bar, it is connected.", connect: "Connect a host" },
};

export const messages: Record<Lang, DownloadMessages> = { zh, en };
