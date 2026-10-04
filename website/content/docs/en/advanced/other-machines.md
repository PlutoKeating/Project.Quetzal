---
title: Linux and other machines
description: A Linux computer or server becomes a body with one command, npx @plutokeating/quetzal, and the web console opens in your browser; any other machine with Node.js 22.13+ and git can be deployed by hand.
---

## When this applies

A phone is the best body, but not the only one. A laptop, a small home server, a Raspberry Pi or a cloud VM can run the runtime. Linux machines have a ready-made installer; other systems follow section 3 by hand.

## 1. Linux: `npx @plutokeating/quetzal`

Requirements: Linux, Node.js 22.13+ (the built-in `node:sqlite` needs no flag from that version on), git.

```bash
npx @plutokeating/quetzal            # install: the runtime, the Linux body adapter and the web console go into ~/quetzal under a systemd user service, then the console opens in your browser
npx @plutokeating/quetzal open       # open the web console again, http://127.0.0.1:7788/
npx @plutokeating/quetzal --lan      # also open the gateway to the LAN so the app on your phone can connect to this machine's address directly (trusted networks only)
```

What it does: it copies the bundled `main.cjs`, `linux.mjs` and the web console `web/` into `~/quetzal/releases/<version>/` and points `current` at it (the same layout as on the phone); writes `~/.config/systemd/user/quetzal.service` (restart on exit), starts it and waits for `/health`; if nothing answers within 40 seconds it switches back to the previous version. On a first install with a desktop session it opens the browser (`--no-open` to skip). Running `npx @plutokeating/quetzal` again upgrades.

Everyday commands:

| Command | Purpose |
|---|---|
| `npx @plutokeating/quetzal status` | Version, service, health, gateway and web console addresses |
| `npx @plutokeating/quetzal open` | Open the web console in the browser |
| `npx @plutokeating/quetzal logs -f` | Service log (journald) |
| `npx @plutokeating/quetzal rollback` | Switch back to the previous version and restart |
| `npx @plutokeating/quetzal stop` / `start` / `restart` | Service control |
| `npx @plutokeating/quetzal uninstall [--purge]` | Remove the service; `--purge` also deletes `~/quetzal` (configuration, memory, conversations) |
| `npx @plutokeating/quetzal run` | No systemd user instance (containers, WSL without systemd): run in the foreground under your own supervisor |

> [!NOTE]
> The service uses the Node that ran npx, so a Node installed with nvm works too, and the service does not depend on the npx cache. To keep running without a login session (servers) the user needs `loginctl enable-linger`; the installer tries, and tells you to run it once with sudo if that fails.

### What this body can sense

The Linux adapter detects everything: a laptop reports battery level and charging, CPU temperature goes into extra; with a desktop session it can show notifications, play sound, take screenshots, read the clipboard and open URLs; with a camera and microphone it can take photos and record. On a headless server those tools simply say so instead of failing. Details in [Adapter interface](/docs/reference/adapter-interface).

## 2. The web console: usable as soon as it is installed, no phone needed

Open `http://127.0.0.1:7788/` — this is the Quetzal app as a web page, the same console laid out afresh for a wide screen: navigation (chat / flow / memory / control) and the current section's list on the left, what you are reading in the middle, and on the right, always, how it is right now (the orb, the thought it wants to share, a wake in progress, requests waiting for your approval, its inner state and body). Models, identity, permissions, Feishu, the soul repository and conversations all happen here, exactly as in the app.

- **No pairing code**: a browser on the same machine is logged in as soon as the page opens (the gateway only accepts requests from the loopback address with a local Host header; see [Gateway API](/docs/reference/gateway-api)).
- **Headless server**: forward the port with `ssh -L 7788:127.0.0.1:7788 <server>` and open the same address in your local browser — a tunnelled connection counts as local to the gateway.
- **The address bar records where you are** (`#/chat/<session>`, `#/control/providers`, …): bookmarkable, back and forward work.
- The web version has no microphone and no installer: hearing lives in the phone app; to upgrade, run `npx @plutokeating/quetzal` again on this machine.

## 3. Connect the phone app to a Linux machine (optional)

- Installed with `--lan`: in the app, **Connect a new agent** → enter `http://<this machine's address>:7788` → **Request pairing code**.
- Without it: the gateway listens on `127.0.0.1` only, so forward the port first (`adb reverse tcp:7788 tcp:7788` with the phone attached over USB, or an ssh tunnel) and enter `http://127.0.0.1:7788` in the app. You can switch to open at any time with `npx @plutokeating/quetzal --lan`.

The pairing code appears as a desktop notification on that machine and is written to the service log; on a headless server read it from `npx @plutokeating/quetzal logs`.

## 4. Other machines: manual deployment

Any machine with Node.js 22.13+ and git can be a body.

```bash
git clone https://github.com/PlutoKeating/Project.Quetzal.git
cd Project.Quetzal/runtime
npm ci
npm test            # unit tests
npm run build       # produces dist/main.cjs (single file, dependencies bundled), dist/termux.mjs and dist/linux.mjs
QUETZAL_HOME=~/quetzal node --enable-source-maps dist/main.cjs
```

Environment variables:

| Variable | Meaning |
|---|---|
| `QUETZAL_HOME` | Home directory (default `~/quetzal`): configuration, secrets, data and the soul directory |
| `QUETZAL_ADAPTER` | Path to a body adapter module; unset means the generic adapter (OS information only, no sensors) |

The runtime only handles its own logic; **process supervision is external**: if it exits, restart it. A systemd user service, for example:

```ini
[Unit]
Description=Quetzal runtime

[Service]
Environment=QUETZAL_HOME=%h/quetzal
Environment=QUETZAL_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/quetzal/main.cjs
Restart=always

[Install]
WantedBy=default.target
```

> [!NOTE]
> More than five starts within ten minutes puts the runtime into safe mode (gateway and Feishu only, no waking) so a crash loop cannot burn money.

Connecting works as in section 3 (a manual deployment has no web console unless you place the console's web build next to `main.cjs` as `web/` or point `QUETZAL_WEB_DIR` at it); to open the gateway to the LAN set `gateway.host` to `0.0.0.0` in `config/quetzal.json`. **Adapters without `notify`** (such as the generic one) cannot show the pairing code; in that case read the token from `QUETZAL_HOME/secrets/gateway.token` and enter it directly.

The generic adapter has no sensors. A few dozen lines give this machine an adapter so the agent can feel its body or gain device tools. See [Custom body adapter](/docs/advanced/custom-adapter).

## Development mode

```bash
cd runtime && npm run dev     # run the TypeScript sources directly with ./.dev as home
cd cli && npm run build && node dist/quetzal.mjs status --home /tmp/w   # build the npm package and try it with a separate home
```
