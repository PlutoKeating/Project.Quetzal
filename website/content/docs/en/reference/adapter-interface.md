---
title: Adapter interface
description: The full types of BodyAdapter, RawSample, AdapterTool and Hands, how adapters are loaded, their constraints, and what the Android, Termux, Linux and Windows adapters provide.
---

## Types

Defined in `runtime/src/body/adapter.ts`. An adapter is an ES module, built on its own, whose **default export** is a `BodyAdapter`.

```ts
/** One physical sample. Every field is optional: report what the device has. */
interface RawSample {
  battery?: { level: number; charging: boolean; tempC?: number; health?: string };
  lux?: number;      // ambient light
  motion?: number;   // acceleration deviating from gravity (m/s²)
  screenOn?: boolean;
  extra?: Record<string, string | number | boolean>;  // device-specific readings, passed to the twin as is
}

/** A tool (action) the adapter offers the agent. handler returns text for the model. */
interface AdapterTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  permission: string;                    // guard capability category: device, camera, microphone, location…
  handler: (args: Record<string, any>) => Promise<string>;
}

/** Reserved: operate the screen and other apps. */
interface Hands {
  screenshot(): Promise<string>;         // returns an image path
  describeScreen(): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  type(text: string): Promise<void>;
  openApp(id: string): Promise<void>;
}

interface BodyAdapter {
  name: string;
  describe: string;                      // one sentence about this body, written into the agent's self-image
  init?(): Promise<void>;
  sample(): Promise<RawSample>;
  notify?(title: string, text: string): Promise<void>;   // local system notification
  speak?(text: string): Promise<void>;
  playAudio?(file: string): Promise<void>;               // play an audio file (synthesized speech)
  stopAudio?(): Promise<void>;                           // stop playback (when the person cuts in)
  tools?: AdapterTool[];
  hands?: Hands;
  supervision?: { status(): Promise<SupervisionState>; set(enabled: boolean): Promise<void> };  // supervision switch: start at boot + restart after exit
  quit?(): Promise<void>;                                // quit (the desktop tray's Quit): stop the background service this time
  upgrade?(version?: string): Promise<string>;           // upgrade from the console: rerun the installer in the background
  upgradeStatus?(): { running: boolean; exitCode?: number; step?: string /* … */ };  // state of the latest upgrade
}
```

## Loading

| Source | Notes |
|---|---|
| Environment variable `QUETZAL_ADAPTER` | Module path (used by the Android app and the Termux deployment) |
| Config `adapter` | Path in `config/quetzal.json` |
| Neither / load failure | Falls back to the `generic` adapter (no sensors; `sample()` returns an empty object) |

## Constraints

- An adapter may **only `import type`** from the interface file and must not depend on any other part of the core.
- `tools[].permission` must be a category the guard knows; otherwise it is treated as "allow".
- `notify` is the local outlet for pairing codes and proactive messages; without it the pairing code can only be read from `secrets/gateway.token`.

## How samples are used

- `startSenses` calls `sample()` periodically, adapting between 2 and 10 minutes, and never calls a model.
- The body twin combines readings with OS information and derives body feelings from them. Comparing each sample with the previous one produces sense events, which adjust drives and trigger re-sampling.
- `extra` appears verbatim in the "body" section it sees.

## The Android adapter (`runtime/adapters/android/`, built as `dist/android.mjs`)

Used when the Quetzal app runs the built-in runtime: the body abilities come from the app's own native code and reach the runtime through the local **body interface** (a random port on 127.0.0.1, token-only; port and token in `QUETZAL_HOME/secrets/body.json`, invisible to its sandboxed commands).

| Capability | Implementation (app side) |
|---|---|
| `sample()` | Battery broadcast (level / charging / temperature / health / power source), light and accelerometer sensors (one reading each, absent ones not reported), screen on |
| `notify()` | System notification that opens the app |
| `playAudio()` / `stopAudio()` | The system media player |
| Tools | `take_photo` (Camera2 capture without preview), `record_audio` (system recorder), `location` (network location; GPS too when precise location is granted; when neither gets a fix, the last known location with how long ago it was), `vibrate` / `torch` / `clipboard` / `read_sensor` (device) |
| Supervision | The app foreground service's switch: start at boot and after app updates, restart after exit (`kind: loop`) |
| File paths | Photo and recording output and playback input must stay inside `QUETZAL_HOME` |

Camera, microphone and location need the system permissions granted in the app (step two of the setup wizard). Without them the tools report an error and the agent asks you to allow them. Like the others, it is a **platform** adapter: it works on any Android phone and detects everything at run time.

## The Termux adapter (`runtime/adapters/termux/`, built as `dist/termux.mjs`)

Used by installs made the Termux way in 1.0.x and kept for them; new installs use the Android adapter above.

| Capability | Implementation |
|---|---|
| `sample()` | `termux-battery-status` (level / charging / temperature / health), `termux-sensor` (light and motion; sensors detected by name, absent ones not reported) |
| `notify()` | System notification with an "Open Quetzal" button (`QUETZAL_CONSOLE_ACTIVITY`, default `xyz.quetzal.console/.MainActivity`) |
| `playAudio()` | `termux-media-player` |
| Tools | `take_photo` (camera), `record_audio` (microphone), `location` (location), `vibrate` / `torch` / `clipboard` / `read_sensor` (device) |
| `speak` | Not provided (many phones lack a system TTS); speech comes from the runtime's `voice_speak` |
| Media location | `QUETZAL_HOME/data/media/` |

It is a **platform** adapter: it works on any Android phone with Termux:API, detects everything at run time, and contains no code for a specific device.

## The Linux adapter (`runtime/adapters/linux/`, built as `dist/linux.mjs`)

Installed by the npm package `@plutokeating/quetzal` (`npx @plutokeating/quetzal`). It is a platform adapter too: it works on any Linux computer or server and detects everything at run time.

| Capability | Implementation |
|---|---|
| `sample()` | `/sys/class/power_supply`: level / charging / health (peripheral batteries such as Bluetooth mice are skipped; "Not charging" with mains online counts as charging), the battery's own temperature (`temp`, rare on laptops); `extra`: CPU temperature (`/sys/class/thermal`, not treated as body temperature) and power source. Desktops and servers without a battery report extra only |
| `describe` | Distribution (`/etc/os-release`), laptop or not, desktop session or not, camera (`/dev/video0`) and sound card (`/proc/asound/cards`) |
| `notify()` | `notify-send` when a desktop is present; always written to stdout (the service log) too, so a headless machine reads the pairing code from `quetzal logs` |
| `playAudio()` / `stopAudio()` | `pw-play` / `paplay` / `ffplay` / `mpv`, plus `aplay` for WAV; plays in the background and returns at once |
| Tools | `take_photo` (camera: `ffmpeg` on `/dev/video0`), `record_audio` (microphone: `arecord` / `pw-record` / `parecord` / `ffmpeg`, WAV), `screenshot` (hands: `grim` / `gnome-screenshot` / `spectacle` on Wayland, `scrot` / `gnome-screenshot` / `spectacle` / `import` on X11), `clipboard` (device: `wl-clipboard` / `xclip` / `xsel`), `open` (device: `xdg-open`) |
| Upgrade from the console `upgrade()` | Reruns `curl -fsSL …/install \| bash -s -- --no-open` in the background: with systemd via a transient `systemd-run --user` unit (outside the quetzal service's cgroup, otherwise restarting the service would kill it), otherwise via `setsid`; log `~/.quetzal/logs/upgrade.log` |
| Supervision switch `supervision` | The systemd user service `quetzal.service` (off = `systemctl --user disable` + a drop-in `quetzal.service.d/quetzal-off.conf` with `Restart=no`, effective right after daemon-reload); without systemd, the one-line installer's supervisor loop `~/.quetzal/bin/quetzal-supervise` (off = the flag file `state/supervise.off`, which pauses the loop, + removing the crontab `@reboot` line and the desktop autostart entry); with neither (manual deployment) `available=false` |
| `speak` | Not provided; speech comes from the runtime's `voice_speak` |
| Media location | `QUETZAL_HOME/data/media/` |

On a headless server the screenshot, clipboard and open tools report that the machine has no graphical session.

## The Windows adapter (`runtime/adapters/windows/`, built as `dist/windows.mjs`)

Installed by the Windows one-liner or installer; see [Windows](/docs/advanced/windows). It is a platform adapter: it works on any Windows 10 1809 or later / Windows 11 PC (x64, arm64), detects everything at run time and installs nothing, using the built-in PowerShell 5.1, .NET Framework and WinRT.

The runtime started at boot runs in session 0 and cannot see the desktop. Desktop work (notifications, screenshots, clipboard, open, playback, photos, recording) then goes through the body helper `windows-body.mjs`, which the console tray starts after sign-in (127.0.0.1, random port and token in `secrets\desktop-body.json`). When the runtime itself runs in the signed-in desktop, it does this work directly. With nobody signed in, these tools say that someone needs to sign in to Windows.

| Capability | Implementation |
|---|---|
| `sample()` | System power status (`SystemInformation.PowerStatus`, readable in session 0): level / charging; `extra`: power source, and temperature only when an ACPI thermal zone is readable (not treated as body temperature). PCs without a battery report extra only |
| `describe` | Windows edition (`Win32_OperatingSystem`), laptop or not, running in the signed-in desktop or in the background from boot, camera and sound devices (Plug and Play) |
| `notify()` | Toast notification; with nobody signed in it is written to the log instead, so the pairing code can be read from `quetzal logs` |
| `playAudio()` / `stopAudio()` | WPF `MediaPlayer`; plays in the background and returns at once |
| Tools | `take_photo` (camera: WinRT `MediaCapture`, falling back to `ffmpeg` dshow), `record_audio` (microphone: WAV, up to 120 s), `screenshot` (hands: all displays), `clipboard` (device), `open` (device: URLs and ordinary documents, images, audio/video files and folders with the default program; programs and scripts are refused) |
| Upgrade from the console `upgrade()` | Reruns `install.ps1` in the background, detached from the runtime's process tree (through the body helper when someone is signed in, so the administrator prompt can appear); log `logs\upgrade.log` in the same format as on Linux |
| Supervision switch `supervision` | Scheduled tasks `\Quetzal\Runtime-Boot` and `\Quetzal\Runtime-Logon`, both running `windows-supervise.mjs` (off = the flag file `state\supervise.off` plus an attempt to disable both tasks) |
| `speak` | Not provided; speech comes from the runtime's `voice_speak` |
| Media location | `QUETZAL_HOME\data\media\` |

To write a new adapter, see [Custom body adapter](/docs/advanced/custom-adapter).
