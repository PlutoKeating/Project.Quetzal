#!/usr/bin/env node
// Quetzalcoatl V2 — Claude Code PreCompact & Stop native CLI hook runner

async function main() {
  const daemonUrl = process.env.QUETZALCOATL_DAEMON_URL;
  const ipcToken = process.env.QUETZALCOATL_IPC_TOKEN;
  if (!daemonUrl || !ipcToken) {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    return;
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const rawInput = Buffer.concat(chunks).toString("utf8").trim();
  const input = rawInput.length > 0 ? JSON.parse(rawInput) : {};
  const rpcUrl = `${daemonUrl.replace(/\/$/, "")}/v1/rpc`;

  if (input.hook_event_name === "PreCompact") {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-qz-ipc-token": ipcToken,
      },
      body: JSON.stringify({ method: "conscience_pinned" }),
    });
    if (resp.ok) {
      const body = await resp.json();
      const pinned = body?.data?.pinned_system_tail;
      if (typeof pinned === "string" && pinned.length > 0) {
        process.stdout.write(
          JSON.stringify({ continue: true, additionalContext: pinned }) + "\n",
        );
        return;
      }
    }
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    return;
  }

  const text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const pos = text.lastIndexOf("<ewave_check");
  if (pos >= 0) {
    const tail = text.slice(pos);
    const closeIdx = tail.indexOf("/>");
    if (closeIdx >= 0) {
      const tag = tail.slice(0, closeIdx);
      const conflictMatch = /conflict="(none|disclosed|unresolved)"/.exec(tag);
      if (conflictMatch?.[1]) {
        const idsMatch = /ids="([^"]*)"/.exec(tag);
        const ids = (idsMatch?.[1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        await fetch(rpcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-qz-ipc-token": ipcToken,
          },
          body: JSON.stringify({
            method: "ewave_check_report",
            params: { conflict: conflictMatch[1], ids },
          }),
        });
      }
    }
  }
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
});
