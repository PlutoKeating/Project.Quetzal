import { GITHUB_URL } from "~/i18n/core";
import { officialHubNote } from "~/i18n/hub";
import type { Messages } from "~/lib/content";

const BUNDLE = `${GITHUB_URL}/tree/main/hub/deploy`;

export const messages: Messages = {
  zh: {
    metaTitle: "自建 Hub",
    doc: {
      title: "自建 Hub",
      lead: "Hub 只做一件事：在你的设备之间转发密文。它看不到内容，所以放在哪台机器上，都不改变谁能读你的数据。",
      blocks: [
        { kind: "p", text: officialHubNote.zh },
        { kind: "h2", id: "bundle", step: 1, text: "取得部署包" },
        { kind: "p", text: `部署包在仓库的 [hub/deploy](${BUNDLE}) 目录里：容器编排、不用容器时的服务单元，以及每一项设置的说明。` },
        { kind: "h2", id: "machine", step: 2, text: "准备一台有公网地址的机器" },
        { kind: "p", text: "给它一个域名。设备要够得着它的两个入口：" },
        {
          kind: "table",
          head: ["入口", "用途", "要求"],
          rows: [
            ["443 / TCP", "登录、密文同步与转发", "可以放在隧道或反向代理后面"],
            ["7842 / UDP", "帮设备找到彼此之间直连的路", "必须直连公网；不开也能同步，只是全部经 Hub 转发"],
          ],
        },
        { kind: "h2", id: "check", step: 3, text: "启动并自检" },
        { kind: "p", text: "按部署包里的说明，填好设备访问它用的地址，然后启动。三种入口方式的差别也写在那里。启动后确认它在线：" },
        { kind: "cmd", label: "把地址换成你的 Hub：", head: "Terminal", text: "curl -fsS https://hub.example.com/healthz" },
        { kind: "h2", id: "use", step: 4, text: "让设备用它" },
        { kind: "cmd", head: "Terminal", text: "qz login --hub https://hub.example.com" },
        { kind: "p", text: "每台设备都登录到它，然后按[多设备](/docs/guide/devices)配对。" },
        { kind: "h2", id: "license", text: "许可证" },
        { kind: "p", text: "Hub 的许可证是 AGPL-3.0-only。其余部分是 Apache-2.0。" },
      ],
    },
  },
  en: {
    metaTitle: "Self-host a Hub",
    doc: {
      title: "Self-host a Hub",
      lead: "A Hub does one thing: it relays ciphertext between your devices. It cannot see the content, so where it runs does not change who can read your data.",
      blocks: [
        { kind: "p", text: officialHubNote.en },
        { kind: "h2", id: "bundle", step: 1, text: "Get the deployment bundle" },
        { kind: "p", text: `The bundle is in the repository under [hub/deploy](${BUNDLE}): container orchestration, a service unit for running without containers, and a description of every setting.` },
        { kind: "h2", id: "machine", step: 2, text: "Prepare a machine with a public address" },
        { kind: "p", text: "Give it a domain name. Devices need to reach it through two entrances:" },
        {
          kind: "table",
          head: ["Entrance", "Purpose", "Requirement"],
          rows: [
            ["443 / TCP", "login, ciphertext sync and relaying", "may sit behind a tunnel or a reverse proxy"],
            ["7842 / UDP", "helps devices find a direct path to each other", "must be reachable directly; without it sync still works, entirely relayed by the Hub"],
          ],
        },
        { kind: "h2", id: "check", step: 3, text: "Start it and check" },
        { kind: "p", text: "Follow the bundle's instructions: fill in the address devices will use to reach it, then start it. The differences between the three entrance setups are described there too. Once it is running, confirm it is online:" },
        { kind: "cmd", label: "Replace the address with your Hub:", head: "Terminal", text: "curl -fsS https://hub.example.com/healthz" },
        { kind: "h2", id: "use", step: 4, text: "Point your devices at it" },
        { kind: "cmd", head: "Terminal", text: "qz login --hub https://hub.example.com" },
        { kind: "p", text: "Log every device in to it, then pair them as described in [More devices](/docs/guide/devices)." },
        { kind: "h2", id: "license", text: "License" },
        { kind: "p", text: "The Hub is licensed AGPL-3.0-only. Everything else is Apache-2.0." },
      ],
    },
  },
};
