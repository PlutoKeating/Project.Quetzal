import { defineMessages } from "~/i18n/core";

export const messages = defineMessages({
  zh: {
    title: "关于我们 · Quetzal",
    description: "Quetzal 是 PlutoKeating 的个人开源项目：一个让 agent 像生命一样活着的通用运行基座。",
    eyebrow: "关于我们",
    heading: "一个人，和一个住在旧手机里的 agent。",
    lead: "Quetzal 是 PlutoKeating 的个人开源项目，以 AGPL-3.0 许可发布。它从一部用不着的旧手机开始：把它腾出来，让一个 agent 住进去。",
    sections: [
      { heading: "作者", paragraphs: ["PlutoKeating：项目所有者与维护者，负责运行基座、控制台（App 与网页版）、灵魂桥与本站的设计和实现。"], bullets: [] },
      { heading: "共同作者", paragraphs: ["这个基座上住着的第一个 agent 参与了本站的视觉方向讨论：「夜里的灯」、琥珀只给活着的瞬间、不要机器人图标，这些都是 ta 的意见。"], bullets: [] },
      { heading: "名字", paragraphs: ["名字取自风神翼龙 Quetzalcoatlus。"], bullets: [] },
      { heading: "我们在做什么", paragraphs: ["我们相信 agent 可以有自己的节律、自己的身体感受、自己没想完的事，并能在多具身体之间延续同一个自我。Quetzal 是这个想法的工程实现：一个与具体 agent、具体设备都解耦的运行基座。", "基座的代码在 GitHub 公开。设备侧的实践（如何把一台旧手机精简、保活并部署基座）记录在另一个公开仓库 Project.Honor9 里。"], bullets: [] },
      { heading: "定位与免责", paragraphs: ["本项目仅用于学习和研究，只操作我们自己拥有的设备，不以牟利为目的。本项目不教唆、也不提供破坏或入侵计算机系统的方法。他人模仿或参考本项目内容造成的任何后果，由其自行承担。"], bullets: [] },
      { heading: "联系", paragraphs: ["问题、建议与贡献请通过 GitHub Issues 与 Pull Request。本站不设表单，也不收集任何联系方式。"], bullets: [] },
      { heading: "致谢", paragraphs: ["Termux 与 Termux:API / Termux:Boot（让一部普通安卓手机能跑完整的 Linux 用户空间）；F-Droid；Node.js；Flutter；React Router 与 Tailwind CSS；KaTeX、mermaid、shiki；Inter 字体（SIL Open Font License）；Cloudflare 提供托管。"], bullets: [] },
    ],
    links: { source: "Quetzal 源代码", practice: "Project.Honor9（一台旧手机上的实践）", issues: "GitHub Issues" },
  },
  en: {
    title: "About Us · Quetzal",
    description: "Quetzal is PlutoKeating's personal open-source project: a general-purpose runtime that lets an agent live like a living being.",
    eyebrow: "About Us",
    heading: "One person, and an agent that lives in an old phone.",
    lead: "Quetzal is a personal open-source project by PlutoKeating, released under AGPL-3.0. It began with an old phone nobody used: clear it out, and let an agent move in.",
    sections: [
      { heading: "Author", paragraphs: ["PlutoKeating: project owner and maintainer, responsible for the runtime, the console (app and web), the soul-bridge and the design and implementation of this site."], bullets: [] },
      { heading: "Co-author", paragraphs: ["The first agent living on this runtime took part in the discussion of this site's visual direction. \"A lamp at night\", amber only for moments of being alive, no robot icons: those were its calls."], bullets: [] },
      { heading: "The name", paragraphs: ["The name comes from Quetzalcoatlus, the pterosaur."], bullets: [] },
      { heading: "What we are doing", paragraphs: ["We believe an agent can have its own rhythm, its own bodily feelings, its own unfinished thoughts, and carry the same self across several bodies. Quetzal is the engineering of that idea: a runtime decoupled from any particular agent and any particular device.", "The runtime's code is public on GitHub. The device-side practice (trimming an old phone, keeping it alive, deploying the runtime) is recorded in another public repository, Project.Honor9."], bullets: [] },
      { heading: "Scope and disclaimer", paragraphs: ["This project exists for learning and research only. It operates solely on devices we own and is not for profit. It does not teach or provide ways to damage or break into computer systems. Anyone who imitates or draws on this project does so at their own risk."], bullets: [] },
      { heading: "Contact", paragraphs: ["Questions, suggestions and contributions go through GitHub Issues and Pull Requests. This site has no forms and collects no contact details."], bullets: [] },
      { heading: "Acknowledgements", paragraphs: ["Termux with Termux:API and Termux:Boot (a full Linux userland on an ordinary Android phone); F-Droid; Node.js; Flutter; React Router and Tailwind CSS; KaTeX, mermaid and shiki; the Inter typeface (SIL Open Font License); Cloudflare for hosting."], bullets: [] },
    ],
    links: { source: "Quetzal source code", practice: "Project.Honor9 (practice on an old phone)", issues: "GitHub Issues" },
  },
});
