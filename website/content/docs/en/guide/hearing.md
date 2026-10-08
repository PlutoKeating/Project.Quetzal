---
title: Hearing and the microphone
description: Once hearing is on, where the sound from the microphone goes, where it is kept, and who gets what.
---

Hearing is off by default. Turn it on under **Control → Sound → Listen to you**, and the agent can hear you talk. This page follows the sound from the microphone to the agent, step by step.

## Before you turn it on

- You need an Azure Speech key, entered under **Control → Sound**. Recognition and the agent's own voice use the same key; without one, hearing cannot be turned on.
- On Android, allow the app to use the microphone. While the app uses the microphone in the background, the system shows a persistent notification.

## Where the sound goes

1. **Split into sentences on the device.** The console app (the desktop console on a computer) keeps the microphone open and uses voice activity detection (WebRTC VAD) on the device to tell whether someone is speaking. While nobody speaks, nothing is sent anywhere.
2. **One sentence goes to the runtime.** Only when it detects speech is that stretch of sound sent to the runtime, which usually runs on the same device.
3. **Recognized with your Azure key.** The runtime sends that stretch of sound to Azure speech recognition, using your own key and region.
4. **The agent decides whether you were talking to it.** The recognized text enters the conversation as something it heard, and the agent decides whether it was meant for it. If not, it does not answer, and the line is hidden in the conversation.

## Where it is kept

- **Microphone audio is not saved**; it is dropped once recognized.
- **The recognized text** is kept in the conversation history on the device, like typed messages, and is sent to your model provider like any other conversation. The agent may also write what it heard into memory, as it does with other conversations.
- **When several phones hear the same sentence**, they exchange its text and timing over their encrypted connection and keep only one copy.
- **The agent's own voice** (the synthesized speech) is kept on the device, the most recent 50 clips only.

## Who gets what

| Who | What they get |
|---|---|
| Azure Speech (your own account) | The stretches of sound where someone was speaking |
| Your model provider | The recognized text |
| The sync service, GitHub | Neither the sound nor the recognized text |

## When it does not listen

- During an emergency stop; when the battery is below the budget's minimum and not charging; when the device runs too hot.
- On a computer, while the agent is speaking. Computers have no reliable echo cancellation, so the ears pause while it talks.
- The web console has no microphone.
- You can turn it off any time under **Control → Sound**.

## How this differs from recording

The agent also has a "record audio" capability: it records a clip and saves it as a file. That belongs to **Microphone** under **Control → Permissions**, asks you every time by default, and is separate from hearing. See [Permissions and safety](/docs/guide/permissions).
