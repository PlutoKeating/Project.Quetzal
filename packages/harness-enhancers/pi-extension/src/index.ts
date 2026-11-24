export interface PiExtensionApi {
  on(
    event: "before_compact",
    handler: (ctx: { customInstructions: string[] }) => Promise<void>,
  ): void;
  on(
    event: "turn_end",
    handler: (ctx: { assistantText: string }) => Promise<void>,
  ): void;
}

export interface PiDaemonBinding {
  readonly daemonUrl: string | undefined;
  readonly ipcToken: string | undefined;
}

export interface ParsedCheck {
  readonly conflict: "none" | "disclosed" | "unresolved";
  readonly ids: readonly string[];
}

export function extractCheckSignal(text: string): ParsedCheck | null {
  const idx = text.lastIndexOf("<ewave_check");
  if (idx < 0) {
    return null;
  }
  const segment = text.slice(idx);
  const end = segment.indexOf("/>");
  if (end < 0) {
    return null;
  }
  const tag = segment.slice(0, end);
  const conflictMatch = /conflict="(none|disclosed|unresolved)"/.exec(tag);
  const conflictVal = conflictMatch?.[1];
  if (
    conflictVal !== "none" &&
    conflictVal !== "disclosed" &&
    conflictVal !== "unresolved"
  ) {
    return null;
  }
  const idsMatch = /ids="([^"]*)"/.exec(tag);
  const ids = (idsMatch?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { conflict: conflictVal, ids };
}

export function registerQuetzalcoatlPiExtension(
  pi: PiExtensionApi,
  binding: PiDaemonBinding,
): void {
  pi.on("before_compact", async (ctx) => {
    if (!binding.daemonUrl || !binding.ipcToken) {
      return;
    }
    const resp = await fetch(`${binding.daemonUrl.replace(/\/$/, "")}/v1/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-qz-ipc-token": binding.ipcToken,
      },
      body: JSON.stringify({ method: "conscience_pinned" }),
    });
    if (!resp.ok) {
      return;
    }
    const json = (await resp.json()) as {
      readonly data?: { readonly pinned_system_tail?: string };
    };
    const pinned = json.data?.pinned_system_tail;
    if (pinned && pinned.length > 0) {
      ctx.customInstructions.push(pinned);
    }
  });

  pi.on("turn_end", async (ctx) => {
    if (!binding.daemonUrl || !binding.ipcToken) {
      return;
    }
    const check = extractCheckSignal(ctx.assistantText);
    if (!check) {
      return;
    }
    await fetch(`${binding.daemonUrl.replace(/\/$/, "")}/v1/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-qz-ipc-token": binding.ipcToken,
      },
      body: JSON.stringify({
        method: "ewave_check_report",
        params: {
          conflict: check.conflict,
          ids: check.ids,
        },
      }),
    });
  });
}
