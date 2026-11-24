#!/usr/bin/env node
// Quetzalcoatl V2 — Codex CLI native `-c notify=[...]` hook runner

async function main() {
  const daemonUrl = process.env.QUETZALCOATL_DAEMON_URL;
  const ipcToken = process.env.QUETZALCOATL_IPC_TOKEN;
  const rawArg = process.argv[2];
  if (!daemonUrl || !ipcToken || !rawArg) {
    return;
  }

  const payload = JSON.parse(rawArg);
  const text =
    typeof payload["last-assistant-message"] === "string"
      ? payload["last-assistant-message"]
      : "";
  const pos = text.lastIndexOf("<ewave_check");
  if (pos < 0) {
    return;
  }
  const tail = text.slice(pos);
  const closeIdx = tail.indexOf("/>");
  if (closeIdx < 0) {
    return;
  }
  const tag = tail.slice(0, closeIdx);
  const conflictMatch = /conflict="(none|disclosed|unresolved)"/.exec(tag);
  if (!conflictMatch?.[1]) {
    return;
  }
  const idsMatch = /ids="([^"]*)"/.exec(tag);
  const ids = (idsMatch?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  await fetch(`${daemonUrl.replace(/\/$/, "")}/v1/rpc`, {
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

main().catch(() => {});
