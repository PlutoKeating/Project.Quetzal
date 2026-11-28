import { describe, expect, it, vi } from "vitest";
import { DaemonUnreachable, SeaClient, SeaError } from "../src/api/client.js";
import { SEA_READ_METHODS, SEA_WRITE_METHODS } from "../src/api/types.js";
import { FakeApi, fullFixture, NOW, PASSPHRASE } from "./fake_api.js";

const ORIGIN = "http://127.0.0.1:4317";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 一个按脚本应答的 fetch：握手永远成功，`/rpc` 由 `reply` 决定。 */
function scripted(reply: (body: { method: string; params?: unknown }, attempt: number) => Response) {
  const requests: Recorded[] = [];
  let handshakes = 0;
  let attempt = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    if (url === `${ORIGIN}/auth/local`) {
      handshakes += 1;
      return Response.json({ token: `token-${handshakes}`, expires_in_secs: 43_200 });
    }
    attempt += 1;
    return reply(body as { method: string; params?: unknown }, attempt);
  });
  return {
    fetcher: fetcher as unknown as typeof fetch,
    requests,
    rpc: () => requests.filter((request) => request.url === `${ORIGIN}/rpc`),
    handshakes: () => handshakes,
  };
}

function ok(method: string, data: unknown): Response {
  return Response.json({ kind: method, data });
}

interface Step {
  method: string;
  params?: unknown;
  /** 客户端怎么调。 */
  call(client: SeaClient): Promise<unknown>;
  /** 替身守护进程给出的、合乎契约的答复。 */
  reply(api: FakeApi): Promise<unknown>;
}

const DIRECTIVES = [{ title: "短题", text: "短句" }];

const PLAN: Step[] = [
  { method: "sea_overview", call: (client) => client.overview(), reply: (api) => api.overview() },
  { method: "sea_self", call: (client) => client.self(), reply: (api) => api.self() },
  { method: "sea_user", call: (client) => client.user(), reply: (api) => api.user() },
  { method: "sea_us", call: (client) => client.us(), reply: (api) => api.us() },
  {
    method: "sea_memories",
    params: { query: "接口", state: "muted", cursor: "50", limit: 50 },
    call: (client) => client.memories({ query: "接口", state: "muted", cursor: "50", limit: 50 }),
    reply: (api) => api.memories(),
  },
  {
    method: "sea_memory",
    params: { id: "mem-1" },
    call: (client) => client.memory("mem-1"),
    reply: (api) => api.memory("mem-1"),
  },
  { method: "sea_baseline", call: (client) => client.baseline(), reply: (api) => api.baseline() },
  { method: "sea_hosts", call: (client) => client.hosts(), reply: (api) => api.hosts() },
  { method: "sea_devices", call: (client) => client.devices(), reply: (api) => api.devices() },
  {
    method: "sea_audit",
    params: { limit: 20 },
    call: (client) => client.audit({ limit: 20 }),
    reply: (api) => api.audit({ limit: 20 }),
  },
  {
    method: "sea_entry_update",
    params: { id: "mem-1", text: "新的说法" },
    call: (client) => client.entryUpdate("mem-1", "新的说法"),
    reply: (api) => api.entryUpdate("mem-1", "新的说法"),
  },
  {
    method: "sea_entry_mute",
    params: { id: "mem-1", muted: true },
    call: (client) => client.entryMute("mem-1", true),
    reply: (api) => api.entryMute("mem-1", true),
  },
  {
    method: "sea_entry_erase",
    params: { id: "mem-1" },
    call: (client) => client.entryErase("mem-1"),
    reply: (api) => api.entryErase("mem-1"),
  },
  {
    method: "sea_baseline_sign",
    params: { directives: DIRECTIVES, passphrase: PASSPHRASE },
    call: (client) => client.baselineSign(DIRECTIVES, PASSPHRASE),
    reply: (api) => api.baselineSign(DIRECTIVES, PASSPHRASE),
  },
  {
    method: "sea_focus_set",
    params: { self_weight: 0.7 },
    call: (client) => client.focusSet(0.7),
    reply: (api) => api.focusSet(0.7),
  },
  {
    method: "sea_rhythm_set",
    params: { speak_first: false, quiet_hours: [23, 8] },
    call: (client) => client.rhythmSet(false, [23, 8]),
    reply: (api) => api.rhythmSet(false, [23, 8]),
  },
  {
    method: "sea_device_revoke",
    params: { device_id: "dev-old", passphrase: PASSPHRASE },
    call: (client) => client.deviceRevoke("dev-old", PASSPHRASE),
    reply: (api) => api.deviceRevoke("dev-old", PASSPHRASE),
  },
];

describe("类型化客户端：十七个方法的请求体与答复", () => {
  it("契约恰好是十个读方法和七个写方法", () => {
    expect(SEA_READ_METHODS).toHaveLength(10);
    expect(SEA_WRITE_METHODS).toHaveLength(7);
    expect(new Set([...SEA_READ_METHODS, ...SEA_WRITE_METHODS]).size).toBe(17);
  });

  it("每个方法都发出契约里的 method 与 params，并把 data 解码成类型化的结果", async () => {
    expect(PLAN.map((step) => step.method).sort()).toEqual(
      [...SEA_READ_METHODS, ...SEA_WRITE_METHODS].sort(),
    );
    // 先用替身算好每个方法的答复，再让客户端逐个调用。
    const replies = new Map<string, unknown>();
    for (const step of PLAN) {
      replies.set(step.method, await step.reply(new FakeApi(fullFixture())));
    }
    const net = scripted((body) => ok(body.method, replies.get(body.method)));

    const client = new SeaClient({ fetcher: net.fetcher, origin: ORIGIN });
    for (const step of PLAN) {
      const result = await step.call(client);
      expect(result, step.method).toEqual(replies.get(step.method));
    }

    const sent = net.rpc();
    expect(sent).toHaveLength(17);
    sent.forEach((request, index) => {
      const step = PLAN[index];
      expect(request.method).toBe("POST");
      expect(request.headers["authorization"]).toBe("Bearer token-1");
      expect(request.headers["content-type"]).toBe("application/json");
      // 没有参数的方法不带 params 键；有参数的方法原样带上。
      expect(request.body, step?.method).toEqual(
        step?.params === undefined ? { method: step?.method } : { method: step.method, params: step.params },
      );
    });
    // 十六次调用共用一次本机握手。
    expect(net.handshakes()).toBe(1);
  });

  it("可选参数缺省时不出现在请求体里", async () => {
    const page = await new FakeApi().memories();
    const net = scripted((body) => ok(body.method, page));
    const client = new SeaClient({ fetcher: net.fetcher, origin: ORIGIN });
    await client.memories();
    await client.memories({ query: "咖啡" });
    expect(net.rpc().map((request) => request.body)).toEqual([
      { method: "sea_memories", params: {} },
      { method: "sea_memories", params: { query: "咖啡" } },
    ]);
  });

  it("握手用 POST，让浏览器带上同源的 Origin", async () => {
    const overview = await new FakeApi().overview();
    const net = scripted((body) => ok(body.method, overview));
    await new SeaClient({ fetcher: net.fetcher, origin: `${ORIGIN}/` }).overview();
    expect(net.requests[0]).toMatchObject({ url: `${ORIGIN}/auth/local`, method: "POST" });
  });
});

describe("类型化客户端：失败的三种样子", () => {
  it("答复是 kind=error 时抛出带 code 与 detail 的 SeaError", async () => {
    const net = scripted(() =>
      Response.json({ kind: "error", data: { code: "PASSPHRASE_REJECTED", detail: "口令不对。" } }),
    );
    const client = new SeaClient({ fetcher: net.fetcher, origin: ORIGIN });
    const failure = await client.deviceRevoke("dev-old", "wrong").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SeaError);
    expect(failure).toMatchObject({
      method: "sea_device_revoke",
      code: "PASSPHRASE_REJECTED",
      detail: "口令不对。",
      notReady: false,
    });
  });

  it("守护进程不认识这个方法时是「接口未就绪」，不是普通错误", async () => {
    const denied = scripted(() =>
      Response.json(
        { kind: "error", data: { code: "PERMISSION_DENIED", detail: "该方法不允许经 Web 控制台调用" } },
        { status: 403 },
      ),
    );
    const first = await new SeaClient({ fetcher: denied.fetcher, origin: ORIGIN })
      .overview()
      .catch((error: unknown) => error);
    expect(first).toBeInstanceOf(SeaError);
    expect((first as SeaError).notReady).toBe(true);

    const unknownVariant = scripted(() =>
      Response.json(
        { kind: "error", data: { code: "SERIALIZATION_ERROR", detail: "unknown variant `sea_self`" } },
        { status: 400 },
      ),
    );
    const second = await new SeaClient({ fetcher: unknownVariant.fetcher, origin: ORIGIN })
      .self()
      .catch((error: unknown) => error);
    expect((second as SeaError).notReady).toBe(true);

    // 业务上的拒绝（200 + PERMISSION_DENIED）不算「未就绪」。
    const refused = scripted(() =>
      Response.json({ kind: "error", data: { code: "PERMISSION_DENIED", detail: "没有授权" } }),
    );
    const third = await new SeaClient({ fetcher: refused.fetcher, origin: ORIGIN })
      .entryErase("mem-1")
      .catch((error: unknown) => error);
    expect((third as SeaError).notReady).toBe(false);
  });

  it("握手不通、握手被拒、请求没有回来，都是 DaemonUnreachable", async () => {
    const refused = new SeaClient({
      fetcher: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch,
      origin: ORIGIN,
    });
    await expect(refused.overview()).rejects.toBeInstanceOf(DaemonUnreachable);

    const dead = new SeaClient({
      fetcher: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      origin: ORIGIN,
    });
    await expect(dead.overview()).rejects.toBeInstanceOf(DaemonUnreachable);

    let calls = 0;
    const dropped = new SeaClient({
      fetcher: (async (input: RequestInfo | URL) => {
        calls += 1;
        if (String(input).endsWith("/auth/local")) return Response.json({ token: "t" });
        throw new TypeError("connection reset");
      }) as unknown as typeof fetch,
      origin: ORIGIN,
    });
    await expect(dropped.self()).rejects.toBeInstanceOf(DaemonUnreachable);
    expect(calls).toBe(2);

    // 不知道同源地址时不发请求。
    const nowhere = vi.fn();
    await expect(
      new SeaClient({ fetcher: nowhere as unknown as typeof fetch, origin: "" }).overview(),
    ).rejects.toBeInstanceOf(DaemonUnreachable);
    expect(nowhere).not.toHaveBeenCalled();
  });

  it("会话令牌作废（401）时重新握手并只重试一次", async () => {
    const overview = await new FakeApi().overview();
    const net = scripted((body, attempt) =>
      attempt === 1 ? new Response("stale", { status: 401 }) : ok(body.method, overview),
    );
    const client = new SeaClient({ fetcher: net.fetcher, origin: ORIGIN });
    await expect(client.overview()).resolves.toEqual(overview);
    expect(net.handshakes()).toBe(2);
    expect(net.rpc().map((request) => request.headers["authorization"])).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);

    const always = scripted(() => new Response("stale", { status: 401 }));
    await expect(
      new SeaClient({ fetcher: always.fetcher, origin: ORIGIN }).overview(),
    ).rejects.toBeInstanceOf(DaemonUnreachable);
    expect(always.rpc()).toHaveLength(2);
  });

  it("并发的调用共用同一次握手", async () => {
    const api = new FakeApi();
    const [overview, self] = await Promise.all([api.overview(), api.self()]);
    const net = scripted((body) => ok(body.method, body.method === "sea_self" ? self : overview));
    const client = new SeaClient({ fetcher: net.fetcher, origin: ORIGIN });
    await Promise.all([client.overview(), client.self()]);
    expect(net.handshakes()).toBe(1);
  });

  it("答复的形状不符合契约时指出是哪个字段，而不是把坏数据交给界面", async () => {
    const overview = await new FakeApi().overview();
    const broken = { ...overview, sync: { ...overview.sync, state: "drifting" } };
    const net = scripted((body) => ok(body.method, broken));
    const failure = await new SeaClient({ fetcher: net.fetcher, origin: ORIGIN })
      .overview()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect((failure as SeaError).detail).toContain("data.sync.state");

    const missing = scripted((body) => ok(body.method, { hosts: [{ host: "x" }] }));
    const second = await new SeaClient({ fetcher: missing.fetcher, origin: ORIGIN })
      .hosts()
      .catch((error: unknown) => error);
    expect((second as SeaError).detail).toContain("data.hosts[0].name");
  });

  it("kind 与方法名不符、或答复不是 JSON 时，都是明确的错误", async () => {
    const wrongKind = scripted(() => Response.json({ kind: "status", data: {} }));
    await expect(
      new SeaClient({ fetcher: wrongKind.fetcher, origin: ORIGIN }).overview(),
    ).rejects.toMatchObject({ code: "UNEXPECTED_KIND" });

    const notJson = scripted(() => new Response("<html>", { status: 502 }));
    await expect(
      new SeaClient({ fetcher: notJson.fetcher, origin: ORIGIN }).overview(),
    ).rejects.toMatchObject({ code: "HTTP_502" });
  });

  it("可空字段缺省或为 null 都按 null 处理", async () => {
    const overview = await new FakeApi().overview();
    const { last_synced_ms: _dropped, ...sync } = overview.sync;
    const net = scripted((body) => ok(body.method, { ...overview, sync }));
    const result = await new SeaClient({ fetcher: net.fetcher, origin: ORIGIN }).overview();
    expect(result.sync.last_synced_ms).toBeNull();
    expect(result.agent.since_ms).toBeLessThan(NOW);
  });
});
