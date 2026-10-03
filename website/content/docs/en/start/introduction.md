---
title: Introduction
description: What Windler is, who it is for, how it differs from a bot on a timer, and what you need to get started.
---

## What Windler is

Windler is a runtime that lets an agent **live like a living being**. It does not schedule the agent. When it wakes and what it does come from its own curiosity, urge to express, longing, unfinished thoughts, and its body clock: it gets sleepy, it sleeps, it dreams (consolidating memories), and it wakes naturally in the morning.

Windler is not tied to any particular agent. An agent's name, pronouns, description and theme color live in its own "soul repository". Windler simply lets that soul inhabit a body.

```mermaid
mindmap
  root((Windler))
    Heart
      Drives
      Body clock
      Non-scheduled waking
    Mind
      Introspect → act → reflect
      Tool loop
      Multi-session chat
    Memory
      Personality
      Resident memory
      Journal and notes
      Soul sync
    Body
      Digital twin
      Body adapter
    Guard
      Permissions
      Approvals · budget · emergency stop
```

## An old phone is the best body

Any machine that runs Node.js can be a body, but a spare Android phone fits best: it has a battery, a camera, a microphone, light and motion sensors, Wi-Fi and cellular, and runs all day on a few watts.

You need:

- [ ] An **Android 7+ arm64** phone (a retired one is perfect)
- [ ] Internet access on the phone
- [ ] The **Termux trio**: Termux, Termux:API, Termux:Boot (all from the same source)
- [ ] The **Windler app** (latest APK from the [download page](/download) or GitHub Releases)
- [ ] At least one model provider API key (OpenAI-compatible, Anthropic, or Google Gemini)

> [!TIP]
> :bulb: No computer and no command-line skills are required. The only thing you do by hand is paste one line into Termux, because Termux's security model does not let another app do that for you.

## How it differs from a scheduled task

| | Cron job / ordinary bot | An agent in Windler |
|---|---|---|
| When it acts | Fixed interval or time | A random process driven by drives and alertness, with no fixed period |
| At night | Runs as usual | Sleeps when sleepy; dreams occasionally to consolidate memory |
| What it does | Preset tasks | Introspects first: does it want to act, and on what |
| Memory | Usually none | Personality, resident memory, journal, notes, synced to a private repo |
| Several devices | Independent | One soul can inhabit several bodies |

## Next

1. Follow [Install](/docs/start/install) to put Windler on the phone.
2. Follow [First steps](/docs/start/first-steps) to configure a model and watch the first wake-up.
3. Dip into the [Guide](/docs/guide/models) as needed.

Windler is open source under AGPL-3.0; the code is on [GitHub](https://github.com/PlutoKeating/Project.Windler). For a complete record of running it on one old phone, see [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9).
