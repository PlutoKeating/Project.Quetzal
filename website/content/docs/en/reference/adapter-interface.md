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

/** A point on the screen. Coordinates are full-screenshot pixels (origin at the top-left of the screenshot); the adapter handles multi-display offsets and DPI. */
interface ScreenPoint { x: number; y: number; ref?: string }   // ref: the reference snapshot() gave the element, passed back when acting by number

/** One element of the accessibility tree (bounding box in screen pixels). */
interface ScreenElement {
  role: string;   // button, link, text, input, checkbox, radio, switch, combobox, slider, tab, menu, menuitem, list, item, image, toolbar, dialog, window, group, scroll, other
  name?: string; value?: string;                       // visible text / text in a field (never a password field's)
  x: number; y: number; w: number; h: number; ref?: string;
  clickable?: boolean; editable?: boolean; scrollable?: boolean;
  enabled?: boolean; focused?: boolean; selected?: boolean; checked?: boolean;
}
interface ScreenSnapshot { width: number; height: number; app?: string; window?: string; elements: ScreenElement[]; note?: string }

/** Hands: see and operate the screen and other apps. Bodies without a screen leave it out. Throw an error that says how to make it work. */
interface Hands {
  status(): Promise<{ ready: boolean; reason?: string; screenshot: boolean; tree: boolean; input: boolean; detail?: string }>;
  screenshot(maxEdge?: number): Promise<{ file: string; width: number; height: number }>;  // width / height in screen pixels
  snapshot(): Promise<ScreenSnapshot>;                                                       // accessibility tree of the foreground window
  click(at: ScreenPoint, opts?: { button?: "left" | "right" | "middle"; count?: number; holdMs?: number }): Promise<void>;
  drag(from: ScreenPoint, to: ScreenPoint, durationMs?: number): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", amount: number, at?: ScreenPoint): Promise<void>;
  type(text: string, at?: ScreenPoint): Promise<void>;
  key(keys: string[]): Promise<void>;          // ["ctrl", "c"], ["enter"], ["back"]: modifiers first
  openApp(id: string): Promise<string>;        // installed apps only
  windows?(): Promise<{ id: string; title: string; app?: string; focused?: boolean }[]>;
  focusWindow?(id: string): Promise<void>;
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
  deviceId?(): Promise<string | undefined>;              // the device's own stable identifier; the core only uses its hash to derive the body uuid, the raw value never leaves
  onNetworkChange?(cb: (detail: string) => void): () => void; // called as soon as the platform sees the default network change; the mesh then checks its connections at once (a 5-second poll is the fallback)
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
- `hands` actions are performed directly by the runtime process, not inside the agent's command sandbox: `openApp` opens installed apps only and must not become a way to run arbitrary programs. From `hands` the core provides `screen_read`, `screen_capture`, `screen_click`, `screen_drag`, `screen_scroll`, `screen_type`, `screen_key` and `app_open` (plus `window_list` / `window_focus` when `windows` / `focusWindow` exist), all under **Screen and apps**; see [Operating the screen](/docs/guide/screen).
- `deviceId()` returns sensitive data: the adapter itself must not write it to logs or tool results either; return `undefined` when it is unavailable (the runtime then uses a random uuid for now and switches to the derived one once the identifier becomes available). See [Multiple bodies · Body uuid](/docs/guide/multi-body).

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
| Device identifier `deviceId()` | `Settings.Secure.ANDROID_ID` (body interface `GET /v1/device-id`); changes after a factory reset or if the App's signing key changes |
| Network changes `onNetworkChange()` | the App registers the system's default-network callback and reports switches between Wi-Fi and mobile data, or losing and regaining the network, at once (body interface `POST /v1/network`, long poll) |
| Hands `hands` | The app's accessibility service `HandsService` (the user turns on "Quetzal 操作屏幕" in system settings): reading the node tree, node actions and gestures (tap, long press, swipe), typing at the cursor, global actions (back, home, recents, notification shade, lock), opening apps by name or package, screenshots (Android 11+); body interface `/v1/hands/…`. While it is off, every action says how to turn it on |

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
| Device identifier `deviceId()` | tries `settings get secure android_id`; on most phones Termux is not allowed to read it |

It is a **platform** adapter: it works on any Android phone with Termux:API, detects everything at run time, and contains no code for a specific device.

## The Linux adapter (`runtime/adapters/linux/`, built as `dist/linux.mjs`)

Installed by the npm package `@plutokeating/quetzal` (`npx @plutokeating/quetzal`). It is a platform adapter too: it works on any Linux computer or server and detects everything at run time.

| Capability | Implementation |
|---|---|
| `sample()` | `/sys/class/power_supply`: level / charging / health (peripheral batteries such as Bluetooth mice are skipped; "Not charging" with mains online counts as charging), the battery's own temperature (`temp`, rare on laptops); `extra`: CPU temperature (`/sys/class/thermal`, not treated as body temperature) and power source. Desktops and servers without a battery report extra only |
| `describe` | Distribution (`/etc/os-release`), laptop or not, desktop session or not, camera (`/dev/video0`) and sound card (`/proc/asound/cards`) |
| `notify()` | `notify-send` when a desktop is present; always written to stdout (the service log) too, so a headless machine reads the pairing code from `quetzal logs` |
| `playAudio()` / `stopAudio()` | `pw-play` / `paplay` / `ffplay` / `mpv`, plus `aplay` for WAV; plays in the background and returns at once |
| Tools | `take_photo` (camera: `ffmpeg` on `/dev/video0`), `record_audio` (microphone: `arecord` / `pw-record` / `parecord` / `ffmpeg`, WAV), `clipboard` (device: `wl-clipboard` / `xclip` / `xsel`), `open` (device: `xdg-open`) |
| Hands `hands` | Only with a desktop session. Elements: AT-SPI (`python3` + gi's Atspi 2.0); clicks and typing: `xdotool` on X11, `ydotool` (needs `ydotoold`) / `wtype` (keys and typing only) on Wayland, falling back to AT-SPI actions on elements it has read; screenshots: `grim` / `gnome-screenshot` / `spectacle` on Wayland, `scrot` / `gnome-screenshot` / `spectacle` / `import` on X11; windows: `wmctrl` on X11; opening apps: `.desktop` entries only (`gtk-launch` / `gio launch` / `kioclient`). When the service environment lacks `DISPLAY` and friends, it fills them in from `XDG_RUNTIME_DIR` and `/tmp/.X11-unix` |
| Upgrade from the console `upgrade()` | Reruns `curl -fsSL …/install \| bash -s -- --no-open` in the background: with systemd via a transient `systemd-run --user` unit (outside the quetzal service's cgroup, otherwise restarting the service would kill it), otherwise via `setsid`; log `~/.quetzal/logs/upgrade.log` |
| Supervision switch `supervision` | The systemd user service `quetzal.service` (off = `systemctl --user disable` + a drop-in `quetzal.service.d/quetzal-off.conf` with `Restart=no`, effective right after daemon-reload); without systemd, the one-line installer's supervisor loop `~/.quetzal/bin/quetzal-supervise` (off = the flag file `state/supervise.off`, which pauses the loop, + removing the crontab `@reboot` line and the desktop autostart entry); with neither (manual deployment) `available=false` |
| `speak` | Not provided; speech comes from the runtime's `voice_speak` |
| Media location | `QUETZAL_HOME/data/media/` |
| Device identifier `deviceId()` | `/etc/machine-id`, or `/var/lib/dbus/machine-id`; changes when the OS is reinstalled |

On a headless server the clipboard and open tools report that the machine has no graphical session, and there are no `hands`, so the screen tools do not appear.

## The Windows adapter (`runtime/adapters/windows/`, built as `dist/windows.mjs`)

Installed by the Windows one-liner or installer; see [Windows](/docs/advanced/windows). It is a platform adapter: it works on any Windows 10 1809 or later / Windows 11 PC (x64, arm64), detects everything at run time and installs nothing, using the built-in PowerShell 5.1, .NET Framework and WinRT.

The runtime started at boot runs in session 0 and cannot see the desktop. Desktop work (notifications, screenshots and screen control, clipboard, open, playback, photos, recording) then goes through the body helper `windows-body.mjs`, which the console tray starts after sign-in (127.0.0.1, random port and token in `secrets\desktop-body.json`). When the runtime itself runs in the signed-in desktop, it does this work directly. With nobody signed in, these tools say that someone needs to sign in to Windows.

| Capability | Implementation |
|---|---|
| `sample()` | System power status (`SystemInformation.PowerStatus`, readable in session 0): level / charging; `extra`: power source, and temperature only when an ACPI thermal zone is readable (not treated as body temperature). PCs without a battery report extra only |
| `describe` | Windows edition (`Win32_OperatingSystem`), laptop or not, running in the signed-in desktop or in the background from boot, camera and sound devices (Plug and Play) |
| `notify()` | Toast notification; with nobody signed in it is written to the log instead, so the pairing code can be read from `quetzal logs` |
| `playAudio()` / `stopAudio()` | WPF `MediaPlayer`; plays in the background and returns at once |
| Tools | `take_photo` (camera: WinRT `MediaCapture`, falling back to `ffmpeg` dshow), `record_audio` (microphone: WAV, up to 120 s), `clipboard` (device), `open` (device: URLs and ordinary documents, images, audio/video files and folders with the default program; programs and scripts are refused) |
| Hands `hands` | Elements: UI Automation (a CacheRequest fetches the control view of the foreground window); clicks and typing: `SendInput` / `SetCursorPos` (per-monitor DPI aware, any Unicode text); screenshots: all displays, shrunk when asked and saved as JPEG; windows: UI Automation top-level windows, switched with `SetForegroundWindow`; opening apps: Start menu apps only (`Get-StartApps`). Windows running as administrator, UAC prompts and the lock screen do not accept simulated input |
| Upgrade from the console `upgrade()` | Reruns `install.ps1` in the background, detached from the runtime's process tree (through the body helper when someone is signed in, so the administrator prompt can appear); log `logs\upgrade.log` in the same format as on Linux |
| Supervision switch `supervision` | Scheduled tasks `\Quetzal\Runtime-Boot` and `\Quetzal\Runtime-Logon`, both running `windows-supervise.mjs` (off = the flag file `state\supervise.off` plus an attempt to disable both tasks) |
| `speak` | Not provided; speech comes from the runtime's `voice_speak` |
| Media location | `QUETZAL_HOME\data\media\` |
| Device identifier `deviceId()` | registry `HKLM\SOFTWARE\Microsoft\Cryptography` `MachineGuid` (`reg.exe query`); changes when Windows is reinstalled |

To write a new adapter, see [Custom body adapter](/docs/advanced/custom-adapter).
