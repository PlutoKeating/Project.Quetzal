---
title: "Canvas: writing documents and code together"
description: An editing area next to the conversation. Long documents and code go there and you and the agent edit them together; every change is a version, code runs in one click, and you can comment on a selection.
---

## What it is

Longer things — a plan, an article, notes, a script — are awkward in chat bubbles: changing one word means resending the whole thing, and versions drift apart. Canvas is a separate editing area next to the conversation. The agent puts this kind of content there, and the two of you edit the same copy.

Each conversation can have several canvases. Each one is a **Markdown document** or a piece of **code** in a given language.

- **On a computer** (desktop app or web console): click the Canvas button in the conversation's title bar and a column opens to the right of the chat; drag the divider to resize. When the agent creates a canvas in this conversation, the column opens by itself.
- **On a phone**: tap the Canvas button at the top right of the conversation to open a full-screen Canvas page.

## Editing together

- A **document** switches between *Preview* and *Edit*: preview renders the Markdown (formulas, tables and Mermaid diagrams included), edit shows the source.
- **Code** is edited directly, in a monospace font, with keywords, strings and comments coloured.
- **Save** (the button or Ctrl+S) creates a new version. If the agent changes the canvas while you are not editing, the panel switches to the new content right away; while you are editing, a bar at the top says it changed — load its version or save yours. Both stay in the history; nobody overwrites anybody.
- **Version history**: who changed each version, when, and the change note. Open any version and *Restore* it if you like it better (restoring creates another new version; the earlier ones stay).
- **Copy and export**: copy the whole text, or export it as a file (`.md` for documents, `.py`, `.js`… for code).

Before every reply the agent sees this conversation's canvases, with your changes marked — so you can just say "I rewrote the second paragraph, have a look".

## Running code

When a code canvas is Python, JavaScript, TypeScript, shell or PowerShell, the toolbar has *Run*:

- The code runs on the body the agent is on, **in the same sandbox as the agent's commands**, so it cannot see the runtime's keys;
- It stops after a while without any output, after 15 minutes at most, and very long output keeps only its beginning and end;
- The result shows at the bottom of the panel: exit code, standard output and error output. Images the code saves (for example a matplotlib figure saved with `plt.savefig("plot.png")`) appear there too;
- The agent sees the results of your runs and can fix the code from them; it can also run the code itself, and you see those results in the panel as well.

Running belongs to the *Run commands* permission: set it to *Ask every time* under **Control → Permissions** and every run asks you first.

If the machine has no Python, it says so plainly instead of pretending to run: the Windows installer sets up Python 3; on Linux install `python3` with the system package manager; the Android app does not include Python yet.

## Comments

- Select some text while editing (a selection in the preview works too — it is looked up in the source) and choose *Comment on selection*; with nothing selected you comment on the whole document.
- *Send to the agent* is ticked by default: the comment goes into the conversation as a message, together with the selected passage and its line numbers. The agent can reply, mark it resolved, or simply rewrite that passage.
- The agent also comments on passages by itself, or offers an **edit suggestion** ("suggest changing this sentence to …"). Click *Accept* and the passage is replaced with the suggested text.
- When the content changes, a comment follows the passage it is about; if that passage is rewritten, the comment is marked *outdated*.
- Comments can be replied to, resolved and reopened. When the agent changes a canvas or adds a comment, the Canvas button shows a badge.

## Several bodies

Canvases (all versions, comments and run results) sync between the agent's bodies just like the conversation: start on your phone, continue on your computer. Images produced by a run stay on the body that ran it; panels elsewhere say they are not available there.

## Implementation details

Tables, replication rules and the tool definitions are in [ARCHITECTURE.md §5.5](https://github.com/PlutoKeating/Project.Quetzal/blob/main/docs/ARCHITECTURE.md) in the source repository; the console's methods are listed in the [gateway API](/docs/reference/gateway-api).
