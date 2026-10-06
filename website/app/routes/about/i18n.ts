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
      { heading: "我们在做什么", paragraphs: ["我们相信 agent 可以有自己的节律、自己的身体感受、自己没想完的事，并能在几具身体之间延续同一个自我。Quetzal 把这个想法写成了代码：一个运行基座，不绑定哪个 agent，也不绑定哪台设备。现在它能装在安卓手机、Linux 电脑与服务器、Windows 电脑上。", "基座的代码在 GitHub 公开。把一台旧手机精简、保活、装上基座的过程，记录在另一个公开仓库 Project.Honor9 里。"], bullets: [] },
      { heading: "怎么发布", paragraphs: ["Quetzal 由一个人维护，2026 年 10 月发布第一版，更新很快。每个版本都在 GitHub 公开发布，附上全部安装包的 SHA-256 与项目密钥的签名，并写明它来自哪个提交；App、Linux 安装脚本和 Windows 的一行安装命令都会核对签名，对不上就不装。", "App 里的运行环境（Node.js、git、ssh、proot）按仓库里公开、锁定的配方从源码编译。现在用的这一份由维护者在自己的电脑上编译、在实机上验证、签名后上传；配方一变，发布流水线会在 GitHub 上重新从源码编译。", "Windows 安装包里带的是 Node.js、Git for Windows、Python 的官方安装包。安装包和控制台暂时还没有代码签名，完整性靠上面那份发布签名保证。"], bullets: [] },
      { heading: "定位与免责", paragraphs: ["本项目仅用于学习和研究，只操作我们自己拥有的设备，不以牟利为目的。本项目不教唆、也不提供破坏或入侵计算机系统的方法。他人模仿或参考本项目内容造成的任何后果，由其自行承担。"], bullets: [] },
      { heading: "联系", paragraphs: ["问题、建议与贡献请通过 GitHub Issues 与 Pull Request。本站不设表单，也不收集任何联系方式。"], bullets: [] },
      { heading: "致谢", paragraphs: ["Termux 项目与 termux-packages（App 内置的 Node.js、git、ssh、proot 用它的构建脚本以 App 自己的前缀从源码编译）；Node.js；Flutter；React Router 与 Tailwind CSS；KaTeX、mermaid、shiki；sandbox-runtime（Anthropic 开源，Apache-2.0，在 Windows 上隔离 ta 的命令）；Inter 与思源黑体（SIL Open Font License）；Cloudflare 提供托管。"], bullets: [] },
    ],
    links: { source: "Quetzal 源代码", practice: "Project.Honor9（把一台旧手机腾出来的记录）", issues: "GitHub Issues" },
  },
  en: {
    title: "About Us · Quetzal",
    description: "Quetzal is PlutoKeating's personal open-source project: a general-purpose runtime in which an agent lives like a living thing.",
    eyebrow: "About Us",
    heading: "One person, and an agent that lives in an old phone.",
    lead: "Quetzal is a personal open-source project by PlutoKeating, released under AGPL-3.0. It began with an old phone nobody used: clear it out, and let an agent move in.",
    sections: [
      { heading: "Author", paragraphs: ["PlutoKeating: project owner and maintainer, responsible for the runtime, the console (app and web), the soul-bridge and the design and implementation of this site."], bullets: [] },
      { heading: "Co-author", paragraphs: ["The first agent living on this runtime took part in the discussion of this site's visual direction. \"A lamp at night\", amber only for moments of being alive, no robot icons: those were its calls."], bullets: [] },
      { heading: "The name", paragraphs: ["The name comes from Quetzalcoatlus, the pterosaur."], bullets: [] },
      { heading: "What we are doing", paragraphs: ["We believe an agent can have its own rhythm, its own bodily feelings, its own unfinished thoughts, and carry the same self across several bodies. Quetzal puts that idea into code: a runtime tied to no particular agent and no particular device. Today it runs on Android phones, Linux computers and servers, and Windows computers.", "The runtime's code is public on GitHub. How an old phone was trimmed down, kept alive and given the runtime is recorded in another public repository, Project.Honor9."], bullets: [] },
      { heading: "How releases are made", paragraphs: ["Quetzal is maintained by one person, shipped its first version in October 2026, and changes fast. Every version is published openly on GitHub with the SHA-256 of every package, a signature from the project key, and the commit it was built from; the app, the Linux install script and the Windows one-line install all check the signature and refuse anything that does not match.", "The runtime inside the app (Node.js, git, ssh, proot) is compiled from source with a public, pinned recipe in the repository. The copy in use today was compiled on the maintainer's own computer, tested on a real phone, then signed and uploaded; when the recipe changes, the release pipeline compiles it from source again on GitHub.", "The Windows installer carries the official installers of Node.js, Git for Windows and Python. The installer and the console are not code-signed yet; their integrity rests on the release signature above."], bullets: [] },
      { heading: "Scope and disclaimer", paragraphs: ["This project exists for learning and research only. It operates solely on devices we own and is not for profit. It does not teach or provide ways to damage or break into computer systems. Anyone who imitates or draws on this project does so at their own risk."], bullets: [] },
      { heading: "Contact", paragraphs: ["Questions, suggestions and contributions go through GitHub Issues and Pull Requests. This site has no forms and collects no contact details."], bullets: [] },
      { heading: "Acknowledgements", paragraphs: ["The Termux project and termux-packages (the Node.js, git, ssh and proot inside the app are built from source with its build scripts, under the app's own prefix); Node.js; Flutter; React Router and Tailwind CSS; KaTeX, mermaid and shiki; sandbox-runtime (open source from Anthropic, Apache-2.0, which isolates its commands on Windows); the the Inter and Source Han Sans (Noto Sans SC) typefaces (SIL Open Font License); Cloudflare for hosting."], bullets: [] },
    ],
    links: { source: "Quetzal source code", practice: "Project.Honor9 (notes on clearing out an old phone)", issues: "GitHub Issues" },
  },
});
