// 极小的原生 DOM 构造器：只创建元素、文本节点与属性，不使用 innerHTML，不写内联样式属性，
// 因而在 `script-src 'self'; style-src 'self'` 的严格 CSP 下直接可用。

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
      if (typeof value === "boolean") {
        // aria-* 的布尔值要写成 "true" / "false"：缺失与 "false" 语义不同（如 aria-pressed、aria-expanded）。
        if (name.startsWith("aria-")) element.setAttribute(name, String(value));
        else if (value) element.setAttribute(name, "");
        continue;
      }
      element.setAttribute(name, String(value));
    }
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

/** 把若干类名拼成一个 class 值，跳过不成立的项。 */
export function cls(...names: Array<string | false | null | undefined>): string {
  return names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");
}

/**
 * 用新内容替换容器的全部子节点，并把键盘焦点还给带同一个 `data-focus-key` 的新节点。
 * 界面的每一次就地更新都经过这里，键盘用户不会因为重绘丢掉位置。
 */
export function redraw(container: HTMLElement, children: readonly Child[]): void {
  const active = container.ownerDocument.activeElement;
  const key =
    active instanceof HTMLElement && container.contains(active)
      ? (active.dataset["focusKey"] ?? null)
      : null;
  container.replaceChildren();
  append(container, children);
  if (key !== null) byData(container, "focus-key", key)?.focus();
  applyRoving(container);
}

const ROVING = "[data-roving]";
const PICK = ".qz-pick";

/**
 * 一组可选的条目只占一个 Tab 停靠点：停在当前选中的那一条上（没有选中就是第一条），
 * 组内用方向键走。几十条往事不需要按几十次 Tab 才能走到右边的动作。
 */
export function applyRoving(root: ParentNode): void {
  const active = document.activeElement;
  for (const group of root.querySelectorAll<HTMLElement>(ROVING)) {
    const picks = Array.from(group.querySelectorAll<HTMLElement>(PICK));
    const stop =
      picks.find((pick) => pick === active) ??
      picks.find((pick) => pick.getAttribute("aria-current") === "true") ??
      picks[0];
    for (const pick of picks) pick.tabIndex = pick === stop ? 0 : -1;
  }
}

/** 组内的方向键：上下移动，Home / End 到两头。挂在正文容器上，一处处理所有的组。 */
export function onRovingKey(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(PICK)) return;
  const group = target.closest<HTMLElement>(ROVING);
  if (!group) return;
  const picks = Array.from(group.querySelectorAll<HTMLElement>(PICK));
  const index = picks.indexOf(target);
  let next: HTMLElement | undefined;
  if (event.key === "ArrowDown") next = picks[index + 1];
  else if (event.key === "ArrowUp") next = picks[index - 1];
  else if (event.key === "Home") next = picks[0];
  else if (event.key === "End") next = picks[picks.length - 1];
  else return;
  event.preventDefault();
  if (!next || next === target) return;
  for (const pick of picks) pick.tabIndex = pick === next ? 0 : -1;
  next.focus();
}

/**
 * 按 `data-*` 的值找一个元素。条目的 id 来自守护进程，可能含有选择器里的特殊字符，
 * 所以逐个比较属性值，而不是把 id 拼进选择器。
 */
export function byData(root: ParentNode, name: string, value: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(`[data-${name}]`)) {
    if (element.getAttribute(`data-${name}`) === value) return element;
  }
  return null;
}

let idSequence = 0;

/**
 * 一个页面内唯一的元素 id，给 `for`、`aria-labelledby`、`aria-controls` 这些引用用。
 * 不把守护进程给的条目 id 拼进元素 id：引用列表按空白分隔，外来的值可能把它弄断。
 */
export function uniqueId(prefix: string): string {
  idSequence += 1;
  return `sea-${prefix}-${idSequence}`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 跳转箭头：设计系统规定的线形图标，随文字颜色，RTL 下翻转。 */
export function arrowIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "qz-dir-arrow");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M3 8h10M9 4l4 4-4 4");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/** 搜索图标：`.qz-input` 的前置图标。 */
export function searchIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "7");
  circle.setAttribute("cy", "7");
  circle.setAttribute("r", "4.5");
  circle.setAttribute("stroke", "currentColor");
  circle.setAttribute("stroke-width", "1.3");
  const handle = document.createElementNS(SVG_NS, "path");
  handle.setAttribute("d", "M10.5 10.5L14 14");
  handle.setAttribute("stroke", "currentColor");
  handle.setAttribute("stroke-width", "1.3");
  handle.setAttribute("stroke-linecap", "round");
  svg.append(circle, handle);
  return svg;
}
