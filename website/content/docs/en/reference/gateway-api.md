---
title: Gateway API
description: The local gateway's HTTP endpoints, WebSocket RPC and push events, and the method list. The Quetzal app and the Feishu channel use exactly this.
---

## Overview

By default the gateway listens only on `127.0.0.1:<gateway.port>` (default 7788; set `gateway.host` to `0.0.0.0` to open it to the LAN). Every control entry (app, web console, Feishu, host tools) shares one operations layer, behaves identically and is audited. When `web/index.html` sits next to `main.cjs` (the web console placed there by the npm installer), the gateway also serves those static files.

## HTTP

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ok, version, safeMode, mode}`, no token required |
| GET | `/auth/local` | `{ok, token}`: only for a browser on the same machine (connection from the loopback address, local Host header, local Origin if any) — the web console logs in as soon as it opens; anything else gets 403. A local process can read the token file anyway, so this does not widen the trust boundary; a connection forwarded through an ssh tunnel counts as local |
| GET | `/`, `/<static file>` | The web console (when `web/` exists): unknown paths without an extension fall back to `index.html`; ETag supported |
| POST | `/pair/start` | Generates a 6-digit pairing code (valid 5 minutes), delivered via adapter notification and Feishu |
| POST | `/pair/finish` | `{code}` → `{ok, token}`; 403 wrong code, 410 expired or more than 5 attempts |
| POST | `/upload?name=&token=` | Upload one attachment (≤ 50 MiB) → `{ok, file: {id, name, path, rel, mime, size, kind}}` |
| GET | `/uploads/<rel>?token=` | Download an attachment (uploads directory only) |

## WebSocket `/rpc?token=<token>`

```json
{ "id": 1, "method": "status", "params": {} }
{ "id": 1, "result": { } }
{ "id": 1, "error": { "code": "", "message": "" } }
{ "event": "state", "data": { } }
```

### Push events

| Event | Data |
|---|---|
| `hello` | `{version, safeMode}` |
| `state` | Full state, same as `status` (debounced 500 ms) |
| `timeline` | New timeline entry `{id, ts, kind, title, detail}` |
| `approval` | Approval `{id, action, reason, args, status}` |
| `say` | Something she says proactively |
| `activity` | Progress `{session, conv, origin, channel, ts, kind, …}`; `kind` below |
| `secret` | Secret-input state (never contains values) |
| `feishu.qr` / `feishu.registered` / `feishu.error` | Feishu one-tap setup |

`activity.kind`: `start` / `queued` / `steer` / `step` / `delta` (streamed fragment) / `text` / `tool` (one event while running, one after) / `alive` (15-second heartbeat) / `done` / `error`. Every turn in progress is also kept as a snapshot (`sessions.live`) so a client can rebuild its UI at any time.

### Methods

**Observe**

| Method | Params | Returns |
|---|---|---|
| `status` | — | `{agent, version, body, adapter, heart, physical, stopped, paused, activity, usage, budget, approvals, soul, models, thought}` |
| `timeline` | `{limit?, before?, kind?}` | Timeline (newest first); `detail` includes the process and each tool step |
| `messages` | `{limit?}` | Recent conversation |
| `audit` | `{limit?}` | Audit records |

**Converse**

| Method | Params | Notes |
|---|---|---|
| `chat.send` | `{text, conv?, turn?, attachments?, mode?}` | `mode`: `steer` (default, interjection) / `queue` / `interrupt` |
| `sessions` / `sessions.create` / `sessions.rename` / `sessions.archive` | … | Session management |
| `sessions.messages` | `{id, limit?, before?}` | One session's conversation (with process records) |
| `sessions.live` | — | Snapshots of turns in progress |
| `poke` | `{note?}` | Poke |

**Vault**: `secrets`, `secrets.delete`, `secrets.pending`, `secrets.end`.

**Speech**: `speech` / `setSpeech`, `speechVoices`, `speechTest`.

**Tuning and safety**

| Method | Params |
|---|---|
| `activity` | `{value}` (0–4) |
| `pause` | `{paused}` |
| `personality` | `{changes: {"tau.curiosity": 2, …}}` (bounded) |
| `stop` / `unstop` | `{reason?}` / — |
| `permissions` / `setPermission` | — / `{id, level: allow｜ask｜deny}` |
| `approvals` / `decide` | — / `{id, approve, note?}` |
| `budget` / `setBudget` | — / `{dailyTokens?, dailyCostUsd?, minBattery?, maxTempC?}` |
| `config` / `setConfig` | — / `{timezone?, brain?, heart?}` |
| `restart` | — |

**Memory**

| Method | Notes |
|---|---|
| `memory` / `editMemory` / `setSoul` | Resident memory and personality |
| `journalList` / `journal` | Journal |
| `notes` / `note` / `search` | Notes and retrieval |
| `soulConfig` / `setSoulConfig` / `soulKey` / `syncSoul` | Soul repository address (SSH only), local public key, sync now |
| `agent` / `setAgent` | Identity |
| `bodies` | Registered bodies |
| `soulHistory` / `soulShow` / `soulRevert` | Memory history, diff, revert |

**Models**

| Method | Notes |
|---|---|
| `providers` / `saveProviders` | Read / save as a whole (versioned; mismatch returns `STALE_CONFIG`) |
| `catalog` / `refreshCatalog` / `remoteModels` | Model catalog |
| `testModel` | `{ok, latencyMs, message}` |
| `moveModel` / `toggleModel` | Global order and enable/disable |

Provider configuration shape:

```ts
interface Provider {
  id: string; catalogId: string; name: string; baseUrl: string; enabled: boolean;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  keys: { id: string; label: string; lastFour: string; enabled: boolean; secret?: string }[];
  models: { id: string; name: string; enabled: boolean; context: number; maxTokens: number; sortOrder: number; cost?: { input: number; output: number } }[];
}
interface ProviderConfig { providers: Provider[]; quickModelId?: string }
```

**Feishu**: `feishu.status`, `feishu.register`, `feishu.set`.

> [!NOTE]
> This is an overview. Field-level detail is in the repository's [docs/API.md](https://github.com/PlutoKeating/Project.Quetzal/blob/main/docs/API.md); the code is authoritative.
