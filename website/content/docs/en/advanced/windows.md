---
title: Windows
description: A Windows 10 (1809 or later) or Windows 11 computer can be a body too. One PowerShell line or one installer, with a single administrator prompt during installation. It keeps running in the background after a restart without anyone signing in, and appears in the tray once you sign in. The agent's commands run as a separate low-privilege user that can only reach %USERPROFILE%\Quetzal.
---

## 1. Install

In PowerShell, run:

```powershell
irm https://quetzal.plutokeating.beer/install.ps1 | iex
```

Or download `quetzal-<version>-windows-x64-setup.exe` (`arm64` for ARM PCs) from the [download page](/download) and double-click it. Both install the same package; the one-liner first checks the release signature and hash, then runs it silently.

Requirements: Windows 10 1809 or later, or Windows 11; x64 or arm64.

Installation shows **one** administrator prompt, for the things that need administrator rights:

- creating a low-privilege local user `srt-sandbox`, plus firewall rules that let it reach the network only through a proxy (the agent's commands run as this user; see section 3);
- installing Node.js (22.13 or later), Git and Python 3 if they are missing, using the official installers bundled in the package (Node.js 24, Git for Windows, Python 3.14) into Program Files so the sandbox user can read them; existing installations are left alone;
- registering two scheduled tasks that start the runtime: one at boot (no sign-in needed) and one at sign-in.

Files go to `%LOCALAPPDATA%\Quetzal`:

```
%LOCALAPPDATA%\Quetzal\
├── home\                 home directory: config, keys, data, soul folder (same as ~/.quetzal on Linux)
├── runtime\<version>\    the runtime; current.txt names the version in use, previous.txt the one before
├── console\<version>\    the console (quetzal-console.exe); current.txt as above
├── bin\                  the quetzal.cmd command and the scheduled tasks' launcher
└── node.txt              where the runtime's node.exe is
```

When it finishes, the console opens and a wizard walks you through sign-in and a model, the same as on a phone.

## 2. How it stays on

- **Runs from boot**: the scheduled task `\Quetzal\Runtime-Boot` starts the runtime at boot as you (S4U, no password stored). If the PC crashes and restarts with nobody signed in, the agent is still running in the background; you can talk to it and use the emergency stop from your phone as usual.
- **After sign-in**: Quetzal appears in the tray (closing the window only hides it). The runtime started at boot cannot see the desktop, so screenshots, notifications, the clipboard, opening web pages, playing sound, photos and recordings go through a "body helper" the tray starts after sign-in. With nobody signed in, the agent says plainly that someone needs to sign in.
- **Crash restart**: the supervisor restarts the runtime 3 seconds after it exits, and waits longer if it keeps exiting within 10 minutes. The Supervision switch under Advanced · Run in the console turns this off.
- **Upgrade**: one tap under About in the console. The installer closes the running Quetzal (you agreed to this when you tapped), and if the new version is not healthy within 40 seconds it goes back to the previous one.
- **Uninstall**: "Uninstall Quetzal" in the Start menu, or Settings → Apps. Configuration and memories in `home\` are kept by default.

On some PCs the account lacks the "Log on as a batch job" right and the boot task cannot be registered; then only the sign-in task exists, and the agent runs only after someone signs in. The install log says so.

## 3. What the agent can reach

The agent's commands run in PowerShell (PowerShell 7 if installed, otherwise the built-in 5.1), and they do not run as you: they run as the `srt-sandbox` user created at install time ([sandbox-runtime](https://github.com/anthropics/sandbox-runtime), Anthropic's open-source sandbox, Apache-2.0).

| | Can | Cannot |
|---|---|---|
| Files | read and write `%USERPROFILE%\Quetzal` (the commands' working folder; files you put there are what it can work on), `data\` and the soul folder in the home directory; read the secret vault, its own tools, and Node / Git / Python | read or write other files in your user folder; see the runtime's key folder or configuration; change the soul folder's `.git` |
| Network | reach the internet and your local network through the runtime's proxy | connect directly (the system firewall blocks it); connect to this PC's own ports (the local gateway lives there) |
| Processes | its own commands and background jobs | stop the runtime, touch other users' processes |

To let it reach another folder, add the absolute path to `sandbox.share` in `home\config\quetzal.json` (takes effect after the runtime restarts).

If the sandbox is not installed (for example the administrator prompt was declined), the agent's commands do not run at all, and the console asks you to run the installer again.

**The remaining risks**, stated plainly:

- The `srt-sandbox` user is shared by every program on this PC that uses sandbox-runtime (Claude Code, for example). Access granted to it while Quetzal runs applies to them too.
- Commands in the sandbox can resolve domain names (connections are still blocked), and the proxy token appears on a command line that other programs in the same session can read.
- The installer and the sandbox program `srt-win.exe` sit in your user folder, so malware already running as you could replace them before the administrator prompt appears. Any per-user install that later asks for administrator rights has this problem.
- The tools that read documents and view images do not go through the sandbox; the runtime blocks the key folder and the secret vault by resolving the real path.

## 4. Signing and Smart App Control

The installer, the console and `srt-win.exe` are **not code-signed yet** (an application for free open-source signing is pending). Integrity comes from the release signature: each release's `SHA256SUMS` carries an Ed25519 signature, which the one-liner checks first.

- An installer downloaded in a browser gets a SmartScreen warning, "Windows protected your PC": click "More info" → "Run anyway".
- A PC with Smart App Control on blocks unsigned programs outright, with no "Run anyway". The one-liner detects this, opens Windows Security → App & browser control → Smart App Control and asks you to turn it off before continuing.

## 5. Command line

```powershell
quetzal status      # version, scheduled tasks, LAN address and certificate fingerprint
quetzal open        # open the console
quetzal logs        # the runtime's log (home\logs\runtime.log)
quetzal restart     # restart the runtime
quetzal rollback    # go back to the previous version
quetzal uninstall   # uninstall
```

## 6. Not there yet

- soul-bridge (Hermes, OpenClaw) does not support native Windows; use the Linux version inside WSL2.
- The desktop ear has no echo cancellation: it does not listen while the agent speaks, and you cannot interrupt the agent by talking.
- Photos and recordings follow Settings → Privacy & security → Camera / Microphone; desktop apps must be allowed.
