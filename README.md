# Codex Queue

Queue messages while out of usage and auto-continue individual chats when it resets.

Supports **Codex for Windows 26.930.3930.0**. Requires **Node.js 18 or newer**.

## Install

1. Download the ZIP from the [latest release](https://github.com/Maxhem2/codex-limit-resume/releases/latest).
2. Extract it and run `Install.cmd`.
3. Close Codex, then open the **Codex Queue** desktop shortcut.

The installer creates a modified local copy. Your regular Codex shortcut still opens the original app.

## Use

- While limited, type and send normally. The message waits above the chat box until both usage limits allow sending.
- Use the clock button between the microphone and Send to toggle **auto-continue** for that chat.
- The trash button cancels a queued message. Deleting an automatic **Continue** also turns its toggle off.

Keep Codex Queue running. It checks for resets in the background. Supports plain text in existing local chats; sending works normally when usage is available.

## Update

Download and extract the newest release, then run `Install.cmd` again. It detects the existing Codex Queue copy and updates it while keeping a rollback backup.

## Uninstall

Close Codex Queue and run `Uninstall.cmd`. Your chats are kept. Use your regular Codex shortcut afterward.

Unofficial mod. MIT license.
