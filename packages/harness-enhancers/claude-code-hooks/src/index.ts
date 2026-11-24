export interface ClaudeHookInput {
  readonly hook_event_name: "PreCompact" | "Stop";
  readonly session_id: string;
  readonly last_assistant_message?: string;
}

export interface ClaudeHookOutput {
  readonly continue: boolean;
  readonly additionalContext?: string;
}

export interface ClaudeHookDaemonConfig {
  readonly daemonUrl: string | undefined;
  readonly ipcToken: string | undefined;
}

function parseStopCheck(text: string): {
  readonly conflict: "none" | "disclosed" | "unresolved";
  readonly ids: readonly string[];
} | null {
  const pos = text.lastIndexOf("<ewave_check");
  if (pos < 0) {
    return null;
  }
  const rest = text.slice(pos);
  const closePos = rest.indexOf("/>");
  if (closePos < 0) {
    return null;
  }
  const tag = rest.slice(0, closePos);
  const match = /conflict="(none|disclosed|unresolved)"/.exec(tag);
  const conflict = match?.[1];
  if (
    conflict !== "none" &&
    conflict !== "disclosed" &&
    conflict !== "unresolved"
  ) {
    return null;
  }
  const idsMatch = /ids="([^"]*)"/.exec(tag);
  const ids = (idsMatch?.[1] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return { conflict, ids };
}

export async function handleClaudeCodeHook(
  input: ClaudeHookInput,
  cfg: ClaudeHookDaemonConfig,
): Promise<ClaudeHookOutput> {
  if (!cfg.daemonUrl || !cfg.ipcToken) {
    return { continue: true };
  }
  const rpcUrl = `${cfg.daemonUrl.replace(/\/$/, "")}/v1/rpc`;

  if (input.hook_event_name === "PreCompact") {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-qz-ipc-token": cfg.ipcToken,
      },
      body: JSON.stringify({ method: "conscience_pinned" }),
    });
    if (!resp.ok) {
      return { continue: true };
    }
    const payload = (await resp.json()) as {
      readonly data?: { readonly pinned_system_tail?: string };
    };
    const pinned = payload.data?.pinned_system_tail;
    if (pinned && pinned.length > 0) {
      return { continue: true, additionalContext: pinned };
    }
    return { continue: true };
  }

  const msg = input.last_assistant_message ?? "";
  const parsed = parseStopCheck(msg);
  if (parsed) {
    await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-qz-ipc-token": cfg.ipcToken,
      },
      body: JSON.stringify({
        method: "ewave_check_report",
        params: {
          conflict: parsed.conflict,
          ids: parsed.ids,
        },
      }),
    });
  }
  return { continue: true };
}
