import { defineMessages } from "~/i18n/core";

export const messages = defineMessages({
  zh: {
    title: "下载 · Quetzal",
    description: "下载 Quetzal：安卓手机、Windows 电脑、Linux 电脑。",
    heading: "Quetzal",
    lead: "一部旧手机，或者一台电脑。",
    tabsLabel: "选择你的设备",
    copy: "复制",
    copied: "已复制",
    guide: "安装说明",
    platforms: {
      android: { tab: "安卓", download: "下载 App", meta: "Android 7+ · arm64" },
      windows: {
        tab: "Windows",
        command: "irm https://quetzal.plutokeating.beer/install.ps1 | iex",
        installer: "或下载安装包",
        arm64: "arm64",
        meta: "Windows 10 1809+ · 安装包暂未签名",
      },
      linux: {
        tab: "Linux",
        command: "curl -fsSL https://quetzal.plutokeating.beer/install | bash",
        meta: "x86_64 · arm64 · 再运行一次即升级",
      },
    },
    latest: { notes: "更新内容", all: "所有版本", prerelease: "预览版", empty: "这个版本没有写更新内容。" },
    state: { error: "读取版本信息失败", retry: "重试" },
  },
  en: {
    title: "Download · Quetzal",
    description: "Download Quetzal for Android phones, Windows PCs and Linux computers.",
    heading: "Quetzal",
    lead: "An old phone, or a computer.",
    tabsLabel: "Choose your device",
    copy: "Copy",
    copied: "Copied",
    guide: "Install guide",
    platforms: {
      android: { tab: "Android", download: "Download the app", meta: "Android 7+ · arm64" },
      windows: {
        tab: "Windows",
        command: "irm https://quetzal.plutokeating.beer/install.ps1 | iex",
        installer: "or download the installer",
        arm64: "arm64",
        meta: "Windows 10 1809+ · installer not yet signed",
      },
      linux: {
        tab: "Linux",
        command: "curl -fsSL https://quetzal.plutokeating.beer/install | bash",
        meta: "x86_64 · arm64 · run again to upgrade",
      },
    },
    latest: { notes: "What's new", all: "All releases", prerelease: "Pre-release", empty: "This release has no notes." },
    state: { error: "Could not read release information", retry: "Retry" },
  },
});
