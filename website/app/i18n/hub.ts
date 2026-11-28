import type { Lang } from "./core";

// 全站唯一一处提到官方 Hub 的句子。官方 Hub 的上线情况确定后，只改这里。
// 多设备页与自建 Hub 页都渲染这一句，别处不再重复。
export const officialHubNote: Record<Lang, string> = {
  zh: "Hub 可以自建，部署包就在仓库里。官方 Hub 的开放情况另行说明。",
  en: "You can run your own Hub; the deployment bundle is in the repository. The availability of an official Hub is announced separately.",
};
