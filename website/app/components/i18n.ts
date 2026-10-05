import { defineMessages } from "~/i18n/core";

/** 顶栏、页脚等全站壳层的文案。 */
export const shellMessages = defineMessages({
  zh: {
    nav: { features: "亮点", docs: "文档", download: "下载", account: "账户", github: "GitHub" },
    menu: "菜单",
    close: "关闭",
    theme: { label: "外观", system: "跟随系统", light: "浅色", dark: "深色" },
    footer: {
      tagline: "不是运行着，是活着。\n活成一缕风。",
      sections: "板块",
      project: "项目",
      legal: "法律",
      about: "关于我们",
      terms: "条款与条件",
      privacy: "隐私政策",
      changelog: "更新日志",
      source: "源代码",
      issues: "问题反馈",
      license: "以 AGPL-3.0 许可开源",
      practice: "一台旧手机上的实践：Project.Honor9",
    },
    skip: "跳到正文",
  },
  en: {
    nav: { features: "Features", docs: "Docs", download: "Download", account: "Account", github: "GitHub" },
    menu: "Menu",
    close: "Close",
    theme: { label: "Appearance", system: "System", light: "Light", dark: "Dark" },
    footer: {
      tagline: "Not running, but living.\nLiving like wind.",
      sections: "Sections",
      project: "Project",
      legal: "Legal",
      about: "About Us",
      terms: "Terms & Conditions",
      privacy: "Privacy Policy",
      changelog: "Changelog",
      source: "Source code",
      issues: "Issues",
      license: "Open source under AGPL-3.0",
      practice: "Practice on an old phone: Project.Honor9",
    },
    skip: "Skip to content",
  },
});

export const GITHUB_REPO = "https://github.com/PlutoKeating/Project.Quetzal";
export const GITHUB_ISSUES = `${GITHUB_REPO}/issues`;
export const GITHUB_RELEASES = `${GITHUB_REPO}/releases`;
export const HONOR9_REPO = "https://github.com/PlutoKeating/Project.Honor9";
