// 她的声音从哪里出来：有耳朵（控制台 App 的麦克风服务在跑）时交给 App 播放，否则交给身体适配器（Termux 的媒体播放器）。
//   让 App 播放的原因：回声消除。App 用通话音频路径播放（USAGE_VOICE_COMMUNICATION），采集用 VOICE_COMMUNICATION 音源并挂系统的
//   声学回声消除器，麦克风音轨里就减掉了扬声器正在放的她自己的声音——她说话时对方可以直接插嘴，耳朵不会把她的话当成有人说话。
//   App 还能准确知道播放何时结束（适配器播放只能按码率估时长），对方插嘴时在本地立即停播并回报。
import path from "node:path";
import fs from "node:fs";
import { adapter } from "../body/twin.ts";
import { bus } from "../bus.ts";
import { markSpeaking, stopSpeaking } from "./hearing.ts";
import { paths } from "../config.ts";

let registered = 0; // App 登记的播放器（最近一次登记的时刻；0 为没有）
const pending = new Map<string, { resolve: (r: { interrupted: boolean }) => void; timer: NodeJS.Timeout }>();
const bargeIns = new Set<string>(); // 插嘴打断了播放的那些句子（耳朵送来的 id）

/** 控制台 App 的耳朵开着时登记为播放器；关掉时注销。 */
export function setPlayer(enabled: boolean) { registered = enabled ? Date.now() : 0; }
export const hasPlayer = () => registered > 0;

/** 播放一段合成语音；返回是否被对方插嘴打断。 */
export async function play(file: string, text = ""): Promise<{ interrupted: boolean; by: "app" | "adapter" | "none" }> {
  const ms = markSpeaking(file, text);
  if (hasPlayer()) {
    const id = path.basename(file);
    const r = await new Promise<{ interrupted: boolean }>((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ interrupted: false }); }, ms + 8000); // App 没回报就按估计时长算播完
      pending.set(id, { resolve, timer });
      bus.emit("speak", { id, url: `/media/${encodeURIComponent(id)}`, text, ms });
    });
    await stopSpeaking(false); // 说话窗口结束（不必让适配器停播：声音不是它放的）
    return { ...r, by: "app" };
  }
  if (!adapter.playAudio) { await stopSpeaking(false); return { interrupted: false, by: "none" }; }
  await adapter.playAudio(file);
  return { interrupted: false, by: "adapter" };
}

/** App 回报播放结束；utterance 为打断播放的那句话（耳朵送来的 id），之后那句话以「打断」并入。 */
export function done(id: string, interrupted = false, utterance?: string) {
  const p = pending.get(id);
  if (p) { clearTimeout(p.timer); pending.delete(id); p.resolve({ interrupted }); }
  if (interrupted && utterance) { bargeIns.add(utterance); setTimeout(() => bargeIns.delete(utterance), 120_000).unref(); }
  if (interrupted) void stopSpeaking(false);
  return !!p;
}
export const isBargeIn = (utterance: string) => bargeIns.delete(utterance);

/** 网关 GET /media/<文件名>：只给 data/media 里的音频文件。 */
export function mediaFile(name: string): string | undefined {
  const base = path.basename(name);
  if (base !== name || !/\.(mp3|wav|ogg|webm)$/i.test(base)) return undefined;
  const f = path.join(paths.data, "media", base);
  return fs.existsSync(f) ? f : undefined;
}
