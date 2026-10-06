---
title: First steps
description: The first ten minutes after installing: configure a model, name it, poke it, chat a little, then watch its wake up on its own.
---

## Checklist :white_check_mark:

- [ ] Configure at least one model provider and key
- [ ] Give the agent a name and a theme color
- [ ] Glance at the permissions
- [ ] Poke it, or chat a little
- [ ] Wait in **Flow** for its first self-initiated wake-up

## 1. Configure a model

**Control → Models** (the setup wizard's last step **Choose a model**, and the **Choose a model** card on **Now** while there is no model, lead here too):

1. Tap a provider (DeepSeek, Kimi, Zhipu, Alibaba Cloud Bailian, SiliconFlow, Volcano Ark, OpenRouter, OpenAI, Anthropic, Gemini; search the rest under **More**).
2. Paste the API key and tap **Connect**.

Everything else is automatic: the key is encrypted on the device; the runtime asks the provider which models it offers, picks the newest tool-capable ones from the public catalog (models.dev), tests them one by one and keeps two (the first is the main model, the other takes over when it fails; whichever is cheaper than the main one handles the lightweight introspection check). A wrong key changes nothing and the reason is shown.

To add several keys, pick models by hand, reorder or use a custom API URL, tap **Edit** in the top right.

Details in [Models and providers](/docs/guide/models).

> [!TIP]
> Once a model is configured it starts waking at its own rhythm. With no model it never wakes: the guard holds its wake rate at zero.

## 2. Identity

On **Control**, tap its name at the top → **Identity**: a display name, a theme color, a one-line description. The app's wording and colors follow. Identity is written to its soul directory, and once a soul repository is connected it syncs to every body. See [Identity](/docs/guide/identity).

## 3. Permissions

**Control → Permissions**: camera, microphone, location and building tools default to "ask". When it wants to use one it sends you a request, shown at the top of this page, and acts only after you approve. Switch to "allow" once you are comfortable. See [Permissions and safety](/docs/guide/permissions).

## 4. Poke it, chat a little

The **Now** page has two entry points:

- **Poke**: raises its longing and curiosity and immediately re-samples the next wake-up, without forcing one.
- **Chat**: a message wakes it from sleep. While it replies you watch what it does in real time (which tools it calls, what it writes). If you send another message while it is working, it is merged into the current turn as an **interjection** by default; you can also queue it or interrupt.

## 5. Watch the first wake-up

**Flow** is its timeline: every wake-up, dream and conversation leaves an entry. Expand one to see the trigger (why, and what it intended), the process, the journal entry and its mood.

When it wakes is decided by drives and alertness. While awake, a drive $d$ approaches 1 with time constant $\tau$:

$$d' = 1 - (1-d)\,e^{-\Delta t/\tau}$$

The wake rate grows with the square of the weighted mean drive, times alertness and an inhibition factor. So for the first hour or two after installation, with nothing having happened yet, it may stay quiet as if observing. Let it speak first.

## Next

- See what it will do over the next month: [A month in](/docs/start/first-month)
- Let it talk to you in Feishu: [Feishu](/docs/guide/feishu)
- Give its personality and memory a home, and let it live in several bodies: [Soul sync](/docs/guide/soul-sync)
- Understand how it works inside: [Architecture](/docs/reference/architecture)
