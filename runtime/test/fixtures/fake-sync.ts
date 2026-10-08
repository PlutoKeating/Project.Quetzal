// 测试用的精简同步服务（协议见 sync/docs/PROTOCOL.md）：hello（令牌就是身体名）→ welcome；身体上下线；signal 原样转发（可被测试篡改，tamper 返回 null 即丢弃）；
// announce 单独告诉某具身体另一具的上下线（模拟通知漏了、或同步服务判断失真）。
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export async function fakeSync(registered: Record<string, string>, kinds: Record<string, string> = {}) {
  const conns = new Map<string, WebSocket>();
  const ctl = {
    tamper: undefined as ((from: string, to: string, data: any) => any) | undefined, conns, registered, kinds, url: "", close: () => {},
    announce: (to: string, body: string, online: boolean) => { conns.get(to)?.send(JSON.stringify({ t: "peer", peer: peer(body, online) })); },
  };
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/v1/ws" });
  const peer = (b: string, online: boolean) => ({ body: b, kind: kinds[b] ?? "runtime", nodeKey: registered[b], version: "t", online, lastSeen: 0 });
  wss.on("connection", (ws) => {
    let me = "";
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "hello") {
        me = m.token; conns.set(me, ws);
        ws.send(JSON.stringify({ t: "welcome", protocol: 1, now: Date.now(), agent: { id: "x", name: "x" }, body: me, account: "t",
          peers: Object.keys(registered).filter((b) => b !== me).map((b) => peer(b, conns.has(b))), iceServers: [], ttl: 0 }));
        for (const [b, c] of conns) if (b !== me) c.send(JSON.stringify({ t: "peer", peer: peer(me, true) }));
      } else if (m.t === "signal") {
        const data = ctl.tamper ? ctl.tamper(me, m.to, m.data) : m.data;
        if (data === null) return;
        conns.get(m.to)?.send(JSON.stringify({ t: "signal", from: me, data }));
      }
    });
    ws.on("close", () => { if (conns.get(me) === ws) { conns.delete(me); for (const [, c] of conns) c.send(JSON.stringify({ t: "peer", peer: peer(me, false) })); } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  ctl.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ctl.close = () => { wss.close(); server.close(); };
  return ctl;
}
