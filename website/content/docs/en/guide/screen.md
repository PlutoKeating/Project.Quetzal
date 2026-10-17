---
title: Operating the screen
description: How the agent reads the screen, taps, types and opens apps; what each of phone, Linux and Windows needs; and how to keep it in check.
---

The agent can use this device's screen the way you do: see what is on it, tap buttons, swipe, type, press shortcuts and open apps. This works on phones and computers, and the agent on another device can borrow this device's screen (see [Multiple bodies](/docs/guide/multi-body)).

## How it sees the screen

First it **reads the elements on the screen**: the buttons, text and input fields visible in the foreground window, each with a number and a position. This needs no image model, is fast and accurate, and the agent taps and types by number.

Some screens expose no elements: games, videos, apps that draw their own interface, or Chromium / Electron apps without accessibility turned on. Then the agent **takes a screenshot**, shrunk to 1280 pixels on the long edge, and gives it to a model that can see images. It taps by position on the picture.

What it can do:

| Action | Notes |
|---|---|
| Read the screen | Lists the elements; can take a screenshot at the same time |
| Screenshot | The whole screen; several displays become one picture |
| Click | Click, double-click, right-click, long press |
| Drag, scroll | Drag, swipe; scroll by wheel notches |
| Type | Text in any language; can tap a field first and press Enter afterwards |
| Keys | Shortcuts such as `ctrl+c` and `alt+tab`; on a phone, back, home, recents and the notification shade |
| Open an app | By name or package name, installed apps only |
| Windows | List windows and bring one to the front (computers) |

## Keeping it in check

- **Ask every time, by default.** All of these belong to **Screen and apps** ([Permissions](/docs/guide/permissions)). Every action asks you in the console and in Feishu, and happens only after you approve. Switch it to allow once you trust it.
- **Refused during an emergency stop.** Every action is written to the action log.
- **It is not sandboxed.** The runtime performs these actions directly, as if you were sitting at the screen: a command the agent types into a terminal does not go through the command sandbox. That is why it asks by default; read the request before you approve it.
- **Opening apps only works for installed apps**; it cannot run arbitrary programs.
- **Passwords and verification codes** are not typed for you; when a sign-in is needed, the agent asks you to do it.
- **Screen content goes to the model.** The text it reads and the screenshots are sent to your model provider, like the conversation.

## Phone

This needs the Quetzal app's **accessibility service**. On the "Operate the screen" card at the top of **Control → Permissions**, tap "Turn on" and enable "Quetzal 操作屏幕" in system settings.

- **The switch is greyed out**: from Android 13, apps not installed from an app store get this. Tap "App info" on the card, choose "Allow restricted settings" in the top-right menu, then come back and turn it on.
- **Screenshots need Android 11 or later.** Older systems can read elements but not take screenshots.
- The service records nothing in the background; it reads the current screen once, only when the agent asks. Turn it off in system settings whenever you like.
- Some screens forbid screenshots (banking apps, for example) and come out black.

## Linux

Someone must be signed in to a graphical desktop. The runtime uses whatever programs the computer has and tells you plainly what is missing:

| Purpose | X11 | Wayland |
|---|---|---|
| Click and type | `xdotool` | `ydotool` (needs `ydotoold` running and write access to `/dev/uinput`); `wtype` for keys and typing only |
| Read elements | AT-SPI: packages like `python3-gi` and `gir1.2-atspi-2.0` (most desktops ship them) | Same |
| Screenshot | `scrot`, `gnome-screenshot`, `spectacle` or ImageMagick | `grim`, `gnome-screenshot` or `spectacle` |
| Windows | `wmctrl` | Listing only; switch with `alt+tab` |

- GNOME's Wayland session does not support `wtype`; use `ydotool`, or choose an X11 session at sign-in.
- Under Wayland some apps report positions relative to their window; when a tap misses, the agent checks with a screenshot first.
- Chromium and Electron apps expose elements only with accessibility turned on (for example the `--force-renderer-accessibility` flag); otherwise the agent looks at a screenshot.
- Servers without a graphical session do not offer these actions.

## Windows

Nothing to install: it uses the built-in PowerShell and UI Automation to read elements, and simulates the mouse and keyboard.

- When the runtime starts at boot it runs in the background and cannot see the desktop. Once someone signs in and the tray icon appears, the body helper in the desktop performs these actions. With nobody signed in, the agent tells you someone needs to sign in.
- **Windows running as administrator, UAC prompts and the lock screen** do not accept this simulated input. This is a Windows restriction.
- Opening apps only works for apps in the Start menu.
