// 重复输出检测：模型偶尔陷入复读（同一段文字反复出现、越写越长，直到输出上限），流式输出时就截停。
// 判据：这一步最近 WINDOW 个字符里，不同的 GRAM 字片段占全部片段的比例低于 MIN_UNIQUE。
//   正常的文字、代码、表格几乎没有重复片段（比例 ≈ 1）；一长串相似的文件路径约 0.45；复读的过程记录约 0.16，同一个字反复约 0。
const WINDOW = 2000, GRAM = 32, MIN_UNIQUE = 0.2, EVERY = 200;

/** 截停的原因：抛给模型调用，由工具循环接住（丢掉这段输出，提醒她换个思路）。 */
export class Runaway extends Error {
  constructor() { super("输出陷入重复，已截停"); this.name = "Runaway"; }
}

/** 文本末尾是否在复读。 */
export function isRunaway(text: string): boolean {
  if (text.length < WINDOW) return false;
  const x = text.slice(-WINDOW), seen = new Set<string>();
  const total = x.length - GRAM + 1;
  for (let i = 0; i < total; i++) seen.add(x.slice(i, i + GRAM));
  return seen.size / total < MIN_UNIQUE;
}

/** 流式输出的监视器：每多 EVERY 个字符检查一次，发现复读就调用 stop。 */
export function watchRunaway(stop: () => void): (text: string) => void {
  let all = "", checked = 0, fired = false;
  return (t) => {
    all += t;
    if (fired || all.length - checked < EVERY) return;
    checked = all.length;
    if (isRunaway(all)) { fired = true; stop(); }
  };
}
