---
title: First steps
description: The first ten minutes after installing: configure a model, name her, poke her, chat a little, then watch her wake up on her own.
---

## Checklist :white_check_mark:

- [ ] Configure at least one model provider and key
- [ ] Give the agent a name and a theme color
- [ ] Glance at the permissions
- [ ] Poke her, or chat a little
- [ ] Wait in **Flow** for her first self-initiated wake-up

## 1. Configure a model

**Control → Models** (the setup wizard's last step **Choose a model**, and the **Choose a model** card on **Now** while there is no model, lead here too):

1. Tap a provider (DeepSeek, Kimi, Zhipu, Alibaba Cloud Bailian, SiliconFlow, Volcano Ark, OpenRouter, OpenAI, Anthropic, Gemini; search the rest under **More**).
2. Paste the API key and tap **Connect**.

Everything else is automatic: the key is encrypted on the device; the runtime asks the provider which models it offers, picks the newest tool-capable ones from the public catalog (models.dev), tests them one by one and keeps two (the first is the main model, the other takes over when it fails; whichever is cheaper than the main one handles the lightweight introspection check). A wrong key changes nothing and the reason is shown.

To add several keys, pick models by hand, reorder or use a custom API URL, tap **Edit** in the top right.

Details in [Models and providers](/docs/guide/models).

> [!TIP]
> Once a model is configured she starts waking at her own rhythm. With no model she never wakes: the guard holds her wake rate at zero.

## 2. Identity

On **Control**, tap her name at the top → **Identity**: a display name, a theme color, a one-line description. The app's wording and colors follow. Identity is written to her soul directory, and once a soul repository is connected it syncs to every body. See [Identity](/docs/guide/identity).

## 3. Permissions

**Control → Permissions**: camera, microphone, location and screen control default to "ask". When she wants to use one she sends you a request, shown at the top of this page, and acts only after you approve. Switch to "allow" once you are comfortable. See [Permissions and safety](/docs/guide/permissions).

## 4. Poke her, chat a little

The **Now** page has two entry points:

- **Poke**: raises her longing and curiosity and immediately re-samples the next wake-up, without forcing one.
- **Chat**: a message wakes her from sleep. While she replies you watch what she does in real time (which tools she calls, what she writes). If you send another message while she is working, it is merged into the current turn as an **interjection** by default; you can also queue it or interrupt.

## 5. Watch the first wake-up

**Flow** is her timeline: every wake-up, dream and conversation leaves an entry. Expand one to see the trigger (why, and what she intended), the process, the journal entry and her mood.

When she wakes is decided by drives and alertness. While awake, a drive $d$ approaches 1 with time constant $\tau$:

$$d' = 1 - (1-d)\,e^{-\Delta t/\tau}$$

The wake rate grows with the square of the weighted mean drive, times alertness and an inhibition factor. So for the first hour or two after installation, with nothing having happened yet, she may stay quiet as if observing. Let her speak first.

## Next

- Let her talk to you in Feishu: [Feishu](/docs/guide/feishu)
- Give her personality and memory a home, and let her live in several bodies: [Soul sync](/docs/guide/soul-sync)
- Understand how she works inside: [Architecture](/docs/reference/architecture)
