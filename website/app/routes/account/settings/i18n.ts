import { defineMessages } from "~/i18n/core";

export const messages = defineMessages({
  zh: {
    heading: "账户设置",
    profileHeading: "GitHub 账户",
    profile: "这个账户用 GitHub 登录。Quetzal 只保存你的 GitHub 数字编号、用户名与显示名，不保存 GitHub 的访问令牌。",
    logoutHeading: "退出登录",
    logout: "在这个浏览器上退出",
    logoutDone: "已退出。",
    deleteHeading: "删除账户",
    deleteText: "删除后，账户、所有 agent 与身体的登记、控制台登录立即删除，所有身体随即断开。灵魂仓库与各身体上的数据不受影响；以后可以重新登录、重新绑定。",
    deleteConfirm: "我明白，删除我的账户",
    delete: "删除账户",
    deleted: "账户已删除。",
  },
  en: {
    heading: "Settings",
    profileHeading: "GitHub account",
    profile: "This account signs in with GitHub. Quetzal keeps only your numeric GitHub id, username and display name, never a GitHub access token.",
    logoutHeading: "Sign out",
    logout: "Sign out of this browser",
    logoutDone: "Signed out.",
    deleteHeading: "Delete account",
    deleteText: "Deleting removes the account, every agent and body registration and every console sign-in at once, and all bodies disconnect. The soul repository and data on the bodies are not affected; you can sign in and bind again later.",
    deleteConfirm: "I understand, delete my account",
    delete: "Delete account",
    deleted: "The account has been deleted.",
  },
});
