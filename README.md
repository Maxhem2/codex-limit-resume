# Codex Queue

Queue messages while out of usage and auto-continue individual chats when it resets.

Supports **Codex for Windows 26.930.3930.0**. Requires **Node.js 18 or newer**.

## Install

1. Download the [latest ZIP](https://github.com/Maxhem2/codex-limit-resume/archive/refs/heads/main.zip).
2. Extract it and run `Install.cmd`.
3. Close Codex, then open the **Codex Queue** desktop shortcut.

The installer creates a modified local copy. Your regular Codex shortcut still opens the original app.

## Use

- While limited, type and send normally. The message waits above the chat box until both usage limits allow sending.
- Use the clock button between the microphone and Send to toggle **auto-continue** for that chat.
- Goals stopped by usage limits use **Resume goal** after refill. Other chats send **Continue**. Manual goal pauses are respected.
- The trash button cancels a queued action. Deleting automatic **Continue** or **Resume goal** also turns its toggle off.
- With [Codex Auth](https://github.com/Loongphy/codex-auth), it switches to a saved account with usage remaining. Account switches apply without reopening Codex; active chats finish first.

Keep Codex Queue running. It checks for resets in the background. Supports plain text in existing local chats; sending works normally when usage is available.

## Update

Download and extract the newest release, then run `Install.cmd` again. It detects the existing Codex Queue copy and updates it while keeping a rollback backup.

## Uninstall

Close Codex Queue and run `Uninstall.cmd`. Your chats are kept. Use your regular Codex shortcut afterward.

Unofficial mod. MIT license.
