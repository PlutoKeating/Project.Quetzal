import { defineMessages } from "~/i18n/core";

export const messages = defineMessages({
  zh: {
    title: "条款与条件 · Quetzal",
    description: "使用 Quetzal 官网与 Quetzal 软件的条款与条件。",
    eyebrow: "条款与条件",
    heading: "条款与条件",
    lead: "使用本网站（quetzal.plutokeating.beer）或下载、使用 Quetzal 软件，即表示你接受以下条款。请仔细阅读。",
    updated: "最近更新：2026 年 10 月 5 日",
    sections: [
      { heading: "1. 关于本网站与软件", paragraphs: ["本网站由 PlutoKeating 个人运营，用于介绍开源项目 Quetzal 并提供文档与下载入口。Quetzal 软件（运行基座、Quetzal App、灵魂桥等）以 GNU Affero General Public License v3.0（AGPL-3.0）许可发布，许可证全文随源代码一同提供。"], bullets: [] },
      { heading: "2. 许可", paragraphs: ["你对 Quetzal 软件的复制、修改、分发与网络使用均受 AGPL-3.0 约束。本网站的文字内容在未另行注明时同样以 AGPL-3.0 随仓库发布；第三方商标与名称归各自所有者所有。"], bullets: [] },
      { heading: "3. 无担保", paragraphs: ["软件与本网站按「现状」提供，不提供任何明示或默示的担保，包括但不限于适销性、特定用途适用性与不侵权。Quetzal 会在你的设备上自主运行、调用你所配置的模型供应商并产生费用；你应自行设置预算、授权与审批，并自行承担由此产生的费用与后果。"], bullets: [] },
      { heading: "4. 责任限制", paragraphs: ["在法律允许的最大范围内，作者不对因使用或无法使用软件或本网站而产生的任何直接、间接、附带、特殊或后果性损害承担责任，包括数据丢失、设备损坏、费用支出或业务中断。"], bullets: [] },
      { heading: "5. 可接受的使用", paragraphs: ["本项目仅用于学习和研究。你只能在自己拥有或获得授权的设备上安装与运行 Quetzal，不得将其用于破坏、入侵他人计算机系统，或用于任何违法用途。"], bullets: [] },
      { heading: "6. 第三方服务", paragraphs: ["安装与使用过程中会涉及第三方：GitHub（源代码与发布）、你自行选择的模型供应商、飞书（可选）、你的 git 托管商（灵魂仓库）、你选择使用的同步服务（可选）。这些服务各有其条款与隐私政策，与本项目无关。"], bullets: [] },
      { heading: "7. 同步服务", paragraphs: ["本项目运营的同步服务对所有人开放、免费，按「现状」尽力提供，不承诺可用性，可能随时调整或停止。为防止滥用，服务会限制请求频率、每个账户的 agent 与身体数量及中转用量，并可能停用滥用的账户。服务不可用时，你的身体仍照常运行，记忆仍经灵魂仓库同步；你也可以用源代码里的 sync/ 自己部署。"], bullets: [] },
      { heading: "8. 变更", paragraphs: ["本条款可能随项目演进而更新，更新后的版本在本页发布即生效，页首标注最近更新日期。"], bullets: [] },
      { heading: "9. 联系", paragraphs: ["关于本条款的问题请通过 GitHub Issues 提出。"], bullets: [] },
    ],
  },
  en: {
    title: "Terms & Conditions · Quetzal",
    description: "Terms and conditions for using the Quetzal website and the Quetzal software.",
    eyebrow: "Terms & Conditions",
    heading: "Terms & Conditions",
    lead: "By using this website (quetzal.plutokeating.beer) or downloading and using the Quetzal software, you accept the following terms. Please read them carefully.",
    updated: "Last updated: October 5, 2026",
    sections: [
      { heading: "1. About the site and the software", paragraphs: ["This website is operated by PlutoKeating as an individual to present the open-source project Quetzal and to provide documentation and downloads. The Quetzal software (runtime, Quetzal app, soul-bridge and others) is released under the GNU Affero General Public License v3.0 (AGPL-3.0); the full license ships with the source code."], bullets: [] },
      { heading: "2. License", paragraphs: ["Copying, modifying, distributing and network use of the Quetzal software are governed by AGPL-3.0. Unless stated otherwise, the text of this website is published with the repository under the same license. Third-party trademarks and names belong to their respective owners."], bullets: [] },
      { heading: "3. No warranty", paragraphs: ["The software and this website are provided \"as is\", without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose and non-infringement. Quetzal runs autonomously on your device and calls the model providers you configure, which incurs cost; you are responsible for setting budgets, permissions and approvals, and for all resulting charges and consequences."], bullets: [] },
      { heading: "4. Limitation of liability", paragraphs: ["To the fullest extent permitted by law, the author is not liable for any direct, indirect, incidental, special or consequential damages arising from the use of or inability to use the software or this website, including loss of data, damage to devices, expenses or business interruption."], bullets: [] },
      { heading: "5. Acceptable use", paragraphs: ["This project exists for learning and research only. You may install and run Quetzal only on devices you own or are authorized to use. You may not use it to damage or break into other people's computer systems, or for any unlawful purpose."], bullets: [] },
      { heading: "6. Third-party services", paragraphs: ["Installation and use involve third parties: GitHub (source code and releases), the model providers you choose, Feishu (optional), your git host (soul repository) and the sync service you choose to use (optional). Each has its own terms and privacy policy, independent of this project."], bullets: [] },
      { heading: "7. Sync service", paragraphs: ["The sync service operated by this project is open to everyone and free, provided \"as is\" on a best-effort basis with no availability commitment, and may be changed or discontinued at any time. To prevent abuse it limits request rates, the number of agents and bodies per account and relay usage, and may disable abusive accounts. When it is unavailable your bodies keep running and memory still syncs through the soul repository; you can also host your own from sync/ in the source code."], bullets: [] },
      { heading: "8. Changes", paragraphs: ["These terms may be updated as the project evolves. The updated version takes effect when published on this page, with the date shown at the top."], bullets: [] },
      { heading: "9. Contact", paragraphs: ["Questions about these terms go through GitHub Issues."], bullets: [] },
    ],
  },
});
