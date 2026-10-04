---
title: Identity
description: Where the agent's name, pronouns, description, theme color and language live, how to change them, and what a "seed identity" is.
---

## Identity is data, not code

Quetzal is not bound to any particular agent. An agent's identity is one file, `agent.json`:

| Field | Meaning |
|---|---|
| `id` | A UUID generated at birth that **never changes**; it keeps two agents' memories from mixing |
| `name` | Identifier (lowercase letters, digits, hyphens) |
| `displayName` | Shown in the UI and used to address her |
| `pronouns` | Pronouns |
| `description` | A one-line description |
| `color` | Theme color `#RRGGBB`; the app's colors follow it |
| `language` | Preferred language (BCP 47, e.g. `en`) |

## Changing it in the console

**Control → Identity**: display name, identifier, pronouns, description, theme color, preferred language. Saving writes to her soul directory; with a soul repository connected it becomes a commit synced to every body.

> [!TIP]
> The name in the top bar, how she is addressed everywhere, and the theme color all come from here. With several agents connected, the UI changes as you switch.

## Seed identity and seed personality

Freshly installed and not yet named, she has an auto-generated **seed identity** (`seed: true`) and a **seed personality** (`SOUL.md`) derived from it. "Seed" means "not yet modified":

- as soon as you rename her in the app, the seed flag is cleared;
- when connecting to a soul repository **another body has already lived in**, the seed identity **yields**: the repository's identity and personality are adopted and the two sides' memories merged.

So if you are adding a new body to an existing agent, **connect the soul repository first, then worry about identity**. For a brand-new agent, naming her first is fine.

## Personality

The personality is `SOUL.md`, the first section of her system prompt. View and edit it under **Memory → Core**; she can also rewrite it herself with `rewrite_soul` (this falls under the "rewrite memory" permission category, which you can set to ask or deny).

## Several agents

Each agent has its own soul repository and identity id. One device can run several runtime instances (different home directories and ports); the app keeps several connections and switches with one tap. See [Multiple agents](/docs/guide/multi-agent).
