// 极小的原生 DOM 渲染器：只做安全的文本节点与属性设置，不使用 innerHTML / eval，
// 因而在 `script-src 'self'` 的严格 CSP 下可直接运行。

export type Child = Node | string | number | null | undefined | false;

export type AttrValue = string | number | boolean | null | undefined;

export type AttrMap = Record<string, AttrValue | EventListener>;

function isListener(value: AttrValue | EventListener): value is EventListener {
  return typeof value === "function";
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: AttrMap | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (isListener(value)) {
        element.addEventListener(name.replace(/^on/u, "").toLowerCase(), value);
        continue;
      }
      if (value === null || value === undefined) continue;
      if (value === false) {
        // aria-* 的 "false" 与缺失语义不同（如 aria-pressed），必须显式写出。
        if (name.startsWith("aria-")) element.setAttribute(name, "false");
        continue;
      }
      element.setAttribute(name, value === true ? "" : String(value));
    }
  }
  appendChildren(element, children);
  return element;
}

export function appendChildren(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

/** 用新节点替换全部子节点；调用方负责焦点恢复。 */
export function replaceChildren(parent: Element, children: readonly Child[]): void {
  const next: Child[] = [...children];
  parent.replaceChildren();
  appendChildren(parent, next);
}
