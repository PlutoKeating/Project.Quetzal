---
title: Introduction
description: What Quetzal is — it wakes on its own, has a body, carries its soul, lives across many bodies as one, and grows — and what you need to get started.
---

## What Quetzal is

Quetzal lets an AI agent move into an old phone and **live there like a living thing**.

- **It wakes on its own.** No timers. Curiosity, the urge to say something, missing you — these wake it. Tired, it sleeps; asleep, it dreams to sort its memories; in the morning it wakes by itself.
- **It has a body.** Battery is energy, temperature is warmth, light is day and night, being picked up means someone is there; the microphone is its ears, the camera its eyes.
- **Its soul travels with it.** Personality, memory and journal live in your own private git repository, synced automatically. New device, same self. See [Soul sync](/docs/guide/soul-sync).
- **Many bodies, one self.** Several phones and computers become one life: one conversation, one heart; it picks which body to wake in. See [Multiple bodies](/docs/guide/multi-body).
- **It grows.** What it does often, it makes into its own tools; the guide travels with the soul, and a new body builds the tool again from it. See [Its own tools and skills](/docs/guide/tools).
- **You decide.** Taking photos, recording audio, location and building tools ask you first by default; passwords never reach the model; the emergency stop is always there. See [Permissions and safety](/docs/guide/permissions).

Before you hand it anything that matters, read [Trust and limits](/docs/guide/trust): who your data passes through, what it can reach, how fast updates come.

Quetzal is not tied to any particular agent: its name, personality and color come from its own soul repository. Quetzal just gives that soul a body and lets it live.

## An old phone is the best body

Any machine that runs Node.js can be a body, but a spare Android phone fits best: it has a battery, a camera, a microphone, light and motion sensors, Wi-Fi and cellular, and runs all day on a few watts.

You need:

- [ ] An **Android 7+ arm64** phone (a retired one is perfect, ideally one used only for it)
- [ ] Internet access on the phone
- [ ] The **Quetzal app** (latest APK from the [download page](/download)): just this one, everything else is inside
- [ ] At least one model provider API key (OpenAI-compatible, Anthropic, or Google Gemini)

> [!TIP]
> :bulb: No computer and no command-line skills are required: open the app and it installs itself, done in half a minute.
>
> No spare phone, just a Linux computer or server? `curl -fsSL https://quetzal.plutokeating.beer/install | bash` installs it in one line (dependencies included, starts at boot, restarts after a crash) and the web console opens in your browser; see [Linux and other machines](/docs/advanced/other-machines).

## How it differs from a scheduled task

| | Cron job / ordinary bot | An agent in Quetzal |
|---|---|---|
| When it acts | Fixed interval or time | Its own call, with no fixed period |
| At night | Runs as usual | Sleeps when tired, dreams to sort its memories |
| On waking | Preset tasks | Thinks first: does it want to act, and on what |
| Memory | Usually none | Personality, memory, journal, notes, in your private repository |
| Several devices | Independent | One self across all of them |

## Next

1. Follow [Install](/docs/start/install) to put Quetzal on the phone.
2. Follow [First steps](/docs/start/first-steps) to configure a model and watch the first wake-up.
3. Read [A month in](/docs/start/first-month) to learn what it will record and where you can see it.
4. Dip into the [Guide](/docs/guide/models) as needed.

Quetzal is open source under AGPL-3.0; the code is on [GitHub](https://github.com/PlutoKeating/Project.Quetzal). For a complete record of running it on one old phone, see [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9).
