import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "安全与信任",
    doc: {
      title: "安全与信任",
      lead: "信任不靠承诺。这一页写的是你可以自己验证的事：谁能改他，数据在哪里，抹除之后还剩什么。",
      blocks: [
        { kind: "figure", id: "levels" },
        { kind: "h2", id: "levels", text: "权威等级" },
        { kind: "p", text: "海里的每一条都带等级，并且签名。底线在最上面，只有你的签名能改。其余三级，由模型输出产生的信号必须通过独立审查，才写得进去。" },
        {
          kind: "rail",
          cols: 3,
          head: { name: "三件可以自己验证的事", meta: "03" },
          cells: [
            { num: "01", title: "发布物签名", text: "装到你机器上的，是签过名并通过验证的那一份。" },
            { num: "02", title: "端到端加密", text: "数据在你的设备上。离开设备的只有密文。" },
            { num: "03", title: "抹除是真删", text: "抹除之后，内容不再读得出来。" },
          ],
        },
        { kind: "h2", id: "review", text: "写回要过审查" },
        { kind: "p", text: "模型的输出只是一条信号。它经过独立审查才写进海里，所以一次调用决定不了他是谁。" },
        { kind: "h2", id: "data", text: "数据在哪里" },
        { kind: "p", text: "在你的设备上，端到端加密。多设备同步经过 Hub，Hub 转发的只有密文，看不到内容。" },
        { kind: "h2", id: "erase", text: "抹除是真删" },
        { kind: "p", text: "抹除不是藏起来，也不是标记成不显示。抹除之后，这条内容不再读得出来。" },
        { kind: "h2", id: "release", text: "装到的是什么" },
        { kind: "p", text: "每个发布物都签名。安装器先验证签名，再核对内容，然后才安装。公钥与自己动手验签的命令在[发布签名与校验](/docs/reference/release-signing)。" },
        { kind: "h2", id: "failure", text: "它出故障时" },
        { kind: "p", text: "宿主照常工作。它不会因为自己的故障挡住你。" },
      ],
    },
  },
  en: {
    metaTitle: "Security and trust",
    doc: {
      title: "Security and trust",
      lead: "Trust does not rest on promises. This page lists what you can check yourself: who can change your agent, where the data is, and what remains after erasure.",
      blocks: [
        { kind: "figure", id: "levels" },
        { kind: "h2", id: "levels", text: "Authority levels" },
        { kind: "p", text: "Every item in the sea carries a level and a signature. Bottom lines are at the top and change only with your signature. For the other three levels, a signal produced by model output must pass independent review before it can be written in." },
        {
          kind: "rail",
          cols: 3,
          head: { name: "Three things you can check yourself", meta: "03" },
          cells: [
            { num: "01", title: "Signed releases", text: "What lands on your machine is the copy that was signed and verified." },
            { num: "02", title: "End-to-end encryption", text: "The data is on your devices. Only ciphertext leaves them." },
            { num: "03", title: "Erasure is real", text: "After erasure, the content cannot be read again." },
          ],
        },
        { kind: "h2", id: "review", text: "Writing back requires review" },
        { kind: "p", text: "The model's output is only a signal. It is written into the sea after independent review, so no single call decides who your agent is." },
        { kind: "h2", id: "data", text: "Where the data is" },
        { kind: "p", text: "On your devices, end-to-end encrypted. Syncing between devices goes through a Hub; the Hub relays only ciphertext and cannot see the content." },
        { kind: "h2", id: "erase", text: "Erasure is real" },
        { kind: "p", text: "Erasing is not hiding, and not marking something as not shown. After erasure, the content cannot be read again." },
        { kind: "h2", id: "release", text: "What gets installed" },
        { kind: "p", text: "Every release is signed. The installer verifies the signature, checks the contents, and only then installs. The public key and the commands to verify by hand are in [Release signing](/docs/reference/release-signing)." },
        { kind: "h2", id: "failure", text: "When it fails" },
        { kind: "p", text: "Your host keeps working as usual. Its own failure never stands in your way." },
      ],
    },
  },
};
