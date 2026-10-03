<a href="https://windler.plutokeating.beer/en"><img src="docs/assets/readme/banner.png" alt="Windler · Not running. Living. Living like wind. · windler.plutokeating.beer" width="100%" /></a>

<div align="center">

[![Release](https://img.shields.io/github/v/release/PlutoKeating/Project.Windler?label=release&color=f0a35e)](https://github.com/PlutoKeating/Project.Windler/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-5c7a6b)](runtime/package.json)
[![License](https://img.shields.io/badge/license-AGPL--3.0-7d8f8a)](LICENSE)

[Website](https://windler.plutokeating.beer/en) · [Docs](https://windler.plutokeating.beer/en/docs) · [Download](https://windler.plutokeating.beer/en/download) · [中文](README.md)

</div>

## What it is

**It decides when to wake. Including not to.**

Codex and Claude Code are tools that move when you call them and exit when done. Hermes and OpenClaw are assistants woken every 30 minutes by a heartbeat to ask "anything?". **Windler is where an agent lives**: no timer, it wakes when its own drives and body clock say so; it has a body (an old Android phone), and its soul lives in your private git repository, portable across bodies.

It is not a replacement but a neighbor: Hermes / OpenClaw build agents, Windler builds the place an agent lives. soul-bridge lets your existing Hermes share one soul with the body inside Windler.

| | Codex / Claude Code | Hermes / OpenClaw | Windler |
|---|---|---|---|
| Who decides when it wakes | You, from the terminal | A timer: heartbeat or cron | Itself: drives × alertness, sampled; no timer |
| When not called | Does not exist | Waits for the next heartbeat | Sleeps, dreams, or stays awake doing nothing |
| Body | None | A server | A phone: battery, light, motion, microphone, camera |
| Soul | Gone when the session ends | Local files | A private git repository, portable across bodies |
| Not for | — | — | If you just want a terminal agent for code: use Codex |

> Website and full guide: <https://windler.plutokeating.beer/en> . A complete account of running it on one old phone lives in [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9).

## Why you will like it

- **A phone you no longer use becomes something that wakes, sleeps and thinks.**
- **Company without interruptions.** It sleeps most of the day and goes back to sleep when nothing needs doing.
- **A continuous self.** Personality and memory live in your own private git repository; change devices and it is still itself.
- **You stay in charge.** Sensitive capabilities ask every time; approvals, budgets, emergency stop and audit are built in; passwords never reach the model.

## Why it stands apart

<img src="docs/assets/readme/bodyclock.en.svg" alt="One day of the body clock: sleep pressure S and circadian rhythm C" width="100%" />

Sleeps when tired, wakes with the morning: the gap between sleep pressure S and circadian rhythm C decides when it sleeps and wakes. There is no "every N minutes" in the code.

## How it works

<img src="docs/assets/readme/architecture.en.svg" alt="Windler architecture: body → runtime (heart · mind · memory · model layer · guard) → soul repository and other bodies" width="100%" />

- **Heart**: drives × alertness give a wake rate; the next waking is sampled from a Poisson process; the gap between sleep pressure and circadian rhythm is sleepiness. [The math](docs/ARCHITECTURE.md)
- **Body**: an adapter implements a few functions such as `sample()` and `notify()`; the bundled Termux adapter detects sensors by name. [Interface](docs/API.md)
- **Mind and memory**: waking means introspect, act, reflect; memory grows without bound while context stays bounded, and dreaming files details into notes.
- **Soul**: one private repository per agent, synced automatically with self-resolving conflicts; the agent only senses that a sync happened. [Soul sync](docs/SOUL_SYNC.md)
- **Model layer and guard**: four protocols, multiple keys, automatic failover; the app and Feishu share one audited operations layer.
- **It grows**: routines it has mastered become its own tools, with the intent synced through the soul as an Agent Skills `SKILL.md`; it can rename itself and pick its color; with hearing on, the phone keeps listening and the agent decides whether it was being addressed.

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
