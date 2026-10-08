---
title: First steps
description: The first ten minutes after installing. Configure a model, name the agent, poke it, chat a little, then watch it wake up on its own.
---

## Checklist :white_check_mark:

- [ ] Configure at least one model provider and key
- [ ] Give the agent a name and a theme color
- [ ] Glance at the permissions
- [ ] Poke it, or chat a little
- [ ] Wait in **Flow** for it to wake up on its own for the first time

## 1. Configure a model

Go to **Control → Models**. The setup wizard's last step, **Choose a model**, leads here too, and so does the **Choose a model** card on **Now** while no model is set up.

1. Tap a provider: DeepSeek, Kimi, Zhipu, Alibaba Cloud Bailian, SiliconFlow, Volcano Ark, OpenRouter, OpenAI, Anthropic or Gemini. Search for others under **More**.
2. Paste the API key and tap **Connect**.

The rest happens automatically:

- The key is stored encrypted on the device.
- The runtime asks the provider which models it offers and compares them with the public catalog (models.dev). It picks the newest models that can call tools, tests them one by one and keeps two. The first is the main model, and the other takes over when the main one fails. Whichever model is cheaper than the main one handles the quick introspection check.
- If the key is wrong, nothing changes and the app shows the reason.

To add several keys, pick models by hand, change their order or use a custom API URL, tap **Edit** in the top right.

See [Models and providers](/docs/guide/models) for details.

> [!TIP]
> Once a model is configured, the agent starts waking at its own rhythm. Without a model it never wakes, because its wake rate is held at zero.

## 2. Identity

On **Control**, tap the agent's name at the top, then **Identity**. Set a display name, a theme color and a one-line description, and the app's wording and colors change to match. The identity is written to the agent's soul directory. Once a soul repository is connected, it syncs to every body. See [Identity](/docs/guide/identity).

## 3. Permissions

Under **Control → Permissions**, camera, microphone, location and building tools are set to "ask" by default. When the agent wants to use one, it sends you a request that appears at the top of this page, and it acts only after you approve. Once you trust it, switch them to "allow". See [Permissions and safety](/docs/guide/permissions).

## 4. Poke it, chat a little

The **Now** page has two entry points:

- **Poke**: makes it miss you more and feel more curious, and makes it decide again right away when to wake next. It may not wake at once.
- **Chat**: a message wakes it from sleep. While it replies, you can watch what it does in real time: which tools it calls and what it writes. If you send another message while it is working, the message joins the current turn as an **interjection** by default. You can also queue it or interrupt.

## 5. Watch the first wake-up

**Flow** is the agent's timeline. Every wake-up, dream and conversation leaves an entry there. Expand one to see the trigger (why it woke and what it meant to do), the process, the journal entry and its mood.

When it wakes depends on a few inner drives (curiosity, the urge to say something, missing you) and on how alert it is: the stronger the drives and the more alert it is, the more often it wakes. In the first hour or two after installation nothing has happened yet and the drives are low, so it may stay quiet as if it were watching. If you do not want to wait, talk to it; a message always wakes it. The model behind waking is in [Architecture](/docs/reference/architecture).

## Next

- See what it will do over the next month: [A month in](/docs/start/first-month)
- Let it talk to you in Feishu: [Feishu](/docs/guide/feishu)
- Give its personality and memory a home, and let it live in several bodies: [Soul sync](/docs/guide/soul-sync)
- Understand how it works inside: [Architecture](/docs/reference/architecture)
