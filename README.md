# Pocket Claude

Claude Code running on a Mac, driven from an Android phone through a chat that lives inside an app styled like a social network. Paired Windows computers lend their workspace (VS Code extension) or just their clipboard (PocketClipboard) to the same chat.

Everything between devices is end-to-end encrypted; the relay only sees ciphertext.

## Parts

| Path | What it is |
|---|---|
| `apps/brain` | Mac daemon: runs Claude Code (Agent SDK), owns sessions, permissions and paired devices. CLI `pocket-claude pair \| relay \| status`. Each Mac chat works in its own sandbox folder. Chats of invited people run in chat-only mode (no files). Every chat gets `pc_*` tools for the person's own PocketClipboard computer (clipboard, screenshots), `computer` for computer use there, and `chat_*` tools to switch its own model. |
| `apps/relay` | Relay: Cloudflare Worker (`worker.ts`) or Node server (`node-server.ts`) on the same core. Routing, offline queues, pairing. The Node server also serves the Mini App. |
| `apps/mobile` | Expo / React Native app (Android, iPhone) and, as a web build, the Telegram Mini App. The chat is in Direct. |
| `apps/executor-extension` | VS Code extension: executes tool calls in the open workspace, has a chat panel. |
| `apps/clipboard-agent` | `PocketClipboard.exe` for Windows: shares the clipboard with the phone, lends Claude its screen, mouse, keyboard and windows for computer use, and shows the chat with Claude in a small overlay window in the corner, where you can also write to it and pick its model and thinking level (double-tap Alt shows it, one Alt tap or Esc hides it; dark or light). |
| `apps/telegram-bot` | Telegram bot run by the brain daemon (`pocket-claude telegram <token>`): a permanent keyboard for the PC clipboard, screenshots and chats with Claude, “Code → PC” / “Reply → PC” under every reply, one linked account per person; opens the Mini App. |
| `packages/protocol` | Crypto, envelopes, message schemas, pairing. |
| `packages/transport` | `DeviceLink` (authenticated, encrypted WebSocket link) and `joinAccount` (pairing). |
| `packages/client-core` | Chat state and formatting shared by the phone, the VS Code panel and the overlay. |

## Development

```sh
pnpm install
pnpm test          # vitest, all packages
pnpm typecheck     # tsc, all packages
pnpm tsx tools/scripts/dev-stack.ts   # local relay + brain + fake executor, prints a pairing link
```

The phone app: see `apps/mobile/README.md`.

## Install

- Mac: `apps/brain/install/install.sh` sets up LaunchAgents for the relay, the brain and a sleep blocker.
- Windows: `tools/scripts/make-usb.sh` builds a folder with `PocketClipboard.exe` and the VS Code extension. A friend's laptop needs only the exe: run it, paste the link from the phone (chat → phone icon → Add a computer), done.
- A friend: the owner opens Settings → Invite a person and shows the QR code; the friend scans it with Pocket, picks a name, then adds their computer and links Telegram from Settings. Their chats answer from the Mac without any access to its files.
- iPhone: `npx expo run:ios --device --configuration Release` in `apps/mobile` on the Mac (Xcode needed); see `apps/mobile/README.md`.

## Voice calls

The phone icon in a chat starts a call: speech is recognised on the phone, a short pause sends the sentence to the same chat, and the reply is read aloud as it streams. The call keeps going with the screen off (iOS background audio). On a call Claude answers in a few spoken sentences and uses the `pc_*` tools for "put this command in my clipboard", "take a screenshot", "read my clipboard"; `computer` for "open PowerShell and run…", and `chat_configure` for "switch to Fable". A permission question is asked aloud and a spoken "yes" answers it. Needs the native modules `expo-speech-recognition`, `expo-speech`, `expo-audio`: rebuild the app after pulling.

## Model and thinking by voice

In a chat or on a call, "switch to Fable and think at maximum" makes Claude call `chat_configure`: the phone's model and thinking chips change at once, and the new model answers from the next reply on (never in the middle of one). `chat_models` lists what the Mac's Claude Code offers; names, aliases (`fable`, `opus`, `sonnet`, `haiku`) and full `claude-…` ids are accepted, and a thinking level a model lacks steps down to the nearest one.

## A sandbox per Mac chat

A new chat on the Mac without a picked project works in its own folder, `~/Documents/pocket-workspace/chats/<day>-<id>/`, which stays after restarts and after the chat is deleted. Claude keeps `NOTES.md` there as the chat's memory and gets it back, with the folder's file list, every time the chat starts; attachments land in `attachments/`. Older chats stay in the shared folder so their conversation resumes.

Shell commands of Mac chats run in Claude Code's macOS sandbox (Seatbelt): no permission prompt inside it, writes only in the working folder and temp, network through a proxy where GitHub, npm and PyPI are open and other hosts are asked on the phone ("for this chat" remembers that host). Edits in the chat's own folder need no approval; a picked project still asks. `POCKET_SANDBOX=off` turns the sandbox off, `POCKET_SANDBOX_DOMAINS="a.com,*.b.com"` opens more hosts.

## Computer use

With PocketClipboard on a Windows computer, Claude can operate it like a person at the keyboard: "open PowerShell and type `dir`", "open the site in Chrome and see what is wrong with the slide", "close Notepad". The `computer` tool follows Anthropic's computer-use actions (screenshot, clicks, drag, scroll, type, key, zoom, wait) plus windows (list, focus, minimize, maximize, restore, close), `open` for programs, files and URLs, and several displays. Coordinates are pixels of the latest screenshot (one display, up to 1280×800); the Mac maps them to physical pixels, so 125–150 % scaling works, and every action returns a fresh screenshot.

API billing: a chat runs on the Claude subscription; say "switch to the API" (or "переключи на API, Opus") and from the next reply it bills the owner's Anthropic API key instead, straight to api.anthropic.com; "back to the subscription" undoes it. The key lives only in `~/.pocket-claude/anthropic-api-key` (mode 600): `pocket-claude api-key set` (reads it from stdin), `status`, `remove`. Invited people's chats cannot use it.

It is off on every computer until its owner runs `PocketClipboard.exe computer on` there (`computer off` turns it off again), so nobody else's PC can be driven without them. The first action in a chat asks once on the phone, in Telegram or aloud on a call, and covers the whole chat; `pocket-claude allow add computer` allows it for good. ⏹ or the kill switch stops a step midway and lets go of held keys. Windows does not let a normal program type into windows running as administrator, UAC prompts or the lock screen. Rebuild and reinstall `PocketClipboard.exe` (`apps/clipboard-agent/scripts/build-exe.sh`) to get it.

## Screen watch — «Claude смотрит»

Use **👁 Смотреть экран** in a chat, on the call screen, or in the Windows overlay. Voice requests such as “смотри за экраном”, “хватит смотреть” and “скажи, когда закончится сборка” use `screen_watch`. Watching belongs to one chat and its selected Windows PC, never another person's computer.

PocketClipboard compares small frames locally in its persistent PowerShell host. Only a settled, significant change sends a JPEG up to 1280×800, with the foreground window/process and changed area, over the existing E2E channel to the Mac. Images are not written to the PC's disk. Empty or `[quiet]` observations are neither shown nor spoken.

Defaults are a 1-second sample interval (configurable from 0.5 to 3 seconds), 1.5-second settling, and hard ceilings of 4 observation turns per minute and 60 per hour. Exceeding a limit pauses observation with a notice. Watching stops after 15 minutes without a user message, on lock/sleep, PC disconnection, or the kill switch; reconnecting does not restart it.

User messages automatically receive a frame no older than 10 seconds, requesting a fresh one when needed. Only **watch** images age out of Claude's context (2 turns by default). Ordinary `pc_screenshot`, `computer` screenshots/zoom, and user attachments keep their existing quality and history. Claude can zoom or take a manual screenshot when a watch frame is too small to read. On calls, observations wait for a conversational pause and play a short signal before speaking.

Update brain, mobile and PocketClipboard together. Real capture, lock/sleep, idle CPU and native call audio need the Windows/phone acceptance checks in [TZ-vision.md](TZ-vision.md); Linux/web tests cannot prove them.

## Telegram Mini App

The same app inside Telegram, served by the Node relay on the Mac over its public HTTPS address (Tailscale Funnel):

```sh
pnpm --filter @pocket/mobile export:web      # apps/mobile/dist; the relay picks it up on restart
pocket-claude telegram app                   # or: telegram app https://host/  — the bot's menu button and /app open it
```

`/app` in the bot sends a button with a one-time pairing code, so the app pairs itself as another device of the same person. Credentials stay in the WebView's localStorage; nothing is stored with Telegram. `STATIC_DIR=` (empty) stops the relay from serving the app; `EXPO_PUBLIC_RELAY_URL` at export time points a build hosted elsewhere at the relay.

## Roadmap

See `PLAN.md` (in Russian). Wave 3, with the hour-by-hour plan: switching the model by voice, a sandbox per Mac chat, computer use through PocketClipboard. Wave 2 (compact overlay with themes, chat-only mode and PC tools for invited people, the permanent Telegram keyboard, iOS performance, brand personas, QR onboarding and voice calls) is kept below it. Both are implemented and await hands-on acceptance on the devices.
