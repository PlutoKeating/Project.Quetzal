---
title: Adapter interface
description: The full types of BodyAdapter, RawSample, AdapterTool and Hands, how adapters are loaded, their constraints, and what the Termux adapter provides.
---

## Types

Defined in `runtime/src/body/adapter.ts`. An adapter is an independently built ES module whose **default export** is a `BodyAdapter`.

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
  tools?: AdapterTool[];
  hands?: Hands;
}
```

## Loading

| Source | Notes |
|---|---|
| Environment variable `QUETZAL_ADAPTER` | Module path (used by the Termux deployment) |
| Config `adapter` | Path in `config/quetzal.json` |
| Neither / load failure | Falls back to the `generic` adapter (no sensors; `sample()` returns an empty object) |

## Constraints

- An adapter may **only `import type`** from the interface file and must not depend on any other part of the core.
- `tools[].permission` must be a category the guard knows; otherwise it is treated as "allow".
- `notify` is the local outlet for pairing codes and proactive messages; without it the pairing code can only be read from `secrets/gateway.token`.

## How samples are used

- `startSenses` calls `sample()` periodically, adapting between 2 and 10 minutes, and never calls a model.
- Readings join OS information in the body twin, derive body feelings, and produce sense events by comparison with the previous sample; events adjust drives and trigger re-sampling.
- `extra` appears verbatim in the "body" section she sees.

## The Termux adapter (`runtime/adapters/termux/`, built as `dist/termux.mjs`)

| Capability | Implementation |
|---|---|
| `sample()` | `termux-battery-status` (level / charging / temperature / health), `termux-sensor` (light and motion; sensors detected by name, absent ones not reported) |
| `notify()` | System notification with an "Open Quetzal" button (`QUETZAL_CONSOLE_ACTIVITY`, default `xyz.quetzal.console/.MainActivity`) |
| `playAudio()` | `termux-media-player` |
| Tools | `take_photo` (camera), `record_audio` (microphone), `location` (location), `vibrate` / `torch` / `clipboard` / `read_sensor` (device) |
| `speak` | Not provided (many phones lack a system TTS); speech comes from the runtime's `voice_speak` |
| Media location | `QUETZAL_HOME/data/media/` |

It is a **platform-level** adapter: any Android phone plus Termux:API, everything by detection, with no device-specific code.

## The Linux adapter (`runtime/adapters/linux/`, built as `dist/linux.mjs`)

Installed by the npm package `@plutokeating/quetzal` (`npx @plutokeating/quetzal`); platform-level too: any Linux computer or server, everything by detection.

| Capability | Implementation |
|---|---|
| `sample()` | `/sys/class/power_supply`: level / charging / health (peripheral batteries such as Bluetooth mice are skipped; "Not charging" with mains online counts as charging), the battery's own temperature (`temp`, rare on laptops); `extra`: CPU temperature (`/sys/class/thermal`, not treated as body temperature) and power source. Desktops and servers without a battery report extra only |
| `describe` | Distribution (`/etc/os-release`), laptop or not, desktop session or not, camera (`/dev/video0`) and sound card (`/proc/asound/cards`) |
| `notify()` | `notify-send` when a desktop is present; always written to stdout (the service log) too, so a headless machine reads the pairing code from `quetzal logs` |
| `playAudio()` / `stopAudio()` | `pw-play` / `paplay` / `ffplay` / `mpv`, plus `aplay` for WAV; plays in the background and returns at once |
| Tools | `take_photo` (camera: `ffmpeg` on `/dev/video0`), `record_audio` (microphone: `arecord` / `pw-record` / `parecord` / `ffmpeg`, WAV), `screenshot` (hands: `grim` / `gnome-screenshot` / `spectacle` on Wayland, `scrot` / `gnome-screenshot` / `spectacle` / `import` on X11), `clipboard` (device: `wl-clipboard` / `xclip` / `xsel`), `open` (device: `xdg-open`) |
| `speak` | Not provided; speech comes from the runtime's `voice_speak` |
| Media location | `QUETZAL_HOME/data/media/` |

On a headless server the screenshot, clipboard and open tools simply say that the machine has no graphical session instead of failing. To write a new one see [Custom body adapter](/docs/advanced/custom-adapter).
