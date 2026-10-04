// 健康检查：轮询运行基座的 /health（无需令牌）。
export interface Health { ok: boolean; version: string; safeMode: boolean; mode: string }

export async function health(port: number): Promise<Health | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? (await r.json()) as Health : undefined;
  } catch { return undefined; }
}

/** 等到 /health 返回且版本为 version（防止读到旧进程）；超时返回空。 */
export async function waitHealthy(port: number, version: string, seconds = 40): Promise<Health | undefined> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const h = await health(port);
    if (h?.ok && h.version === version) return h;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
}
