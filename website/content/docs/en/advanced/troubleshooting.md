---
title: Troubleshooting
description: Stuck installs, it never wakes, killed by the system, offline after reboot, safe mode, model errors, Feishu and soul sync problems.
---

## During installation

| Symptom | Cause and fix |
|---|---|
| "A runtime is already running on this phone" | Most likely the old version installed in Termux is still running on the same port. Migrate as in [Coming from the Termux version](/docs/start/install#coming-from-the-termux-version): make sure the soul is pushed, uninstall the Termux version (or `sv down quetzal` in Termux), then come back and install |
| "The runtime did not respond within 180 seconds" | The built-in runtime failed to start. The log is `files/home/quetzal/data/runtime.log` in the app's data directory (readable from a computer with `adb shell run-as xyz.quetzal.console`, debug builds only); open an issue on GitHub with it. Try **Retry** first |
| "Could not read the gateway token" / "checking the gateway failed" | The runtime is up but the token does not match, most likely because the data directory was edited by hand. Restart under **Control → Advanced → Runtime** and try again |

On Windows, the SmartScreen warning, Smart App Control and a declined administrator prompt are covered in [Windows](/docs/advanced/windows).

## It never wakes

Check in order:

- [ ] **Control → Models**: at least one provider, one key and one enabled model, and the test passes. With no model the wake rate is zero.
- [ ] **Control → Rhythm**: not paused; activity is not 0.
- [ ] No emergency stop in the top bar.
- [ ] **Control → Advanced → Budget**: today's budget is not spent; battery above the minimum or charging; temperature normal.
- [ ] In the first hour or two after installation its drives are still building up, so quiet is normal. Try **Poke**.

## Offline / killed by the system

- When the **Now** page shows the offline banner, tap **Start**: the app starts its own foreground service again (the permanent "lives on this phone" notification).
- Killed repeatedly: make sure Quetzal is on the **battery optimization ignore list** and **allowed** in the vendor's autostart / background manager. Some vendor systems ship a separate "power genie" style component that ignores the whitelist and must be turned off or disabled in system settings ([Project.Honor9](https://github.com/PlutoKeating/Project.Honor9) records how on one old phone).
- **Offline after a reboot or an app update**: a phone with a lock screen password must be unlocked once. If the vendor system has not allowed autostart, it blocks the boot and update broadcasts; open the app once, and allow autostart so it does not happen again.

## Safe mode

It tells you it "entered safe mode" when the runtime started more than five times in ten minutes. Only the gateway and Feishu run; it does not wake or call models. The usual cause is a corrupted configuration or a fault in the model layer. Read the log (phone: `files/home/quetzal/data/runtime.log` in the app's data directory; Linux and Windows: `quetzal logs`), fix the cause, then restart from **Control → Advanced → Runtime**.

## Models

| Symptom | Fix |
|---|---|
| Test fails | Check that the API URL includes the version path (e.g. `/v1`), the protocol is right and the key is valid |
| A reply failed mid-way and switched models | Expected: a stream with no data for 90 seconds counts as failed and fails over |
| The image was dropped | No model can see images. Flag one with `vision` manually or enable a catalog model that accepts image input |
| Save rejected, "configuration is stale" | It was changed elsewhere first. Reload, then edit again |

## Feishu

- Shows disconnected: read the error under **Control → Feishu**. A bot created with one tap only receives credentials after you **confirm** in Feishu.
- No "Now" card: open the **direct chat** with the bot (named after the agent's display name) and say something.
- Card buttons do nothing: the bot needs long-connection event subscription. One-tap setup turns it on; after manual setup, check the event subscription mode in the app console.

## Soul sync

| Symptom | Fix |
|---|---|
| Connect fails with "address must be SSH" | Use the SSH address, `git@github.com:you/repo.git` |
| Push rejected | The deploy key lacks **Allow write access**, or the public key was added to a different repository |
| "Different identity, refusing to merge" | Another agent lives in that repository. Create a new one for this agent |
| The two sides look out of sync | Sync runs on events: wait for its next wake-up or conversation, or tap "Sync now" under **Control → Advanced → Sync** |

## The web console (Linux)

- `http://127.0.0.1:7788/` asks for a pairing code: the gateway skips the code only for a browser on **the same machine** that uses `127.0.0.1` or `localhost`; a LAN IP or hostname does not count. From another machine, you have three options: forward the port with `ssh -L 7788:127.0.0.1:7788 <that machine>` and open the address locally; with `--lan`, open `https://<that machine's address>:7789/`, check the certificate fingerprint and pair with a code; or pair from the app.
- The app says "运行基座已改为加密连接，请重新配对" (the runtime now requires an encrypted connection): older app versions saved `http://<address>:7788`, and a new runtime only accepts HTTPS on the LAN. Save the new address on the pairing page (an IP is enough; `https://…:7789` is used automatically), check the certificate fingerprint and pair again.
- Blank page or boxes instead of Chinese: check the service with `quetzal status` and hard-refresh the browser. The web build ships its own CJK font and needs no internet for it.
- The browser did not open after installing: without a desktop session (server, ssh login) only the address is printed; try `quetzal open`.
- The one-line installer failed midway: it prints the tail of its log, and the full log is `~/.quetzal/install.log`. Fix the cause and rerun the same command (it is idempotent). A locked `apt` usually means the system is updating in the background; wait a few minutes. On Alpine run `apk add bash curl` first; on NixOS provide Node.js 22.13+ yourself (nvm's binaries do not run there).
- It did not wake up after a reboot: if `loginctl show-user $USER -p Linger` is not `yes`, run `sudo loginctl enable-linger $USER` (user services do not run without a login session by default). On machines without systemd, check `crontab -l` for `@reboot …/quetzal-supervise`; without a cron daemon, start it by hand after boot.
- The Quetzal entry in the app list opens an ordinary browser tab and the taskbar shows no Quetzal icon: a separate window needs a Chromium-family browser (Chrome / Chromium / Edge / Brave / Vivaldi); with only Firefox it opens in the default browser.

## Windows

- Installation is blocked and there is no "Run anyway": the PC has Smart App Control on. The one-line command opens Windows Security → App & browser control → Smart App Control and asks you to turn it off, then continues. For a SmartScreen warning on an installer downloaded in a browser, click More info → Run anyway.
- The agent's commands never run: the sandbox is not set up, for example because the administrator prompt during installation was declined. Run the installation again as the console says.
- The agent does not run after a restart until someone signs in: the account lacks the "Log on as a batch job" right, so the boot task was not registered and only the sign-in task exists. The installation log says so.
- The agent says "someone needs to sign in to the desktop": screenshots, notifications, the clipboard, opening web pages, playing sounds, taking photos and recording need someone signed in to Windows, with Quetzal in the tray.
- Logs: `quetzal logs` (`home\logs\runtime.log`); `quetzal status` shows the version and the supervision tasks.

More in [Windows](/docs/advanced/windows).

## Still stuck

Open an issue at [GitHub Issues](https://github.com/PlutoKeating/Project.Quetzal/issues) describing the symptom, with the version shown under **Control → Advanced → Runtime** and the relevant log (strip personal information from the log first).
