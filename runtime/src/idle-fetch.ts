// 按「无进展」计时的 HTTP 请求：idleMs 内没有收到任何东西（响应头，或响应体的下一块）才放弃；还在下载的不会被砍掉。
// 返回响应（状态与头）和完整的响应体。
export async function fetchIdle(url: string, init: RequestInit & { signal?: never }, idleMs: number): Promise<{ res: Response; body: Buffer }> {
  const ac = new AbortController();
  let t = setTimeout(() => ac.abort(new Error(`${Math.round(idleMs / 1000)} 秒没有收到任何数据`)), idleMs);
  const arm = () => { clearTimeout(t); t = setTimeout(() => ac.abort(new Error(`${Math.round(idleMs / 1000)} 秒没有收到任何数据`)), idleMs); };
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    arm();
    const parts: Buffer[] = [];
    const reader = res.body?.getReader();
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); parts.push(Buffer.from(value));
    }
    return { res, body: Buffer.concat(parts) };
  } finally { clearTimeout(t); }
}
