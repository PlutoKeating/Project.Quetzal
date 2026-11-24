export interface EwaveCheckSignal {
  readonly conflict: "none" | "disclosed" | "unresolved";
  readonly ids: readonly string[];
}

export interface DaemonConnectionEnv {
  readonly daemonUrl: string | undefined;
  readonly ipcToken: string | undefined;
}

export interface OpenCodeCompactingEvent {
  readonly sessionID: string;
  readonly context: string[];
}

export interface OpenCodeTurnCompletedEvent {
  readonly sessionID: string;
  readonly assistantText: string;
}

export interface OpenCodeHttpGuardEvent {
  readonly path: string;
}

export interface OpenCodePluginHooks {
  readonly "experimental.session.compacting"?: (
    input: { readonly sessionID: string },
    output: { context: string[] },
  ) => Promise<void>;
  readonly "turn.completed"?: (event: OpenCodeTurnCompletedEvent) => Promise<void>;
  readonly "http.request.guard"?: (event: OpenCodeHttpGuardEvent) => void;
}

export interface OpenCodePluginContext {
  readonly directory: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface OpenCodePluginDefinition {
  readonly id: string;
  readonly setup: (ctx: OpenCodePluginContext) => Promise<OpenCodePluginHooks> | OpenCodePluginHooks;
}

export const Plugin = {
  define(definition: OpenCodePluginDefinition): OpenCodePluginDefinition {
    return definition;
  },
};

export function parseEwaveCheckTag(text: string): EwaveCheckSignal | null {
  const startIdx = text.lastIndexOf("<ewave_check");
  if (startIdx < 0) {
    return null;
  }
  const tail = text.slice(startIdx);
  const closeIdx = tail.indexOf("/>");
  if (closeIdx < 0) {
    return null;
  }
  const tag = tail.slice(0, closeIdx);
  const conflictMatch = /conflict="(none|disclosed|unresolved)"/.exec(tag);
  const rawConflict = conflictMatch?.[1];
  if (
    rawConflict !== "none" &&
    rawConflict !== "disclosed" &&
    rawConflict !== "unresolved"
  ) {
    return null;
  }
  const idsMatch = /ids="([^"]*)"/.exec(tag);
  const rawIds = idsMatch?.[1] ?? "";
  const ids = rawIds
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return { conflict: rawConflict, ids };
}

export function assertNotBlockedPtyPath(path: string): void {
  const normalized = path.split("?")[0]?.trim().toLowerCase().replace(/%2f/g, "/") ?? "";
  if (normalized === "/api/pty" || normalized.startsWith("/api/pty/")) {
    throw new Error("SANDBOX_VIOLATION: raw /api/pty* access is blocked by Quetzalcoatl");
  }
}

async function fetchPinnedConscience(conn: DaemonConnectionEnv): Promise<string | null> {
  if (!conn.daemonUrl || !conn.ipcToken) {
    return null;
  }
  const endpoint = `${conn.daemonUrl.replace(/\/$/, "")}/v1/rpc`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-qz-ipc-token": conn.ipcToken,
    },
    body: JSON.stringify({ method: "conscience_pinned" }),
  });
  if (!resp.ok) {
    return null;
  }
  const body = (await resp.json()) as {
    readonly kind?: string;
    readonly data?: { readonly pinned_system_tail?: string };
  };
  return body.data?.pinned_system_tail ?? null;
}

async function reportEwaveCheck(
  conn: DaemonConnectionEnv,
  signal: EwaveCheckSignal,
): Promise<void> {
  if (!conn.daemonUrl || !conn.ipcToken) {
    return;
  }
  const endpoint = `${conn.daemonUrl.replace(/\/$/, "")}/v1/rpc`;
  await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-qz-ipc-token": conn.ipcToken,
    },
    body: JSON.stringify({
      method: "ewave_check_report",
      params: {
        conflict: signal.conflict,
        ids: signal.ids,
      },
    }),
  });
}

export const quetzalcoatlOpenCodePlugin = Plugin.define({
  id: "quetzalcoatl",
  setup(ctx: OpenCodePluginContext): OpenCodePluginHooks {
    const conn: DaemonConnectionEnv = {
      daemonUrl: ctx.env?.["QUETZALCOATL_DAEMON_URL"],
      ipcToken: ctx.env?.["QUETZALCOATL_IPC_TOKEN"],
    };

    return {
      async "experimental.session.compacting"(_input, output) {
        const pinned = await fetchPinnedConscience(conn);
        if (pinned && pinned.length > 0) {
          output.context.push(pinned);
        }
      },
      async "turn.completed"(event) {
        const parsed = parseEwaveCheckTag(event.assistantText);
        if (parsed) {
          await reportEwaveCheck(conn, parsed);
        }
      },
      "http.request.guard"(event) {
        assertNotBlockedPtyPath(event.path);
      },
    };
  },
});

export default quetzalcoatlOpenCodePlugin;
