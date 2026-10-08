---
title: Home directory and configuration
description: The layout of QUETZAL_HOME, every key in config/quetzal.json, and the file conventions of the Android (built into the app), Termux (older installs), Linux and Windows deployments.
---

## `QUETZAL_HOME` (default: `files/home/quetzal` in the app's data directory on Android, `~/quetzal` for older Termux installs, `%LOCALAPPDATA%\Quetzal\home` on Windows, `~/.quetzal` on Linux and other machines; all overridable with the environment variable)

```
config/quetzal.json      runtime configuration (editable from the app)
config/providers.json    model providers (keys encrypted)
secrets/                 0700: master.key (key-encryption master), gateway.token, gateway-tls.key / gateway-tls.crt (self-signed certificate for LAN HTTPS), feishu_secret, soul_ed25519, azure_speech_key; with the Android app also body.json (port and token of the body interface, rewritten by the app on every start)
vault/                   0700: the vault, one 0600 file per item; index.json holds hints only
data/quetzal.db          SQLite: kv / timeline / messages / audit / usage
data/catalog.json        cached public model catalog (models.dev)
data/uploads/<date>/     chat attachments
data/media/              photos and recordings it made (Android adapter)
data/mesh-pins.json      with several bodies: the public key and kind of each body, recorded the first time it was seen (not secret)
data/mesh-lan.json       with several bodies: remembered LAN addresses of the other bodies, used to connect over the LAN when the sync service is unreachable (stays on this device)
data/from-bodies/<body>/ files fetched from other bodies (tools called with body; see Multiple bodies)
data/runtime.log         with the Android app: log of the runtime and the app service (rotated past 4 MB)
soul/                    soul directory (a git repository)
state/starts.json        start records (circuit breaker)
state/body-uuid          this body's uuid (JSON: uuid and its source device / random / manual; only the derived value, never the raw identifier; see Multiple bodies)
STOP                     emergency stop flag: if present, everything freezes
```

> [!IMPORTANT]
> `secrets/`, `vault/` and `config/providers.json` belong to this body only; they never enter the soul repository or sync. When backing up the phone, back up the whole home directory.

## `config/quetzal.json`

| Key | Default | Meaning |
|---|---|---|
| `body` | `default` | Body name (journal directory); the installer writes the device model |
| `adapter` | `""` | Adapter module path (the Android app and the Termux deployment use the `QUETZAL_ADAPTER` environment variable instead) |
| `timezone` | System timezone (`Asia/Shanghai` if unavailable) | Timezone for the body clock and journal |
| `heart.activity` | `1` | Activity knob (0–4) |
| `heart.baseRatePerHour` | `4` | Saturated wake rate $\lambda_0$ |
| `heart.paused` | `false` | Pause autonomy |
| `budget.dailyTokens` | `2000000` | Daily tokens |
| `budget.dailyCostUsd` | `5` | Daily cost (USD) |
| `budget.minBattery` | `15` | Minimum battery (%) |
| `budget.maxTempC` | `45` | Maximum temperature |
| `permissions.*` | `camera` / `microphone` / `location` / `hands` are `ask`, the rest `allow` | Permissions |
| `brain.maxOutputTokens` | `4096` | Output cap per model call (no step cap) |
| `feishu.*` | — | Feishu (secret in `secrets/`) |
| `soul.remote` / `soul.branch` | `""` / `main` | Soul repository SSH address and branch |
| `gateway.port` | `7788` | The gateway's plain port (loopback only) |
| `gateway.lan` / `gateway.lanPort` / `gateway.host` | `false` / `7789` / `127.0.0.1` | Open to the LAN (`lan` true or `host` not a loopback address): HTTPS / WSS on `host` (`0.0.0.0` when it is loopback):`lanPort` |
| `speech.region` / `endpoint` / `voice` / `style` / `rate` / `pitch` / `volume` / `format` | `""` / `""` / `zh-CN-XiaoxiaoNeural` / `""` / `0%` / `0%` / `100` / `audio-24khz-48kbitrate-mono-mp3` | Azure Speech (key in `secrets/azure_speech_key`) |

You can edit all of these from the console (phone app or web version).

## Environment variables

| Variable | Meaning |
|---|---|
| `QUETZAL_HOME` | Home directory |
| `QUETZAL_ADAPTER` | Body adapter module path |
| `QUETZAL_CONSOLE_ACTIVITY` | (Termux adapter) the activity opened by the notification button, default `xyz.quetzal.console/.MainActivity` |
| `QUETZAL_HIDE_PATHS` | Extra directories the proot sandbox hides (colon-separated); the app sets it to its own private data directories |

## Android deployment conventions (built into the Quetzal app)

The app's foreground service (`RuntimeService`) follows these; `<data>` is `/data/data/xyz.quetzal.console`:

```
<data>/files/usr/                 runtime environment prefix: shared libraries, certificates, git templates, mesh native module (lib/quetzal/node_modules);
                                  bin/node, bin/git, bin/ssh, bin/ssh-keygen, bin/proot etc. link to lib*.so in the APK's native library directory
<data>/files/runtime/<version>/   main.cjs, android.mjs (from the app's bundled assets; only the current version is kept)
<data>/files/home/                HOME (its commands run here by default)
<data>/files/home/quetzal/        QUETZAL_HOME
```

- When the app version or the native library directory changes (an update), the app unpacks the environment again and keeps the home directory as it is.
- Environment: `PREFIX`, `QUETZAL_HOME`, `QUETZAL_ADAPTER` (`android.mjs`), `SSL_CERT_FILE`, `GIT_EXEC_PATH`, `PROOT_LOADER`, `QUETZAL_HIDE_PATHS` (`shared_prefs`, `app_flutter`, `databases`, `cache`, `code_cache`).
- On first start the body name (the model, lowercased) and time zone are written; after that the console manages them.
- Supervision: the process is restarted with backoff (from 2 seconds up to 1 minute) after it exits; it starts at boot (`BOOT_COMPLETED`) and after app updates (`MY_PACKAGE_REPLACED`), which vendor systems only deliver once autostart is allowed.

### Older Termux installs

Installs made the Termux way in 1.0.x keep working (`runtime/adapters/termux/` is kept). New installs do not use this layout:

```
~/quetzal/releases/<version>/      main.cjs, termux.mjs
~/quetzal/current → releases/…     the running version
$PREFIX/var/service/quetzal/run    runit service: QUETZAL_ADAPTER=$HOME/quetzal/current/termux.mjs
$PREFIX/var/log/sv/quetzal/        logs
~/.termux/boot/quetzal             boot script: termux-wake-lock + start runit
```

## Linux / npm deployment conventions

The npm package `@plutokeating/quetzal` (`npx @plutokeating/quetzal`) follows these, using the same layout as the older Termux installs. The Linux home directory defaults to `~/.quetzal` and can be changed with `QUETZAL_HOME` or `--home`; installs made before 0.6.7 under `~/quetzal` are moved over automatically the next time the installer runs. The one-line installer (`curl -fsSL https://quetzal.plutokeating.beer/install | bash`) adds a few things on top:

```
~/.quetzal/releases/<version>/           main.cjs, linux.mjs, web/ (the web console; the gateway serves current/web/)
~/.quetzal/current → releases/…          the running version
~/.quetzal/previous → releases/…         the previous version (for rollback)
~/.config/systemd/user/quetzal.service  systemd user service: QUETZAL_HOME, QUETZAL_ADAPTER=~/.quetzal/current/linux.mjs, Restart=always
journalctl --user -u quetzal            logs (quetzal logs)

Added by the one-line installer:
~/.quetzal/npm/                          private npm prefix for @plutokeating/quetzal (lib/node_modules/…/dist/quetzal.mjs)
~/.quetzal/install.log                   install log
~/.local/bin/quetzal                    the command: runs the quetzal.mjs above with the Node chosen at install time
~/.quetzal/console/<version>/, console/current → …   native console (Flutter Linux desktop build, executable quetzal-console; downloaded from the GitHub Release)
~/.local/bin/quetzal-console            launcher: starts the native console when present, otherwise a Chromium-family browser opens the console as its own window (--app, profile ~/.quetzal/state/console-browser)
~/.local/share/applications/xyz.quetzal.console.desktop, ~/.local/share/icons/hicolor/{512x512,192x192}/apps/xyz.quetzal.console.png   app-list entry and icons
~/.config/systemd/user/quetzal.service.d/quetzal-off.conf   written when the supervision switch is off (Restart=no)
Without systemd: ~/.quetzal/bin/quetzal-supervise (supervisor loop), ~/.quetzal/state/supervise.{pid,lock}, ~/.quetzal/logs/runtime.log, crontab @reboot, ~/.config/autostart/quetzal-runtime.desktop
```

Requires Node.js 22.13+. Only the last three versions are kept. A health check failing for 40 seconds (or reporting a different version) switches back to `previous`. `--lan` writes `gateway.host` as `0.0.0.0` and `gateway.lan` as `true` in `config/quetzal.json` (HTTPS on port 7789 on the LAN; `quetzal status` prints the address and certificate fingerprint). After installing, the web console opens at `http://127.0.0.1:7788/` (`npx @plutokeating/quetzal open`), with no pairing code on the same machine.

## Windows deployment conventions

The PowerShell one-liner (`irm https://quetzal.plutokeating.beer/install.ps1 | iex`) and the installer `quetzal-<version>-windows-<x64|arm64>-setup.exe` both follow these on Windows 10 1809 or later and Windows 11:

```
%LOCALAPPDATA%\Quetzal\
├── home\                  QUETZAL_HOME
├── runtime\<version>\     main.cjs, windows.mjs, windows-body.mjs, windows-supervise.mjs, srt.mjs, mermaid.mjs, web\, srt-win\srt-win.exe
├── runtime\current.txt    the running version (previous.txt: the one before); pointer files instead of symlinks
├── console\<version>\     the console (quetzal-console.exe); console\current.txt as above
├── bin\                   the quetzal.cmd command and the scheduled tasks' launcher (quetzal-supervise.ps1)
└── node.txt               where the runtime's node.exe is
```

- Scheduled tasks `\Quetzal\Runtime-Boot` (at boot, as the installing user, S4U) and `\Quetzal\Runtime-Logon` (at sign-in) both start the supervisor `windows-supervise.mjs`. It restarts the runtime with backoff after it exits and logs to `home\logs\runtime.log` (rotated). `home\state\supervise.off` pauses supervision (the console's Supervision switch); with `home\state\quit` present, the supervisor exits together with the runtime (the tray's Quit).
- The runtime started at boot cannot see the desktop. The body helper `windows-body.mjs`, started by the console tray after sign-in, handles notifications, screenshots, the clipboard, opening, playback, photos and recording; its address and token are in `secrets\desktop-body.json`.
- A health check failing for 40 seconds after an upgrade switches the pointer back to the previous version.

See [Windows](/docs/advanced/windows) for installation, the command sandbox and what is still missing.
