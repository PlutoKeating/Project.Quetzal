// 通道在多具身体之间（DISTRIBUTED.md C7、C10）：
//   - 飞书：只有部署者指定的那具身体持有长连接（config.channels.feishuHolder）；其他身体的主动消息转给它发出。收到的消息照常按会话归属路由（presence.ts）。
//   - 耳朵：几具身体（几部手机的 App）同时听到同一句话时只留一只——各自广播听到的话，等一小会儿收集别处同时听到的，
//     开始时刻相差 3 秒内、文字相似的算同一句；留最长的那条（一样长按身体名），每只耳朵按同一规则独立判断，只有一只会交给她。
//   - 她回话时从听到这句话的那具身体说出来（mind/bodies.ts 的 earOf，voice_speak 据此转过去）。
import type { Mesh } from "./mesh.ts";
import { config } from "../config.ts";
import { holdsFeishu, setFeishuForwarder, sayToOwner } from "../channels/feishu.ts";
import { setHearingMesh } from "../voice/hearing.ts";
import { setEar } from "../mind/bodies.ts";

const WAIT_MS = 700;      // 等别的耳朵报上来
const SAME_MS = 3000;     // 开始时刻相差这么多以内才可能是同一句
const SIMILAR = 0.6;      // 文字相似度（相邻二字重合）
const RECENT_MAX = 100;   // 记着的别处听到的话最多这么多条
const HEARD_TEXT = 2000;  // 别处听到的一句话最长（超出的截断）

const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
/** 相邻二字的 Jaccard 相似度（中文按字、英文按字母，足够判断两只耳朵听到的是不是同一句）。 */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => { const t = norm(s); const g = new Set<string>(); for (let i = 0; i < Math.max(1, t.length - 1); i++) g.add(t.slice(i, i + 2)); return g; };
  const x = grams(a), y = grams(b);
  let inter = 0; for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter || 1);
}
interface Heard { id: string; body: string; text: string; at: number }
/** 同一句话的几份里留哪一份：最长的；一样长按身体名。 */
export const winner = (all: Heard[]) => [...all].sort((p, q) => (q.text.length - p.text.length) || (p.body < q.body ? -1 : p.body > q.body ? 1 : 0))[0];

export function installChannels(mesh: Mesh): () => void {
  const recent: Heard[] = []; // 别的耳朵最近听到的（10 秒内）
  const prune = () => { const now = Date.now(); while (recent.length && now - recent[0].at > 10_000) recent.shift(); };

  setFeishuForwarder((text, title) => {
    const holder = config.channels.feishuHolder;
    return !!holder && mesh.connected().includes(holder) && mesh.emitTo(holder, "feishu.say", { text, title });
  });
  setHearingMesh({
    async dedupe(u) {
      if (!mesh.connected().length) return true;
      const mine: Heard = { ...u, body: config.body };
      mesh.broadcast("heard", mine);
      await new Promise((r) => setTimeout(r, WAIT_MS));
      prune();
      const same = recent.filter((h) => Math.abs(h.at - mine.at) <= SAME_MS && similarity(h.text, mine.text) >= SIMILAR);
      return winner([mine, ...same]).body === config.body;
    },
    heard(conv) { setEar(conv, config.body); mesh.broadcast("ear", { conv }); },
  });
  // 别处发来的：body 一律是发来的那具身体（自称的身体与来源不符就丢弃）；文字、数量、时间都有上限
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.data?.body !== undefined && e.data.body !== e.from) return;
    if (e.name === "heard" && typeof e.data?.text === "string") {
      const at = Number(e.data.at);
      recent.push({ id: typeof e.data.id === "string" ? e.data.id.slice(0, 32) : "", body: e.from, text: e.data.text.slice(0, HEARD_TEXT), at: Number.isFinite(at) && Math.abs(at - Date.now()) < 60_000 ? at : Date.now() });
      if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
      prune();
    }
    else if (e.name === "ear" && typeof e.data?.conv === "string" && e.data.conv && e.data.conv.length <= 200) setEar(e.data.conv, e.from);
    else if (e.name === "feishu.say" && typeof e.data?.text === "string" && e.data.text.length <= 20_000 && holdsFeishu()) sayToOwner(e.data.text, typeof e.data.title === "string" ? e.data.title.slice(0, 60) : undefined);
  };
  mesh.on("event", onEvent);
  return () => { mesh.off("event", onEvent); setFeishuForwarder(undefined); setHearingMesh(undefined); };
}
