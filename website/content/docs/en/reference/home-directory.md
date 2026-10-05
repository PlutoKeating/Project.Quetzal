---
title: Home directory and configuration
description: The layout of QUETZAL_HOME, every key in config/quetzal.json, and the file conventions of the Android / Termux deployment.
---

## `QUETZAL_HOME` (default: `~/quetzal` on Android / Termux, `~/.quetzal` on Linux and other machines; both overridable with the environment variable)

```
config/quetzal.json      runtime configuration (editable from the app)
config/providers.json    model providers (keys encrypted)
secrets/                 0700: master.key (key-encryption master), gateway.token, gateway-tls.key / gateway-tls.crt (self-signed certificate for LAN HTTPS), feishu_secret, soul_ed25519, azure_speech_key
vault/                   0700: the vault, one 0600 file per item; index.json holds hints only
data/quetzal.db          SQLite: kv / timeline / messages / audit / usage
data/catalog.json        cached public model catalog (models.dev)
data/uploads/<date>/     chat attachments
data/media/              photos and recordings she made (Termux adapter)
soul/                    soul directory (a git repository)
state/starts.json        start records (circuit breaker)
STOP                     emergency stop flag: if present, everything freezes
```

> [!IMPORTANT]
> `secrets/`, `vault/` and `config/providers.json` belong to this body only; they never enter the soul repository or sync. When backing up the phone, back up the whole home directory.

## `config/quetzal.json`

| Key | Default | Meaning |
|---|---|---|
| `body` | `default` | Body name (journal directory); the installer writes the device model |
| `adapter` | `""` | Adapter module path (the Termux deployment uses the `QUETZAL_ADAPTER` environment variable instead) |
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

All of these are editable from the console (phone app or web version); no file editing required.

## Environment variables

| Variable | Meaning |
|---|---|
| `QUETZAL_HOME` | Home directory |
| `QUETZAL_ADAPTER` | Body adapter module path |
| `QUETZAL_CONSOLE_ACTIVITY` | (Termux adapter) the activity opened by the notification button, default `xyz.quetzal.console/.MainActivity` |

## Android / Termux deployment conventions

The Quetzal app's installer and igniter follow these:

```
~/quetzal/releases/<version>/      main.cjs, termux.mjs
~/quetzal/current → releases/…     the running version
~/quetzal/previous → releases/…    the previous version (for rollback)
$PREFIX/var/service/quetzal/run    runit service: QUETZAL_ADAPTER=$HOME/quetzal/current/termux.mjs
$PREFIX/var/log/sv/quetzal/        logs (rotated by svlogd)
~/.termux/boot/quetzal             boot script: termux-wake-lock + start runit
~/.termux/termux.properties        allow-external-apps=true
```

Packages: `nodejs-lts termux-services termux-api git openssh`. Only the last three versions are kept. A health check failing for 40 seconds switches back to `previous`.

## Linux / npm deployment conventions

The npm package `@plutokeating/quetzal` (`npx @plutokeating/quetzal`) follows these, mirroring Android (the Linux home directory defaults to `~/.quetzal`, changeable with `QUETZAL_HOME` or `--home`; installs made before 0.6.7 under `~/quetzal` are moved over automatically the next time the installer runs); the one-line installer (`curl -fsSL https://quetzal.plutokeating.beer/install | bash`) adds a few things on top:

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
