export interface CodexNotifyPayload {
  readonly type: "agent-turn-complete" | "session-compacting";
  readonly "turn-id"?: string;
  readonly "last-assistant-message"?: string;
}

export interface CodexHookResult {
  readonly repinnedConscience: string | null;
  readonly reportedConflict: "none" | "disclosed" | "unresolved" | null;
}

export async function handleCodexNotify(
  payload: CodexNotifyPayload,
  daemonUrl: string | undefined,
  ipcToken: string | undefined,
): Promise<CodexHookResult> {
  if (!daemonUrl || !ipcToken) {
    return { repinnedConscience: null, reportedConflict: null };
  }
  const rpcUrl = `${daemonUrl.replace(/\/$/, "")}/v1/rpc`;

  if (payload.type === "session-compacting") {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-qz-ipc-token": ipcToken,
      },
      body: JSON.stringify({ method: "conscience_pinned" }),
    });
    if (!resp.ok) {
      return { repinnedConscience: null, reportedConflict: null };
    }
    const body = (await resp.json()) as {
      readonly data?: { readonly pinned_system_tail?: string };
    };
    return {
      repinnedConscience: body.data?.pinned_system_tail ?? null,
      reportedConflict: null,
    };
  }

  const text = payload["last-assistant-message"] ?? "";
  const idx = text.lastIndexOf("<ewave_check");
  if (idx < 0) {
    return { repinnedConscience: null, reportedConflict: null };
  }
  const tail = text.slice(idx);
  const closeIdx = tail.indexOf("/>");
  if (closeIdx < 0) {
    return { repinnedConscience: null, reportedConflict: null };
  }
  const tag = tail.slice(0, closeIdx);
  const match = /conflict="(none|disclosed|unresolved)"/.exec(tag);
  const conflict = match?.[1];
  if (
    conflict !== "none" &&
    conflict !== "disclosed" &&
    conflict !== "unresolved"
  ) {
    return { repinnedConscience: null, reportedConflict: null };
  }
  const idsMatch = /ids="([^"]*)"/.exec(tag);
  const ids = (idsMatch?.[1] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-qz-ipc-token": ipcToken,
    },
    body: JSON.stringify({
      method: "ewave_check_report",
      params: { conflict, ids },
    }),
  });
  return { repinnedConscience: null, reportedConflict: conflict };
}
