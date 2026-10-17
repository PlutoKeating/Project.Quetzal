---
title: macOS
description: A Mac (macOS 12 or later, Intel or Apple silicon) can be a body too. One line in Terminal, and launchd keeps it running once you log in. The agent's commands run in the built-in macOS sandbox and cannot see the keys; with Accessibility and Screen Recording permission it can also see the screen, click and type.
---

## 1. Install

Requirements: macOS 12 or later, Intel or Apple silicon. In Terminal, run the same command as on Linux:

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

It will:

- **Add git**: git comes with Apple's Xcode Command Line Tools. If they are missing, macOS shows an installer dialog; click Install, then run the same command again (you do not need Xcode itself).
- **Add Node.js**: without Node.js 22.13 or later, it installs one through nvm into `~/.nvm`, leaving any other Node on the system alone.
- **Install the runtime**: the npm package goes into `~/.quetzal/npm` and the runtime into `~/.quetzal/releases/<version>/`; you get a `quetzal` command in the terminal.
- **Register supervision**: a launchd agent, `~/Library/LaunchAgents/xyz.quetzal.runtime.plist`.
- **Open the console**: `http://127.0.0.1:7788/` in your browser. A browser on this Mac is signed in on open. The wizard walks you through signing in and choosing a model, the same as on the phone.

The home directory is `~/.quetzal`, as on Linux (configuration, keys, data and the soul directory); change it with `--home DIR` or the `QUETZAL_HOME` environment variable. The options are the same as on Linux (`--lan`, `--no-open`, `--version X`, `--lang zh|en` and so on), passed after `bash -s --`.

## 2. How it stays running

- **Runs after login**: launchd starts the runtime once you log in to this Mac and restarts it 3 seconds after any exit; if it keeps exiting within 10 minutes it enters safe mode. launchd agents follow the login session, so it does not run while nobody is logged in to the desktop. To have it wake at boot, turn on automatic login in System Settings › Users & Groups.
- **Console**: the web version served by the gateway, with the same features as the app. `quetzal open` opens it again. There is no native desktop console for the Mac yet.
- **Supervision switch**: with the Supervision switch under Advanced · Running in the console turned off, the runtime is not restarted after it exits and does not start at the next login.
- **Upgrade**: one click under About in the console, or run the install command again. If the new version is not healthy within 40 seconds, it rolls back to the previous one.
- **Commands**: `quetzal status`, `quetzal logs -f` (the log is `~/.quetzal/logs/runtime.log`), `quetzal start` / `stop` / `restart`, `quetzal rollback`.
- **Uninstall**: `curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall`. The home directory is kept unless you add `--purge`. nvm, Node.js and git are left in place.

## 3. Letting it see the screen, click and type

To use the screen it relies on what macOS already has: `screencapture` for screenshots, the Accessibility interface of System Events to read the buttons, text and fields in a window, and system input events to click, drag, scroll and press keys. If the open-source `cliclick` is installed (`brew install cliclick`), plain clicks go through it.

macOS needs you to grant this yourself:

1. Open System Settings › Privacy & Security › **Accessibility**, click +, and add the node the runtime uses. The installer prints its path at the end (for example `~/.nvm/versions/node/v22.x/bin/node`); press ⌘⇧G in the file dialog to paste it.
2. Add it under **Screen & System Audio Recording** on the same page as well (called Screen Recording on older systems). Without it, screenshots only show the desktop and the menu bar.
3. Run `quetzal restart`.
4. The first time it reads a window, macOS asks whether node may control System Events; click Allow (you can change it later under Privacy & Security › Automation).

Until permission is granted, it tells you which one is missing and where to turn it on, and opens that page on this Mac. Using the screen is reviewed by default: an independent review model checks each action first without bothering you; switch it to "ask" to approve each action yourself. See [Operating the screen](/docs/guide/screen) and [Permissions](/docs/guide/permissions).

It only sees the main display. The coordinates on the screenshot are the ones it clicks; Quetzal handles the Retina scaling.

## 4. What it can reach

Its commands run in the macOS built-in sandbox (`sandbox-exec`). The rules are generated per command by [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (open-sourced by Anthropic, Apache-2.0), so nothing extra is installed:

| | Can | Cannot |
|---|---|---|
| Files | Read and write your home folder (except `~/.quetzal`) and temporary folders; read the configuration, data and soul directory in `~/.quetzal`, and the vault | See the key directory `~/.quetzal/secrets`, browser profiles (your website sign-ins) or keychain files; change `~/.quetzal`; change shell startup files, `~/.ssh`, git configuration or `~/Library/LaunchAgents` (things that run outside the sandbox) |
| Network | Reach the internet and the local network through a proxy inside the runtime | Connect to this Mac's own ports (the local gateway lives there); programs that ignore proxy settings (such as `ssh`) cannot get out |
| Other apps | Nothing | Control other apps with AppleScript (Apple events cannot be sent from the sandbox) |

To let it write another folder (an external drive, say), add its absolute path to `sandbox.share` in `~/.quetzal/config/quetzal.json` and restart the runtime.

Before the sandbox is used for the first time after each start, the runtime checks it for real: if the key directory is readable or `~/.quetzal` is writable inside it, the sandbox is not used. When no sandbox is usable, none of its commands run and the console says why.

> [!NOTE]
> The sandbox allows the system security service, so keychain items set to "allow all applications to access" can be read by its commands. Apple marks `sandbox-exec` as deprecated, though it still works; if a future macOS removes it, its commands stop and say why rather than running outside the sandbox.

## 5. Several bodies

Direct links between the Mac and other bodies use the same native component as on Linux (built for Intel and Apple silicon), downloaded and checked against pinned hashes during installation. If it cannot be installed, everything else still works and the bodies sync through git only. See [Multiple bodies](/docs/guide/multi-body).
