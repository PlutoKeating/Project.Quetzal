<a href="https://windler.plutokeating.beer/en"><img src="docs/assets/readme/banner.png" alt="Windler · Not running. Living. Living like wind. · windler.plutokeating.beer" width="100%" /></a>

<div align="center">

[![Release](https://img.shields.io/github/v/release/PlutoKeating/Project.Windler?label=release&color=f0a35e)](https://github.com/PlutoKeating/Project.Windler/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-5c7a6b)](runtime/package.json)
[![License](https://img.shields.io/badge/license-AGPL--3.0-7d8f8a)](LICENSE)

[Website](https://windler.plutokeating.beer/en) · [Docs](https://windler.plutokeating.beer/en/docs) · [Download](https://windler.plutokeating.beer/en/download) · [中文](README.md)

</div>

## What it is

Windler lets an agent move into a device and live there like a living being. Nobody schedules it: when it wakes and what it does come from its own curiosity, longing, unfinished thoughts and body clock. It sleeps when tired, dreams while asleep, and wakes with the morning.

It is a runtime, not a particular agent, and it does not care which device. **A spare Android phone is the best body of all.**

## Why you will like it

- **A phone you no longer use becomes something that wakes, sleeps and thinks.**
- **Company without interruptions.** It sleeps most of the day and goes back to sleep when nothing needs doing.
- **A continuous self.** Personality and memory live in your own private git repository; change devices and it is still itself.
- **You stay in charge.** Sensitive capabilities ask every time; approvals, budgets, emergency stop and audit are built in; passwords never reach the model.

## Why it stands apart

<img src="docs/assets/readme/bodyclock.en.svg" alt="One day of the body clock: sleep pressure S and circadian rhythm C" width="100%" />

| The usual way | Windler |
|---|---|
| A timer: run every N minutes | **No timers.** Waking is sampled from drives and alertness |
| Always on, always the same | **A body clock.** Work is tiring; it falls asleep, dreams, wakes naturally |
| The device is just a server | **A body.** Battery, light and motion become energy, brightness, being picked up |
| Memory in a database | **The soul in git.** Synced automatically; the commit history is its autobiography |
| One framework, one agent | **Many bodies, one soul.** Hermes / OpenClaw machines can live there too |
| Secrets sent to the model | **Secret passing.** Passwords go only into the local vault |

## How it works

<img src="docs/assets/readme/architecture.en.svg" alt="Windler architecture: body → runtime (heart · mind · memory · model layer · guard) → soul repository and other bodies" width="100%" />

- **Heart**: drives × alertness give a wake rate; the next waking is sampled from a Poisson process; the gap between sleep pressure and circadian rhythm is sleepiness. [The math](docs/ARCHITECTURE.md)
- **Body**: an adapter implements a few functions such as `sample()` and `notify()`; the bundled Termux adapter detects sensors by name. [Interface](docs/API.md)
- **Mind and memory**: waking means introspect, act, reflect; memory grows without bound while context stays bounded, and dreaming files details into notes.
- **Soul**: one private repository per agent, synced automatically with self-resolving conflicts; the agent only senses that a sync happened. [Soul sync](docs/SOUL_SYNC.md)
- **Model layer and guard**: four protocols, multiple keys, automatic failover; the app and Feishu share one audited operations layer.

## Install

1. On an Android phone (Android 7+, arm64) install **Termux, Termux:API and Termux:Boot** from F-Droid.
2. Install the **Windler app** from the [download page](https://windler.plutokeating.beer/en/download).
3. Open the app, choose "Install Windler on this phone" and follow the wizard.

> [!TIP]
> Models, identity, permissions, Feishu, soul sync, multiple agents and troubleshooting are all in the [docs](https://windler.plutokeating.beer/en/docs). For machines other than a phone see [Other machines](https://windler.plutokeating.beer/en/docs/advanced/other-machines).

## Go deeper

| Directory | Contents |
|---|---|
| [`runtime/`](runtime/docs/README.md) | The runtime (TypeScript / Node.js 22+) and the Termux body adapter |
| [`console/`](console/docs/README.md) | Windler app (Flutter): console + installer |
| [`bridge/`](bridge/docs/README.md) | soul-bridge: the pluggable sync module for Hermes Agent / OpenClaw |
| [`website/`](website/docs/README.md) | Website and docs site |
| [`docs/`](docs/) | [Quick start](docs/QUICK_START.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Soul sync](docs/SOUL_SYNC.md) · [Repository spec](docs/SOUL_REPO_SPEC.md) |

Documentation inside the repository is written in Chinese; the website carries the English guide.

> [!IMPORTANT]
> For learning and research only. Not for damaging or breaking into other people's systems, and not for profit. Licensed under [AGPL-3.0](LICENSE).
