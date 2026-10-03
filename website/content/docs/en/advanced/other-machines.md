---
title: Other machines
description: Any machine with Node.js 22+ and git can be a body — build, run, hand it to a process supervisor, then pair the app.
---

## When this applies

A phone is the best body, but not the only one. A Raspberry Pi, a small home server or a cloud VM can run the runtime. This page is for **deployers** and uses the command line.

## 1. Build

```bash
git clone https://github.com/PlutoKeating/Project.Windler.git
cd Project.Windler/runtime
npm ci
npm test            # unit tests
npm run build       # produces dist/main.cjs (single file, dependencies bundled) and dist/termux.mjs
```

The runtime is a **single file**, `main.cjs`, with no native dependencies (storage uses Node's built-in `node:sqlite`).

## 2. Run

```bash
WINDLER_HOME=~/windler node --enable-source-maps dist/main.cjs
```

Environment variables:

| Variable | Meaning |
|---|---|
| `WINDLER_HOME` | Home directory (default `~/windler`): configuration, secrets, data and the soul directory |
| `WINDLER_ADAPTER` | Path to a body adapter module; unset means the generic adapter (OS information only, no sensors) |

## 3. Hand it to a supervisor

The runtime only handles its own logic; **process supervision is external**: if it exits, restart it. A systemd user service, for example:

```ini
[Unit]
Description=Windler runtime

[Service]
Environment=WINDLER_HOME=%h/windler
Environment=WINDLER_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/windler/main.cjs
Restart=always

[Install]
WantedBy=default.target
```

> [!NOTE]
> More than five starts within ten minutes puts the runtime into safe mode (gateway and Feishu only, no waking) so a crash loop cannot burn money.

## 4. Connect the app

The gateway listens only on `127.0.0.1:7788`. For the phone app to reach a runtime on another machine, forward the port to the phone first:

- with the phone attached over USB: `adb reverse tcp:7788 tcp:7788`;
- or an ssh tunnel.

Then in the app: **Connect a new agent** → enter the gateway address → **Request pairing code**. The code is delivered through the adapter's system notification. **Adapters without `notify`** (such as the generic one) cannot show it; in that case read the token from `WINDLER_HOME/secrets/gateway.token` and enter it directly.

## 5. A body adapter

The generic adapter has no sensors. A few dozen lines give this machine an adapter so she can feel its battery, light or motion, or gain device tools. See [Custom body adapter](/docs/advanced/custom-adapter).

## Development mode

```bash
cd runtime && npm run dev     # run the TypeScript sources directly with ./.dev as home
```
