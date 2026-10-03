import { defineMessages } from "~/i18n/core";

export const messages = defineMessages({
  zh: {
    title: "隐私政策 · Windler",
    description: "Windler 官网不设账号、不用 Cookie、不加载统计脚本；Windler 软件的数据只留在你的设备与你选择的服务上。",
    eyebrow: "隐私政策",
    heading: "隐私政策",
    lead: "一句话：本网站不收集你的个人信息。下面说明网站与软件各自会接触到什么。",
    updated: "最近更新：2026 年 10 月 4 日",
    sections: [
      { heading: "1. 本网站", paragraphs: ["本网站是纯静态站点，没有账号、没有表单、没有服务端数据库，不设置 Cookie，不加载任何统计、广告或第三方字体脚本。"], bullets: [
        "语言与外观偏好保存在你浏览器的 localStorage 里（键 windler.lang、windler.theme），只在你的设备上，随时可在浏览器中清除。",
        "下载页由你的浏览器直接向 GitHub 公开 API（api.github.com）请求版本信息；该请求受 GitHub 的隐私政策约束。结果在 sessionStorage 缓存 10 分钟。",
        "本网站托管在 Cloudflare。Cloudflare 作为托管与网络服务商可能按其隐私政策处理连接日志（如 IP 地址）；本项目不读取、不保存这些日志。",
        "字体（Inter）由本站自托管，不向第三方请求。",
      ] },
      { heading: "2. Windler 软件", paragraphs: ["Windler 的运行数据全部保存在你的设备上（WINDLER_HOME 目录）：配置、对话、时间线、审计、保密库与本地灵魂目录。作者没有任何服务器接收这些数据。"], bullets: [
        "模型供应商：你配置了哪个供应商，对话与内省的内容就会发送给哪个供应商，受其隐私政策约束。API Key 在本机加密存储。",
        "灵魂仓库（可选）：人格与记忆同步到你自己选择的 git 私有仓库，由你的 git 托管商保管。",
        "飞书（可选）：接入后消息经飞书平台传递，受飞书的隐私政策约束。",
        "设备能力：相机、麦克风、定位、操作屏幕默认每次询问；采集到的内容只在设备上使用，并按你的授权设置执行。",
        "保密传递：通过 pass_secret 交给 agent 的密码与令牌只存进本机保密库，不进入对话与模型上下文。",
      ] },
      { heading: "3. 未成年人", paragraphs: ["本网站与软件不面向 16 岁以下的未成年人，也不会有意收集其信息。"], bullets: [] },
      { heading: "4. 变更", paragraphs: ["本政策更新后在本页发布即生效，页首标注最近更新日期。"], bullets: [] },
      { heading: "5. 联系", paragraphs: ["关于隐私的问题请通过 GitHub Issues 提出。"], bullets: [] },
    ],
  },
  en: {
    title: "Privacy Policy · Windler",
    description: "The Windler website has no accounts, no cookies and no analytics; the Windler software keeps its data on your device and the services you choose.",
    eyebrow: "Privacy Policy",
    heading: "Privacy Policy",
    lead: "In one sentence: this website does not collect your personal information. Below is what the site and the software each touch.",
    updated: "Last updated: October 4, 2026",
    sections: [
      { heading: "1. This website", paragraphs: ["This is a purely static site: no accounts, no forms, no server-side database, no cookies, and no analytics, advertising or third-party font scripts."], bullets: [
        "Your language and appearance preferences are stored in your browser's localStorage (keys windler.lang and windler.theme), only on your device, and can be cleared in the browser at any time.",
        "The download page requests release information directly from the public GitHub API (api.github.com) from your browser; that request is covered by GitHub's privacy policy. Results are cached in sessionStorage for 10 minutes.",
        "The site is hosted on Cloudflare. As the hosting and network provider, Cloudflare may process connection logs (such as IP addresses) under its own privacy policy; this project does not read or keep those logs.",
        "The typeface (Inter) is self-hosted; nothing is requested from third parties.",
      ] },
      { heading: "2. The Windler software", paragraphs: ["All of Windler's runtime data stays on your device (the WINDLER_HOME directory): configuration, conversations, timeline, audit log, vault and the local soul directory. The author runs no server that receives any of it."], bullets: [
        "Model providers: whichever provider you configure receives the content of conversations and introspection, under that provider's privacy policy. API keys are encrypted on the device.",
        "Soul repository (optional): personality and memory sync to a private git repository you choose, held by your git host.",
        "Feishu (optional): once connected, messages pass through the Feishu platform under Feishu's privacy policy.",
        "Device capabilities: camera, microphone, location and screen control ask every time by default; captured content is used on the device only, according to your permission settings.",
        "Secret passing: passwords and tokens handed to the agent through pass_secret are stored only in the local vault and never enter the conversation or the model context.",
      ] },
      { heading: "3. Minors", paragraphs: ["This website and software are not directed at children under 16, and we do not knowingly collect their information."], bullets: [] },
      { heading: "4. Changes", paragraphs: ["Updates to this policy take effect when published on this page, with the date shown at the top."], bullets: [] },
      { heading: "5. Contact", paragraphs: ["Privacy questions go through GitHub Issues."], bullets: [] },
    ],
  },
});
