import type { Lang } from "./core";

// 全站唯一一处提到官方 Hub 的句子。官方 Hub 的上线情况确定后，只改这里。
// 多设备页与自建 Hub 页都渲染这一句，别处不再重复。
export const officialHubNote: Record<Lang, string> = {
  zh: "默认用官方 Hub：它只保管和转发密文，看不到内容。也可以自建，部署包就在仓库里。",
  en: "The official Hub is used by default: it only stores and forwards ciphertext and cannot read it. You can also run your own; the deployment bundle is in the repository.",
};
