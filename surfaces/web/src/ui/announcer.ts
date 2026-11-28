// 读屏播报：写操作成功走礼貌通道，失败与连接状态变化走断言通道。
// 界面上不弹提示条；看得见的反馈是条目的就地更新和出处栏新增的一行。
import { h } from "./dom.js";

export class Announcer {
  readonly polite: HTMLElement;
  readonly assertive: HTMLElement;

  constructor() {
    this.polite = h("div", {
      class: "qz-sr-only",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      "data-live": "polite",
    });
    this.assertive = h("div", {
      class: "qz-sr-only",
      role: "alert",
      "aria-live": "assertive",
      "aria-atomic": "true",
      "data-live": "assertive",
    });
  }

  say(message: string): void {
    this.#write(this.polite, message);
  }

  alert(message: string): void {
    this.#write(this.assertive, message);
  }

  #write(region: HTMLElement, message: string): void {
    // 换一个新的文本节点，连续两次相同的内容也会被再读一遍。
    region.replaceChildren(document.createTextNode(message));
  }
}
