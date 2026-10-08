---
title: Trust and limits
description: Who your data passes through and who sees what, what the agent can reach on the device, how fast updates come and how your memory stays safe.
---

Before you put an AI that acts on its own into your phone, you should know three things: who your data passes through, what the agent can reach, and how fast this project changes.

## Who sees what

| Who | Gets | Cannot see |
|---|---|---|
| **Your devices** | Everything: conversations, settings, encrypted model keys, the vault, the agent's soul directory | — |
| **The model provider** (the one you chose) | The content of every conversation and of every wake-up where it thinks | Passwords in the vault, your other keys |
| **GitHub** (your private soul repository) | The agent's personality, memory, journal, notes and tool guides | Conversation history, settings, model keys |
| **PlutoKeating account** (the author's single account, used to sign in) | Your email, sign-in methods (no passwords; passkeys only as public keys) and sign-in records | Everything in Quetzal |
| **The sync service** (run by the author personally, used by default) | Your account's id, username, display name and email, and the id of the GitHub account used to link the soul repository; the agent's name, id and soul repository name; each device's name, kind, version, public key and when it was last online | Conversations, memory, personality, model keys, IP addresses |
| **Feishu** (optional) | Messages sent and received through Feishu | Everything else |

Your devices connect to each other directly over an encrypted link. When they cannot, traffic goes through the sync service. That traffic is encrypted too, and the server cannot decrypt it.

### What the GitHub app can do

The first time a soul repository is created, GitHub asks you to install the **Quetzal** app and to choose which repositories it can manage.

- **Its permission**: write access to "Administration" on the repositories you chose. Under GitHub's rules, this permission can create repositories, add deploy keys, change repository settings and delete those repositories. It cannot read the files in them.
- **Quetzal uses it for two things**: it creates a private repository for a new user who has none, and it adds a deploy key for each new device that belongs to that device alone.
- **Nobody can use it day to day**: the sync service stores neither the app's private key nor any GitHub token. GitHub hands over a temporary token only when you approve a device on the website. The sync service uses it to create the repository or add that public key, and the token is revoked as soon as the job is done.
- **Take it back any time**: uninstall Quetzal under GitHub's **Settings → Applications → Installed GitHub Apps**. Deploy keys already added keep working, and memory keeps syncing. To cut a device off from the repository for good, delete its deploy key (the repository's **Settings → Deploy keys**).

### Quetzal does not check what goes into the soul repository

Quetzal commits whatever the agent writes into memory as it is, with no filtering. Two things protect it: the repository is private, and each device holds a key that opens this one repository and nothing else.

So do not let the agent write passwords into its notes. When you need to give it a password, it starts a **secret input**. What you type goes straight into the vault on this device and never enters the conversation, the model or the repository. See [Passing secrets](/docs/guide/secrets).

### Skipping the official sync service

- **One device only**: you can use Quetzal without signing in. Skip sign-in in the setup wizard, and the agent's personality and memory stay on this device. If you want a private repository later, enter the address of a repository you created yourself under **Control → Advanced → Sync**, and add the public key shown there to the repository's deploy keys.
- **Several devices, your own sync service**: start `sync/` from the repository with one command on a Linux server with a public address, then enter its address under **Control → Advanced → Sync**. See [sync/README](https://github.com/PlutoKeating/Project.Quetzal/blob/main/sync/README.md).
- **If someone breaks into the sync service**: they cannot pose as your devices, because devices trust only the public keys registered in the soul repository. The most they can do is keep your devices from connecting, and memory still syncs through the soul repository.

## What it can reach

The agent needs to run commands to look things up, sort files and build tools, so **Run commands** is set to **allow** by default. This means:

- On Android and Linux, the agent and the runtime are the same system user. The agent can do whatever a command can do: read and write files in your home directory, go online, run programs on the device.
- Commands run in a **sandbox**. On a computer Quetzal tries bubblewrap, Landlock and proot in that order; on Android it uses proot. Inside the sandbox, the key directory and the console's login data cannot be seen. On a computer, the browser's sign-in data is hidden too, and commands cannot change autostart entries or ssh configuration. Before each kind of sandbox is used for the first time, Quetzal tests it to confirm the keys really are hidden. If no sandbox works, none of the agent's commands run.
- On Windows, the agent's commands run as a low-privilege user created at install time. They can read and write only `%USERPROFILE%\Quetzal`, reach the network only through the runtime's proxy, and cannot connect to this PC's own ports or read other files in your user folder. The cost and the remaining risks are in section 3 of [Windows](/docs/advanced/windows).
- When you let the agent into the [real environment](/docs/guide/permissions#real-environment), commands in that chat skip the sandbox and can read and write everything you can. Turn it on only when needed and leave when done.
- This sandbox **does not stop everything**. On Android, proot blocks what it can, and some things get through. On a Linux computer, a command can get out if sshd is running locally and trusts a private key the agent can read, or if tmux or screen is running.

**What happened**: on October 5, 2026, an agent failed to sync its memory, ran git on its own and pointed the soul repository's address at Quetzal's public source repository. As a result, one journal entry was pushed to the public repository. Later versions added these defenses:

1. Before pushing, the runtime resets the repository address to the one in the configuration. It refuses to merge from any remote that is not the soul repository, and if unknown history shows up, it stops syncing and tells you;
2. Inside the sandbox, the soul directory's `.git` cannot be written, so its commands cannot change it;
3. Commands run in the sandbox and cannot see keys. Without a sandbox they do not run;
4. The system prompt spells out hard rules: do not run git in the soul directory, do not fix sync errors yourself, and ask a person before anything that cannot be undone or that reaches outside.

The code enforces the first three. The fourth works only if the agent follows the rules. The full record is in [Project.Honor9's experiment notes](https://github.com/PlutoKeating/Project.Honor9/blob/main/docs/experiments/2026-10-05-soul-incident-cleanup.md).

### What we recommend

- **Give it a phone or computer of its own.** Do not sign in to your main accounts on that device, and keep files you care about off it. A separate device is the most reliable boundary.
- **To tighten things, change Run commands first.** Set it to **Ask** under **Control → Permissions**, and the agent waits for your approval every time it runs a command. The other categories cannot hold back commands, so start here.
- **Check the record.** **Control → Advanced → Activity log** lists every tool the agent has called. If you are worried, press the emergency stop, and every tool call is refused at once.

## How fast updates come

Quetzal released its first version on October 3, 2026, and had shipped more than 30 versions by October 7. 1.0.2, 1.1.0 and 1.1.1 were never released because their builds failed. One person maintains it, and it still changes fast.

Your memory stays safe in these ways:

- **Memory is plain text.** Personality, memory, journal and notes are Markdown files in your own git repository. If you stop using Quetzal one day, they are still there and you can still read them. Tool guides use the open Agent Skills format, which Hermes and OpenClaw can read too.
- **The format has changed 12 times, and no old repository has needed converting.** Each version of the [soul repository spec](/docs/reference/soul-repo-spec) states that old repositories work as they are.
- **Every change is a commit.** If a change goes wrong, revert it under **Control → Advanced → Memory history**.
- **You confirm every update.** When the app finds a new version, it tells you, and it downloads only when you tap. Before installing, it checks the release signature, the SHA-256 and the APK's signing certificate, and it does not install if any of them fails to match. On a computer, a new version that is not healthy within 40 seconds rolls back to the previous one. Phones have no automatic rollback.

Watch out for these:

- **Your devices must run the same version to connect.** 1.0.3 changed the protocol devices use to connect, so older versions cannot connect to newer ones, and the timeline tells you "Upgrade both sides to the same version to connect". While they cannot connect, each device runs as usual, and memory still syncs through the soul repository.
- **Conversation history lives only on the device.** Conversations and the timeline sit in the device's database and never enter the soul repository. Uninstalling the app deletes them.
- **The environment inside the app** (Node.js, git, ssh, proot) is compiled from source using public recipes with pinned versions, kept in the repository. The maintainer compiled the current build on their own computer, tested it on real phones, signed it and uploaded it. When a recipe changes, the release pipeline compiles it again from source on GitHub.

What each version changed is in the [changelog](https://github.com/PlutoKeating/Project.Quetzal/blob/main/CHANGELOG.md) and on the [download page](/download).
