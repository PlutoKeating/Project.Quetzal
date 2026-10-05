import { defineMessages } from "~/i18n/core";

export const messages = defineMessages({
  zh: {
    heading: "控制台登录",
    lead: "Quetzal App（安卓与 Linux 桌面）的「账户」页经各自的身体管理这个账户。每一次登录都由你在「批准设备」里批准过；不再使用的设备在这里吊销，立即失效。",
    empty: "还没有控制台登录。在 App 里打开「控制 → 账户」并登录，批准后会出现在这里。",
    from: "来自身体",
    since: "登录于",
    used: "最近使用",
    current: "正在使用",
    revoke: "吊销",
  },
  en: {
    heading: "Console sign-ins",
    lead: "The Account page of the Quetzal app (Android and Linux desktop) manages this account through its body. You approved each sign-in under Approve a device; revoke the ones you no longer use here, effective immediately.",
    empty: "No console sign-ins yet. Open Control → Account in the app and sign in; once approved it shows up here.",
    from: "From body",
    since: "Signed in",
    used: "Last used",
    current: "In use",
    revoke: "Revoke",
  },
});
