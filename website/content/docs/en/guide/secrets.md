---
title: Passing secrets
description: When the agent needs a password, token or key, you type it in the chat box. The value goes straight into the vault and never enters the conversation or the model context.
---

## Why this exists

While working, the agent often needs credentials: a GitHub token, a password for some service, a private key. If you sent them in chat, the plain text would end up in the conversation log, the model context and the provider's logs. So the agent calls `pass_secret` to start a **secret input**.

## The flow

```mermaid
sequenceDiagram
  participant A as It
  participant W as Runtime
  participant U as You (app / Feishu)
  A->>W: pass_secret(purpose, item names and hints)
  W->>U: Notice: each message is one value; done spell done-xxxxxx
  loop One item per message
    U->>W: value
    W-->>U: Receipt: item i/N received (character count only)
  end
  U->>W: Done spell (or tap "Done")
  W->>W: Write vault/<name> (mode 0600)
  W-->>A: name, path, byte count, no plaintext
```

- It first explains in its own words which items it needs and what each one is.
- After that, **each message you send is one value**, matched to the items in order. Only spaces and line breaks at the start and end are removed. Values with several lines (such as private keys) are kept as they are.
- When you have sent them all, send the **done spell**. The app's "Done / Redo / Cancel" buttons do the same. Send the spell followed by `redo` (`spell redo`) to clear the values and start over, or `spell cancel` to give up.
- **After ten minutes with no messages, the input is cancelled automatically**, and the values received so far are thrown away. Nothing is saved to disk until you send the done spell.

In the app, a banner sits above the input box during a secret input, and the box hides what you type by default. Tap the eye to show it; you need to show it before pasting a value with several lines. In Feishu, a card shows the progress. When you finish, **recall those messages yourself**.

## The vault

Secrets are stored in `QUETZAL_HOME/vault/`, one file per item, named after the item. **Control → Advanced → Secrets** shows each item's name, hint, source channel and time, and lets you delete it. It **never shows the contents**.

The vault belongs to this body only. It is **not synced to other bodies** and never enters the soul repository.

## How it uses it

The agent refers to values by their path in commands (`"$(cat path)"` or `< path`) and does not print them. Before any tool output reaches the model, the runtime replaces every secret value in it with `‹secret:name›`.

> [!WARNING]
> This protects against **accidental** leaks (`cat`, `env`, debug output). The agent's commands can read the vault: on Android and Linux the agent and the runtime are the same system user, and on Windows the sandbox user is allowed to read it. What keeps the plain text from the model is the protocol, how the tools are written and the output replacement; the operating system does not isolate the vault. If you do not want the agent near a credential, do not give it to the agent.

## It can be denied

"Request secrets" is a separate permission category. You can set it to ask or deny under **Control → Permissions**. The agent can start a secret input only during a conversation. When it wakes on its own with nobody there, the tool tells it to arrange a time with you first.
