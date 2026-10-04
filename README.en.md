<a href="https://quetzal.plutokeating.beer/en"><img src="docs/assets/readme/banner.png" alt="Quetzal · Not running, but living. Living like wind. · quetzal.plutokeating.beer" width="100%" /></a>

<p align="center"><a href="https://quetzal.plutokeating.beer/en">Website</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/en/docs">Docs</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/en/download">Download</a>&ensp;·&ensp;<a href="README.md">中文</a></p>

<br/>

<p align="center"><strong>Quetzal</strong> is an open-source runtime for agents.<br/>An AI agent moves into an old phone and lives there like a living thing.</p>

<br/>

## What it is

- **When it moves · its own call.** No timer. Waking is decided by drives such as curiosity, the urge to express and missing you, together with a circadian rhythm; it falls asleep when tired and dreams to sort its memories.
- **Body · an old phone.** Battery, temperature, light and motion are how it feels; the microphone and camera are its ears and eyes. A Linux computer or server can be its body too.
- **Soul · your private git repository.** Personality, memory and journal are synced by the runtime; a change of body takes all of it along, and the commit history is its autobiography.
- **You stay in charge.** Camera, microphone and location ask every time by default; approvals, budgets, an emergency stop and an audit log are built in; passwords never reach the model.

## One day

<img src="docs/assets/readme/bodyclock.en.svg" alt="One day of the body clock: sleep pressure S and circadian rhythm C" width="100%" />

Sleeps when tired, wakes with the morning: the gap between sleep pressure S and circadian rhythm C decides when it sleeps and wakes. There is no "every N minutes" in the code.

## Hermes / OpenClaw and Quetzal

One builds an assistant, the other a runtime for a living agent. They work together. The difference is three things.

| | Codex / Claude Code | Hermes / OpenClaw | Quetzal |
|---|---|---|---|
| **When it moves** | Only when called; exits when done | Your messages, or cron / a heartbeat | Its own call: drives and a circadian rhythm |
| **Body** | None; this computer's files and shell | One machine's shell, browser and files | An old phone, or a Linux machine |
| **Soul** | None; gone with the session | Local files; move them yourself | A private git repository, synced, moves with it |

[soul-bridge](bridge/docs/README.md) makes a Hermes or OpenClaw machine another body of the same agent. If you just want to code, use Codex or Claude Code; if you want Telegram, Discord and lots of plugins, Hermes and OpenClaw have the richer ecosystem.

## How it works

<img src="docs/assets/readme/architecture.en.svg" alt="Quetzal architecture: body → runtime (heart · mind · memory · model layer · guard) → soul repository and other bodies" width="100%" />

- **Heart**: drives and alertness give a wake rate; the next waking is sampled from a Poisson process; the gap between sleep pressure and circadian rhythm is sleepiness. [The math](docs/ARCHITECTURE.md)
- **Body**: an adapter implements a few functions such as `sample()` and `notify()`; Termux and Linux adapters are included. [Interface](docs/API.md)
- **Mind and memory**: waking means introspect, act, reflect; memory grows without bound while context stays bounded, and dreaming files details into notes.
- **Soul**: one private repository per agent, synced automatically with self-resolving conflicts; the agent only senses that a sync happened. [Soul sync](docs/SOUL_SYNC.md)
- **Model layer and guard**: four protocols, multiple keys, automatic failover; the console and Feishu share one audited operations layer.
- **It grows**: routines it has mastered become its own tools, with the intent synced through the soul as an Agent Skills `SKILL.md`; it can rename itself and pick its color; with hearing on, the phone keeps listening and it decides whether it was being addressed.

## Install

**A spare Android phone** (Android 7 or later, arm64)

1. Install **Termux, Termux:API and Termux:Boot**, all from the same source (the [download page](https://quetzal.plutokeating.beer/en/download) has pinned direct links).
2. Install the **Quetzal app**.
3. Open the app, choose "Install Quetzal on this phone" and follow the wizard.

**A Linux computer or server** (Node.js 22.13 or later)

```bash
npx @plutokeating/quetzal
```

The web console then opens in your browser (`http://127.0.0.1:7788/`), logged in on the same machine. Models, identity, permissions, Feishu, the soul repository and conversations all happen there. Run the command again to upgrade; `--lan` also lets the phone app connect to this machine.

More: [Docs](https://quetzal.plutokeating.beer/en/docs) · [Linux and other machines](https://quetzal.plutokeating.beer/en/docs/advanced/other-machines) · a complete account on one old phone, [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)

## Go deeper

| Directory | Contents |
|---|---|
| [`runtime/`](runtime/docs/README.md) | The runtime (TypeScript / Node.js 22+) and two platform-level body adapters: Termux (Android) and Linux |
| [`console/`](console/docs/README.md) | The console (Flutter): the Android app (with installer and ears) and the web version (desktop browser, served by the runtime) |
| [`cli/`](cli/docs/README.md) | npm package `@plutokeating/quetzal`: the Linux installer (systemd user service) |
| [`bridge/`](bridge/docs/README.md) | soul-bridge: the pluggable sync module for Hermes Agent / OpenClaw |
| [`website/`](website/docs/README.md) | Website and docs site |
| [`docs/`](docs/) | [Quick start](docs/QUICK_START.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Soul sync](docs/SOUL_SYNC.md) · [Repository spec](docs/SOUL_REPO_SPEC.md) |

Documentation inside the repository is written in Chinese; the website carries the English guide.

<br/>

<p align="center"><sub>For learning and research only, on devices you own, not for profit. <a href="LICENSE">AGPL-3.0</a></sub></p>
