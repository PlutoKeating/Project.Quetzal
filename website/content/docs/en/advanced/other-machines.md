---
title: Linux and other machines
description: A Linux computer or server becomes a body with one curl command: dependencies are installed, a service that starts at boot and restarts after a crash is registered, Quetzal appears in your app list, and the web console opens in your browser; any other machine with Node.js 22.13+ and git can be set up by hand.
---

## When this applies

A phone is the best body; a laptop, a small home server, a Raspberry Pi or a cloud VM can run the runtime too. Linux machines have a one-line installer; other systems follow section 4 by hand.

## 1. Linux: one command

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

The only prerequisites are Linux, `curl` (or `wget`) and bash 4+. Everything else missing gets installed. Architectures: x86_64 and arm64 get everything, native console included; on architectures without official Node binaries, such as LoongArch (loongarch64), RISC-V and armv6l, the script downloads the matching Node 22 from the Node.js project's [unofficial-builds](https://unofficial-builds.nodejs.org) into `~/quetzal/node/`, so the runtime and the web console work as usual, only without the native console (upstream Flutter does not support LoongArch yet), and the app-list entry opens the browser. Afterwards:

- The **web console** `http://127.0.0.1:7788/` is open in your browser, logged in without a pairing code on the same machine; models, identity, permissions, Feishu, the soul repository and conversations all live there (section 2).
- Your app list has a **Quetzal** entry (the orb icon) that opens the **native console** (the Flutter Linux desktop build, downloaded from the GitHub Release of the same version into `~/quetzal/console/`); the taskbar, Alt-Tab and the activities overview all show Quetzal's own icon, independent of any browser. When no native package exists for this version (arm64, older releases) or the download fails, it falls back to the browser: Chromium-family browsers open it as a separate window, Firefox opens it in the default browser, and the taskbar then shows the browser's icon.
- The terminal has a `quetzal` command (`~/.local/bin/quetzal`, available in new terminals): `quetzal status` / `logs -f` / `open` / `rollback` / `uninstall`.
- It starts by itself at boot and comes back within 3 seconds after a crash or kill; running the same command again upgrades.

What the installer does, step by step (idempotent):

| Step | What happens |
|---|---|
| This machine | Detects the distribution, architecture, package manager (apt / dnf / yum / pacman / zypper / apk / xbps), whether a systemd user instance exists, whether there is a desktop, WSL / container |
| Dependencies | Installs `git`, `curl`, `tar` and CA certificates with the machine's own package manager when missing (`sudo` / `doas` asks for a password once if needed; root installs directly). **Node.js 22.13+**: a new enough one on PATH (with npm) is used as is; otherwise [nvm](https://github.com/nvm-sh/nvm) goes into `~/.nvm` and installs Node.js 22 (the system Node is untouched). musl systems such as Alpine and NixOS cannot run nvm's official binaries: Alpine gets `apk add nodejs npm`, NixOS needs Node provided beforehand. If nodejs.org is unreachable the mainland-China mirror (npmmirror) is used automatically |
| Runtime | Installs the npm package `@plutokeating/quetzal` into `~/quetzal/npm` (its own prefix, nothing global), which places the version directory, default configuration, systemd service, health check and rollback (see 1.1) |
| Supervision | With a systemd user instance: the `systemd --user` service `quetzal`, `Restart=always`, plus `loginctl enable-linger` so it runs without a login session (asks for a password once if administrator rights are needed). Without one (Alpine / Void / Devuan, containers, WSL without systemd): a small supervisor loop `~/quetzal/bin/quetzal-supervise` (restarts 3 s after any exit, flock keeps it single), started at boot via `crontab @reboot` and a desktop autostart entry; no extra service framework is installed |
| Desktop | Only with a desktop environment: downloads the native console of the same version into `~/quetzal/console/<version>/` (`console/current` points at it; on old distributions where `ldd` reports missing libraries it gives up and falls back to the browser), icons into `~/.local/share/icons/hicolor/` (`xyz.quetzal.console.png`), the launcher `~/.local/bin/quetzal-console` (native first, browser otherwise), and `~/.local/share/applications/xyz.quetzal.console.desktop` |
| Finish | Opens the console when there is a graphical session; prints the address, the supervision mode and the common commands. On a server it prints `ssh -L 7788:127.0.0.1:7788 <this machine>` |

Options go after `bash -s --`; each has an environment variable too:

| Option | Environment variable | Effect |
|---|---|---|
| `--lan` | `QUETZAL_LAN=1` | Open the gateway to the LAN so the phone app can connect to this machine directly (trusted networks only) |
| `--no-open` | `QUETZAL_NO_OPEN=1` | Do not open the browser afterwards |
| `--no-desktop` | `QUETZAL_NO_DESKTOP=1` | Skip the app-list shortcut |
| `--home DIR` | `QUETZAL_HOME=DIR` | Home directory (default `~/quetzal`) |
| `--version X.Y.Z` | `QUETZAL_VERSION=X.Y.Z` | Install a specific version (default latest) |
| `--cn` / `--no-cn` | `QUETZAL_MIRROR=cn` / `off` | Force the mainland-China mirror on / off (auto-detected by default) |
| `--lang zh` / `en` | `QUETZAL_LANG=zh` / `en` | Interface language (default follows the system locale: Simplified / Traditional Chinese show Chinese, anything else English) |
| `--uninstall [--purge]` | — | Remove the service, supervisor loop, shortcuts and npm package; `--purge` also deletes `~/quetzal` (configuration, memories, conversations). nvm, Node.js and git stay |

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --lan        # with options
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall  # uninstall
```

The script's source is [`cli/install.sh`](https://github.com/PlutoKeating/Project.Quetzal/blob/main/cli/install.sh) in the repository; the website build copies it verbatim to `/install`, and it is also available at `https://raw.githubusercontent.com/PlutoKeating/Project.Quetzal/main/cli/install.sh`. The install log is `~/quetzal/install.log`.

> [!NOTE]
> The service uses the absolute path of the Node chosen at install time (for nvm that is `~/.nvm/versions/node/v22.x/bin/node`), so `nvm uninstall 22` later breaks the service; rerunning the install command fixes it. On machines without systemd the `quetzal stop` / `logs` subcommands do not apply: stop with `kill $(cat ~/quetzal/state/supervise.pid)`, and the log is `~/quetzal/logs/runtime.log`.

### 1.1 Just the npm package: `npx @plutokeating/quetzal`

If you already have Node.js 22.13+ (`node:sqlite` needs no flag from this version on) and git, and do not want a desktop shortcut, the npm package alone is enough; the one-line installer calls it internally.

```bash
npx @plutokeating/quetzal            # install: the runtime, the Linux body adapter and the web console go into ~/quetzal, a systemd user service is registered and started, then the console opens in the browser
npx @plutokeating/quetzal open       # open the web console again, http://127.0.0.1:7788/
npx @plutokeating/quetzal --lan      # also open the gateway to the LAN so the app on your phone can connect to this machine directly (trusted networks only)
```

What it does: it copies the bundled `main.cjs`, `linux.mjs` and the web console `web/` into `~/quetzal/releases/<version>/` and points `current` at it (the same directory convention as on the phone); writes `~/.config/systemd/user/quetzal.service` (restart on exit), starts it and waits for `/health`; if there is no response within 40 seconds it switches back to the previous version. On a first install with a desktop it opens the browser (`--no-open` to skip). Running `npx @plutokeating/quetzal` again upgrades.

Common commands (after the one-line install, `npx @plutokeating/quetzal` can be replaced by `quetzal`):

| Command | Effect |
|---|---|
| `npx @plutokeating/quetzal status` | Version, service, health, gateway and web console addresses |
| `npx @plutokeating/quetzal open` | Open the web console in the browser |
| `npx @plutokeating/quetzal logs -f` | Service log (journald) |
| `npx @plutokeating/quetzal rollback` | Switch back to the previous version and restart |
| `npx @plutokeating/quetzal stop` / `start` / `restart` | Service control |
| `npx @plutokeating/quetzal uninstall [--purge]` | Remove the service; `--purge` also deletes `~/quetzal` (configuration, memories, conversations) |
| `npx @plutokeating/quetzal run` | No systemd user instance (containers, WSL without systemd): run in the foreground under your own supervisor |

> [!NOTE]
> The service uses the Node that ran npx at install time, so a Node installed by nvm or similar works too; the service does not depend on the npx cache. Running without a login session (servers) needs `loginctl enable-linger`; the installer tries it and tells you to run it once with sudo if it fails.

### What this body can sense

The Linux adapter detects everything: a laptop reports battery level and charging, CPU temperature goes into extra; with a desktop session it can show notifications, play sound, take screenshots, read the clipboard and open URLs; with a camera and microphone it can take photos and record. On a headless server those tools simply say so instead of failing. Details in [Adapter interface](/docs/reference/adapter-interface).

## 2. The web console: usable as soon as it is installed, no phone needed

Open `http://127.0.0.1:7788/`. This is the Quetzal app as a web page, the same console laid out afresh for a wide screen: navigation (chat / flow / memory / control) and the current section's list on the left, what you are reading in the middle, and on the right, always, how it is right now (the orb, the thought it wants to share, a wake in progress, requests waiting for your approval, its inner state and body). Models, identity, permissions, Feishu, the soul repository and conversations all happen here, exactly as in the app.

- **No pairing code**: a browser on the same machine is logged in as soon as the page opens (the gateway only accepts requests from the loopback address with a local Host header; see [Gateway API](/docs/reference/gateway-api)).
- **Headless server**: forward the port with `ssh -L 7788:127.0.0.1:7788 <server>` and open the same address in your local browser; a tunnelled connection counts as local to the gateway.
- **The address bar records where you are** (`#/chat/<session>`, `#/control/providers`, …): bookmarkable, back and forward work.
- The web version has no microphone and no installer: hearing lives in the phone app; to upgrade, rerun the install command (or `npx @plutokeating/quetzal`) on this machine.

## 3. Connect the phone app to a Linux machine (optional)

- Installed with `--lan`: in the app, **Connect a new agent** → enter `http://<this machine's address>:7788` → **Request pairing code**.
- Without it: the gateway listens on `127.0.0.1` only, so forward the port first (`adb reverse tcp:7788 tcp:7788` with the phone attached over USB, or an ssh tunnel) and enter `http://127.0.0.1:7788` in the app. You can switch to open at any time with `npx @plutokeating/quetzal --lan`.

The pairing code appears as a desktop notification on that machine and is written to the service log; on a headless server read it from `quetzal logs`.

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
