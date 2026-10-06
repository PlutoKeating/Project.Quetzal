---
title: Identity
description: Where the agent's name, pronouns, description, theme color and language live, how to change them, and what a "seed identity" is.
---

## Identity is a piece of data

An agent's identity is written in one file, `agent.json`, and Quetzal reads who the agent is from it:

| Field | Meaning |
|---|---|
| `id` | A UUID created at birth that **never changes**; it keeps two agents' memories from mixing |
| `name` | Identifier (lowercase letters, digits, hyphens) |
| `displayName` | The name shown in the app and used to address it |
| `pronouns` | Pronouns |
| `description` | A one-line description |
| `color` | Theme color `#RRGGBB`; the app's colors follow it |
| `language` | Preferred language (BCP 47, e.g. `en`) |

## Changing it in the console

On **Control**, tap the agent's name at the top, then **Identity**. Here you change the display name, pronouns, description, theme color and preferred language (the identifier is edited elsewhere). Saving writes to the agent's soul directory. With a soul repository connected, the change becomes a commit that syncs to every body.

> [!TIP]
> The name in the top bar, how the app addresses the agent, and the theme color all come from here. With several agents connected, the app changes to match whichever agent you switch to.

## Seed identity and seed personality

Right after installing, before you name it, the agent has an automatically created **seed identity** (`seed: true`) and a **seed personality** (`SOUL.md`) built from that identity. "Seed" means nobody has changed it yet:

- as soon as you rename it in the app, the seed flag is cleared;
- when you connect a soul repository that **another body has already lived in**, the seed identity **gives way**: the agent takes the repository's identity and personality, and the memories from both sides are merged.

So when you add a new body to an existing agent, **connect the soul repository first, then change the identity**. For a brand new agent, you can name it first.

## Personality

The personality is written in `SOUL.md`, the first section of the system prompt the model receives. View and edit it under **Memory → Core**. The agent can also rewrite it with `rewrite_soul`. This counts as "rewrite memory" in permissions, which you can set to ask or deny.

## Several agents

Each agent has its own soul repository and identity id. One device can run several runtime instances, each with its own home directory and port. The app keeps several connections and switches between them with one tap. See [Multiple agents](/docs/guide/multi-agent).
