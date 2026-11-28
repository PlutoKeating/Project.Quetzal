// jsdom 没有实现的几样浏览器能力。产品代码直接调用标准接口，缺口只在测试环境里补。

if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("[autofocus]")?.focus();
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, returnValue?: string): void {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
}

Element.prototype.scrollIntoView = function scrollIntoView(): void {};
window.scrollTo = (): void => {};
