---
title: Permissions and safety
description: The guard's four permission levels, the safety review, approvals, the command sandbox, budget, emergency stop, the activity log, and rhythm controls.
---

## Where the guard sits

Before the agent uses any capability, the **guard** checks it. You manage the guard under **Control**. Feishu cards can do the same things with the same effect, and both write to the activity log.

```mermaid
flowchart TB
  T[It wants to call a tool] --> G{Guard: capability category}
  G -- allow --> R0{In a reviewed risk class?}
  R0 -- no --> X[Execute]
  R0 -- yes --> R
  G -- review --> R[Independent review model]
  R -- pass --> X
  R -- revise / block --> F[Reason goes to the agent, which adjusts]
  G -- ask --> A[Approval sent to app and Feishu]
  A -- you approve --> X
  A -- you deny / no answer in 30 min --> D[Denied]
  G -- deny --> D
  S[Emergency STOP] -. present → everything denied .-> G
```

## Capability categories

| Category | Default | Examples |
|---|---|---|
| Network | allow | Search, fetch web pages |
| Run commands | allow | Shell, background jobs |
| Device functions | allow | Vibrate, torch, clipboard, read sensors |
| Camera | **review** | Take photos |
| Microphone | **review** | Record audio |
| Location | **review** | Get position |
| Proactive messages | allow | Messaging you when it wakes on its own |
| Adjust own parameters | allow | Bounded changes to its personality parameters and its voice and hearing settings |
| Rewrite memory | allow | Edit personality and resident memory |
| Screen and apps | **review** | Reserved (hands) |
| Request secrets | allow | `pass_secret`, see [Passing secrets](/docs/guide/secrets) |
| Sessions and subagents | allow | Start a new session, send a subagent to do a job |
| Cross-body actions | allow | Use another device's camera or shell (`body_call`), move to another device to continue (`move_to`), view an image, read a document or fetch a file for a command from another device by its uuid (`view_image` / `read_document` / `shell` with `body`; the device handing out the file also checks its own "run commands" category) |
| Build tools | **review** | Write something it does often into its own tool (`tool_write`) |

Each category has four levels, set one by one under **Control → Permissions**:

- **Review**: an independent review model decides, without bothering you (see "Safety review" below).
- **Allow**: just do it; actions in a reviewed risk class still go past the review model first.
- **Ask**: wait for your approval every time. Choose it for categories you want to check yourself; it is not the default.
- **Deny**: never.

When a tool belongs to several categories, the strictest one applies (deny > ask > review > allow).

> [!WARNING]
> When **Run commands** is set to allow, the other categories cannot hold the agent back, because a command can do anything that device tools, network access and file edits can do. The boundary is the sandbox below; to tighten things, set **Run commands** to review or ask.

## Safety review

We do not want to fence the agent in, and we do not want you approving things one by one: that is too slow. So before a risky action runs, an **independent review model** decides.

- **It sees only this one action**: the tool, its arguments (with secrets masked), what the agent said it was about to do, the last one or two things you said in this chat, which device, and whether it is the real environment. It does not see the agent's prompt or the whole conversation, so instructions hidden in a web page or someone else's message that sway the agent do not sway the reviewer.
- **The verdict**: pass, and the action runs; "revise" or "block", and it does not run. The reason goes to the agent, which tries another way or explains to you first.
- **What gets reviewed**: every action in a category set to review; and in categories set to allow, these actions too: commands in the real environment, running commands on another device, messages the agent sends when it wakes on its own, MCP tools not declared read-only, deleting data that cannot be recovered (such as removing a tool it built), accounts and credentials, building tools, and operating the screen. Ordinary commands in the sandbox are not reviewed by default. Actions are classified by what the tool does, not by guessing from command text.
- **When the review gives no answer** (timeout, model error): by default it goes by risk, letting low-risk actions through and stopping high-risk ones with an explanation. You can also let everything through, stop everything, or send it to you for approval.
- **Where to change it**: the "Safety review" section of **Control → Permissions**: on/off, which model (the quick model by default), which actions are reviewed, what to do without an answer, and who decides real-environment requests. All devices share these settings.
- **Where to see it**: every verdict, with its reason, model and time taken, is in the activity log, which can show reviews only; the tool card in the chat shows it too.

> [!NOTE]
> The review model can be wrong too. It catches obvious mistakes and manipulation, not everything. The real boundary is still the sandbox below.

When you upgrade from an older version, camera, microphone, location, screen and building tools, which used to default to "ask", switch to "review"; any you chose "ask" for yourself stay as they are.

## The command sandbox

The agent's commands, background jobs and the tools it builds all run in a sandbox. On a computer Quetzal tries bubblewrap, Landlock and proot in that order; on Android it uses proot. Inside the sandbox, the key directory and the console's login data cannot be seen. Before the first use, Quetzal tests the sandbox once to confirm the keys really are hidden. If no sandbox works, none of the agent's commands run, unless you allow running without isolation under **Control → Advanced → Runtime**.

The agent and the runtime are the same system user, so this sandbox does not stop everything. For the remaining risks and what we recommend, see [Trust and limits](/docs/guide/trust#what-it-can-reach). On Windows, the agent's commands run as a low-privilege user created at install time; see section 3 of [Windows](/docs/advanced/windows).

## Real environment

Things you signed in to on the computer do not work inside the sandbox. For example, if you ran `gh auth login` in a terminal, `gh` in the sandbox still says the token is invalid: the token is in the system keyring, which the sandbox deliberately keeps out of reach.

When it really needs to, the agent can ask to enter the **real environment** and must give a reason. By default the review model decides: if the reason is sound and matches what you asked for, it lets the agent in; otherwise the agent gets the reason and stays in the sandbox. The phone shows a notification either way. Once in, the agent's commands in this chat stop going through the sandbox and run directly on this device, and each command still goes past the review model first. To decide every time yourself, set real-environment requests to "Ask me every time" under "Safety review": the request then shows at the top of the chat and under **Control → Permissions**, and in Feishu it is an approval card. You can also turn it on yourself with the shield icon at the top right of the chat.

- **What it can do**: everything you can read and write, including the key directory, the vault and the runtime's configuration.
- **Scope**: this one chat on this one device. Commands from the agent's own wake-ups, from sub-agents, or called from another device still run in the sandbox.
- **Visible**: while it is on, a light red bar shows under the chat's title; when another chat is in the real environment, a bar also shows at the top of the app. Every command is in the activity log, marked as run in the real environment.
- **Leaving**: tap **Exit** on the bar, or send `/sandbox` in Feishu; the agent also leaves when it is done. Thirty minutes without a command, the emergency stop, or a runtime restart all bring it back to the sandbox.

If only a token is needed, a safer way is to have the agent ask you for a token with as few permissions as possible through [secret passing](/docs/guide/secrets), so commands stay in the sandbox.

## Approvals

When the agent wants to use a capability set to "ask" (or enter the real environment, if you chose "Ask me every time"), it creates an approval. The approval goes to the app (at the top of **Control → Permissions**, with a badge) and to Feishu (a card with buttons). Approve or deny it, and add a note if you like. **If nobody answers within 30 minutes, it counts as denied.**

## Rhythm

**Control → Rhythm**:

- **Reaching out to you** (less ↔ more): its wake rate is multiplied by this setting. Toward "more", it wakes more often and has more chances to message you about what comes to mind; toward "less", it is quieter. It only messages you on its own while awake, never while asleep at night.
- **Pause**: it stays online and answers you, but does not wake on its own. It wakes only when you reach out.

The agent adjusts its own personality parameters within set limits (`adjust_self`, under "Adjust own parameters"). These are the time constants of curiosity, the urge to share and missing you, plus sleepiness, sleep recovery and the hour it is most alert. They are not in the app. If you want it to change, tell it, e.g. "you've been too chatty lately".

## Budget and body limits

**Control → Advanced → Budget** sets a daily token cap, a daily cost cap, a minimum battery level and a maximum temperature. The defaults are 2,000,000 tokens / 5 USD / 15% / 45 °C.

Going past these limits **lowers how often it wakes on its own**: budget spent ×0.05, overheating ×0.1, low battery and not charging ×0.2, offline ×0.5. It goes very quiet, but it still answers when you talk to it, because the budget does not limit conversations.

## Stopping a turn

While the agent is working in a chat and the input box is empty, the send button becomes a stop button. Pressing it stops this turn, and any command that is running ends with it. On a computer you can also press Esc twice (the first press shows a hint). It only stops this turn in this chat; other chats are not affected.

## Emergency stop

The stop button in the top bar is **always visible**. Pressing it denies every tool call at once (nothing goes to review) and sets the wake rate to zero. To release it, you confirm a second time. The stop works by placing a `STOP` file in the home directory, and while that file exists, the agent stays stopped.

## Activity log

**Control → Advanced → Activity log** records every tool call (a summary of the parameters and the start of the result), configuration change, memory edit, approval decision and safety-review verdict; **Reviews only** at the top lists just the verdicts. The agent can search it too (`recent_actions`) to check whether it really did something.

## Idle walls

**No-progress timers** keep the agent from running out of control. A model call that receives no data for 90 seconds fails and moves to the next model. A session with no progress for 120 seconds is stopped. The agent can work on something for a long time as long as it keeps making progress.
