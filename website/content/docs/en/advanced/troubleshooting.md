---
title: Troubleshooting
description: Stuck installs, she never wakes, killed by the system, offline after reboot, safe mode, model errors, Feishu and soul sync problems.
---

## During installation

| Symptom | Cause and fix |
|---|---|
| "Termux has not responded yet" | The line has not run successfully, or Termux is still initializing after its first launch. Open Termux, wait, paste and press Enter again, then tap "I ran it, check" |
| "Failed to update package sources" | No network on the phone, or the mirror is down. Try another network; on mainland-China networks the wizard picks a mirror from your system language |
| "Could not fetch the runtime version" | Quetzal was sent to the background during installation. Keep it in the foreground and retry |
| "New version did not respond within 40 s, switched back" | The new version failed to start and was rolled back automatically. The log is at `$PREFIX/var/log/sv/quetzal/current` in Termux; feel free to open an issue on GitHub |
| The three Termux apps do not see each other | They are not from the same source (different signatures). Uninstall all three and reinstall from one source |

## She never wakes

Check in order:

- [ ] **Control → Models**: at least one provider, one key and one enabled model, and the test passes. With no model the wake rate is zero.
- [ ] **Control → Autonomy**: autonomy is not paused; activity is not 0.
- [ ] No emergency stop in the top bar.
- [ ] **Control → Budget**: today's budget is not spent; battery above the minimum or charging; temperature normal.
- [ ] In the first hour or two after installation her drives are still building up; quiet is normal. Try **Poke**.

## Offline / killed by the system

- When the **Now** page shows the offline banner, tap **Ignite**: the app re-runs the boot script through Termux.
- Killed repeatedly: make sure Termux, Termux:Boot, Termux:API and Quetzal are all on the **battery optimization ignore list** and **allowed** in the vendor's autostart / background manager. Some vendor systems ship a separate power-saving component that ignores the whitelist; it has to be disabled in system settings ([Project.Honor9](https://github.com/PlutoKeating/Project.Honor9) documents this for one old phone).
- **Offline after a reboot**: phones with a lock screen password must be unlocked once; Termux:Boot must have been opened once to receive the boot broadcast.

## Safe mode

She tells you she "entered safe mode": more than five starts in ten minutes. Only the gateway and Feishu are up; no waking, no model calls. Usually a corrupted configuration or a provider-layer fault. Read the log (`$PREFIX/var/log/sv/quetzal/current` in Termux), fix the cause, then restart from **Control → Service**.

## Models

| Symptom | Fix |
|---|---|
| Test fails | Check that the API URL includes the version path (e.g. `/v1`), the protocol is right and the key is valid |
| A reply failed mid-way and switched models | Expected: a stream with no data for 90 seconds counts as failed and fails over |
| The image was dropped | No model can see images. Flag one with `vision` manually or enable a catalog model that accepts image input |
| Save rejected, "configuration is stale" | It was changed elsewhere first. Reload, then edit again |

## Feishu

- Shows disconnected: read the error under **Control → Feishu**; a bot created with one tap only receives credentials after you **confirm** in Feishu.
- No "Now" card: open the **direct chat** with the bot (named after the agent's display name) and say something.
- Card buttons do nothing: the bot needs long-connection event subscription; one-tap setup does this automatically, for manual setup check the event subscription mode in the app console.

## Soul sync

| Symptom | Fix |
|---|---|
| Connect fails with "address must be SSH" | Use `git@github.com:you/repo.git`, not https |
| Push rejected | The deploy key lacks **Allow write access**, or the public key was added to a different repository |
| "Different identity, refusing to merge" | Another agent lives in that repository. Create a new one for this agent |
| The two sides look out of sync | Sync is event-driven: wait for her next wake-up / conversation, or tap "Sync now" on the Soul sync page |

## The web console (Linux)

- `http://127.0.0.1:7788/` asks for a pairing code: the gateway waives it only for a browser on **the same machine**; a LAN IP or hostname does not count. use `127.0.0.1` or `localhost`. From another machine, forward the port with `ssh -L 7788:127.0.0.1:7788 <that machine>` and open the address locally, or pair from the app.
- Blank page or boxes instead of Chinese: check the service with `quetzal status` and hard-refresh the browser. The web build ships its own CJK font and needs no internet for it.
- The browser did not open after installing: without a desktop session (server, ssh login) only the address is printed; try `quetzal open`.
- The one-line installer failed midway: it prints the tail of its log, and the full log is `~/.quetzal/install.log`; fix the cause and rerun the same command (it is idempotent). A locked `apt` usually means the system is updating in the background; wait a few minutes. On Alpine run `apk add bash curl` first; on NixOS provide Node.js 22.13+ yourself (nvm's binaries do not run there).
- It did not wake up after a reboot: if `loginctl show-user $USER -p Linger` is not `yes`, run `sudo loginctl enable-linger $USER` (user services do not run without a login session by default). On machines without systemd, check `crontab -l` for `@reboot …/quetzal-supervise`; without a cron daemon, start it by hand after boot.
- The Quetzal entry in the app list opens an ordinary browser tab and the taskbar shows no Quetzal icon: a separate window needs a Chromium-family browser (Chrome / Chromium / Edge / Brave / Vivaldi); with only Firefox it opens in the default browser.

## Still stuck

Open an issue at [GitHub Issues](https://github.com/PlutoKeating/Project.Quetzal/issues) describing the symptom, with the version shown under **Control → Service** and the relevant log (strip personal information from the log first).
