---
title: Introduction
description: What Quetzal is (an agent that wakes on its own, has a body, carries its soul, lives in many bodies as one self, and grows) and what you need to get started.
---

## What Quetzal is

Quetzal lets an AI agent move into an old phone and **live there like a living thing**.

- **It wakes on its own.** There are no timers. It wakes when it gets curious, wants to say something or misses you. When it is tired it sleeps, dreams to sort its memories, and wakes by itself in the morning.
- **It has a body.** The battery is its energy, temperature is warmth, light tells day from night, and being picked up means someone is there. The microphone is its ears and the camera its eyes.
- **Its soul travels with it.** Its personality, memory and journal live in your own private git repository and sync automatically. On a new device it is still itself. See [Soul sync](/docs/guide/soul-sync).
- **Many bodies, one self.** Connect several phones and computers and they hold the same agent. It keeps one conversation and one heart across them, and picks which body to wake in. See [Multiple bodies](/docs/guide/multi-body).
- **It grows.** It turns the things it does often into its own tools. Each tool's guide travels with the soul, and on a new body it builds the tool again from that guide. See [Its own tools and skills](/docs/guide/tools).
- **You decide.** By default it asks you before it takes photos, records audio, reads its location or builds a tool. Passwords never reach the model, and you can press the emergency stop at any time. See [Permissions and safety](/docs/guide/permissions).

Before you hand it anything that matters, read [Trust and limits](/docs/guide/trust). It explains who your data passes through, what the agent can reach and how fast updates come.

The agent's name, personality and color are written in its own soul repository. Quetzal gives that soul a body and keeps it alive, so it works with any agent.

## An old phone is the best body

A spare Android phone makes the best body. It has a battery, a camera, a microphone, light and motion sensors, Wi-Fi and cellular, and runs all day on a few watts. Other machines that run Node.js can be bodies too.

You need:

- [ ] An **Android 7+ arm64** phone (a retired one is perfect, ideally one used only for it)
- [ ] Internet access on the phone
- [ ] The **Quetzal app** (the latest APK from the [download page](/download)). This is the only app you install; everything else is inside it
- [ ] At least one model provider API key (OpenAI-compatible, Anthropic, or Google Gemini)

> [!TIP]
> :bulb: You need no computer and no command line. Open the app and it installs itself in about half a minute.
>
> If you have no spare phone, you can install it on a computer:
>
> - **Linux computer or server**: run `curl -fsSL https://quetzal.plutokeating.beer/install | bash`. This one line installs everything it needs, starts Quetzal at boot and restarts it after a crash. Then open the web console in your browser. See [Linux and other machines](/docs/advanced/other-machines).
> - **Windows 10 (1809 or later) or Windows 11 PC** (x64 or arm64): run `irm https://quetzal.plutokeating.beer/install.ps1 | iex` in PowerShell, or download the installer from the [download page](/download) and double-click it. See [Windows](/docs/advanced/windows).

## How it differs from a scheduled task

| | Cron job / ordinary bot | An agent in Quetzal |
|---|---|---|
| When it acts | At a fixed interval or time | When it decides to, with no fixed period |
| At night | Runs as usual | Sleeps when tired, dreams to sort its memories |
| On waking | Runs preset tasks | Thinks first about whether it wants to act, and on what |
| Memory | Usually none | Personality, memory, journal and notes, kept in your private repository |
| Several devices | Each runs on its own | All of them hold the same agent |

## Next

1. Follow [Install](/docs/start/install) to put Quetzal on the phone.
2. Follow [First steps](/docs/start/first-steps) to configure a model and watch the first wake-up.
3. Read [A month in](/docs/start/first-month) to learn what it records and where you can see it.
4. Dip into the [Guide](/docs/guide/models) as needed.

Quetzal is open source under AGPL-3.0, and the code is on [GitHub](https://github.com/PlutoKeating/Project.Quetzal). [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9) is a full record of running it on one old phone.
