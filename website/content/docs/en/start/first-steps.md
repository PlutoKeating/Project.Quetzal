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

**Control → Models**:

1. **Add a provider**: pick one from the catalog (sourced from models.dev, with context lengths and prices) or enter a custom API URL and protocol (OpenAI-compatible, OpenAI Responses, Anthropic Messages, Google Gemini).
2. **Add a key**: keys are encrypted on the phone; the UI shows only the last four characters.
3. **Tick models** → **Save** → **Test**.
4. Drag to reorder the **global model order**. The first one is used first; on failure the next one takes over.
5. Optional: set a cheap, fast model as the **introspection (quick) model** for the lightweight "do I feel like doing anything?" check when she wakes.

Details in [Models and providers](/docs/guide/models).

> [!TIP]
> Once a model is configured she starts waking at her own rhythm. With no model she never wakes: the guard holds her wake rate at zero.

## 2. Identity

**Control → Identity**: a display name, a theme color, a one-line description. The app's wording and colors follow. Identity is written to her soul directory, and once a soul repository is connected it syncs to every body. See [Identity](/docs/guide/identity).

## 3. Permissions

**Control → Permissions**: camera, microphone, location and screen control default to "ask every time". When she wants to use one she sends you an approval and acts only after you approve. Switch to "allow" once you are comfortable. See [Permissions and safety](/docs/guide/permissions).

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
