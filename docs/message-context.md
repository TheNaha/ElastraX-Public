# MessageContext

`MessageContext` (`src/core/MessageContext.ts`) is the cross-platform contract for incoming messages. Every provider (WhatsApp/Baileys, Discord/discord.js, Telegram/grammY) translates its raw payload into a `MessageContext` before the core agent sees it. The agent and tools never interact with raw provider objects directly.

## Interface

| Field | Type | Required? | Purpose |
|---|---|---|---|
| `platform` | `'whatsapp' \| 'discord' \| 'telegram' \| (string & {})` | yes | Platform name. Open union so new providers don't require type edits everywhere. |
| `chatId` | `string` | yes | Raw provider room id (WhatsApp JID, Discord channel id, Telegram chat id). **This is the only value providers may use for I/O.** |
| `roomKey` | `string` | no | Canonical platform-scoped room key `room:<platform>:<remoteRoomId>`. Used for every database lookup. Optional because providers and test fixtures construct contexts directly; production `AppRuntime` resolves and attaches it before the message is admitted to the inbox. |
| `deniedToolNames` | `readonly string[]` | no | Tool names that must not run for this message. Used by scheduled agent runs. |
| `senderId` | `string` | yes | Sender identifier. |
| `senderName` | `string` | yes | Sender display name. |
| `senderPn` | `string` | no | Phone-number JID (e.g. `6281234567890@s.whatsapp.net`). Present on WhatsApp when `senderId` is a LID. Used by `AuthService` to match `BOT_OWNER_JID` and DB role entries. |
| `text` | `string` | yes | Message text. |
| `isGroup` | `boolean` | yes | Whether the chat is a group. |
| `mentionedIds` | `string[]` | no | Mentioned user IDs. |
| `isBotMentioned` | `boolean` | yes | True if the bot was explicitly mentioned. Providers calculate this from platform-specific mention syntax/IDs. |
| `receivedAt` | `number` | no | Unix timestamp (ms) of receipt. Used by `PingTool` for round-trip latency. |
| `language` | `string` | no | Active language for this room (`'en'` \| `'id'`). Populated by the agent before invoking tools. Defaults to `'en'`. |
| `messageType` | `string` | yes | Canonical Baileys message type (e.g. `imageMessage`, `audioMessage`, `conversation`). View-once messages are unwrapped to their inner type. |
| `hasMedia` | `boolean` | yes | True if the message contains image/video/audio/document. |
| `mediaPath` | `string` | no | Local cached path of downloaded media. |
| `mimeType` | `string` | no | MIME type of the media. |
| `mediaReady` | `Promise<void>` | yes | Resolves once lazy media acquisition has completed. Constructing a context does not start downloads. |
| `mediaAttachments` | `MediaAttachmentDescriptor[]` | no | Attachment descriptors with `id`, `index`, `origin` (`current`\|`quoted`), `state` (`pending`\|`ready`\|`skipped`\|`error`), `providerId`, `filename`, `mimeType`, `sizeBytes`, `mediaPath`, `error`. |
| `selectedAttachmentId` | `string` | no | Currently selected attachment id. |
| `selectMediaAttachment` / `getMediaAttachment` | function | no | Attachment accessors. |
| `quoted` | `{ messageType, body, text, senderId, hasMedia, stanzaId?, mediaPath?, mimeType?, rawMessage }` | no | Quoted/replied-to message context. |
| `messageId` | `string` | yes | Unique provider message id. |
| `rawMessage` | `RawProviderMessage \| null` | yes | Raw original provider metadata. Nullable: the scheduled-task path builds a synthetic context with no provider message behind it. |
| `signal` | `AbortSignal` | no | Cancellation signal for the current turn. The agent passes it to `sendMessage`/`reply` so a shutdown or timeout aborts in-flight output. |

## Outgoing capabilities

| Method | Signature | Purpose |
|---|---|---|
| `reply` | `(text, options?) => Promise<void>` | Send text back to the same chat. `options.mentions` for WhatsApp @mentions; `options.signal` for cancellation. |
| `sendTyping` | `() => Promise<void>` | Show typing/composing presence. |
| `sendMessage` | `(text, options?) => Promise<unknown>` | Send text and return a key/handle for `editMessage` (streaming responses). |
| `sendToChat` | `(chatId, text, options?) => Promise<unknown>` | Send to a different chat (optional). |
| `editMessage` | `(key, text) => Promise<void>` | Edit a previously sent message by key (streaming updates). |
| `react` | `(emoji) => Promise<void>` | React with an emoji. |
| `downloadMedia` | `(attachmentId?) => Promise<Buffer \| null>` | Download media buffer from current or quoted message. |
| `sendMedia` | `(buffer, options?) => Promise<void>` | Send binary media (image/audio/video/document). `options.ptt` for WhatsApp voice notes. |
| `sendSticker` | `(buffer) => Promise<void>` | Send a composed WebP sticker natively. |
| `deleteMessage` | `(key?) => Promise<void>` | Delete a message (defaults to current incoming). WhatsApp: only bot's own messages deletable for everyone. |
| `forwardMessage` | `(targetJid, text?) => Promise<void>` | Forward to another chat JID/channel id. |
| `updateGroupParticipants` | `(action, userIds) => Promise<void>` | Group admin: add/remove/promote/demote. |
| `getGroupInviteLink` | `(chatId) => Promise<string>` | Group invite link. |
| `setGroupSettings` | `(chatId, setting) => Promise<void>` | `announcement` \| `not_announcement`. |
| `leaveGroup` | `() => Promise<void>` | Leave the current group. |
| `checkPermissions` | `(required) => Promise<boolean>` | Check whether the sender holds a role. |
| `resolveRoles` | `() => Promise<string[]>` | Resolve the full set of roles the sender holds (always includes `'user'`). |

## Room identity contract

- `ctx.chatId` is the raw provider room id — the only value sent to providers.
- `ctx.roomKey` is the canonical database identity (`room:<platform>:<chatId>`).
- `message_inbox.room_key` and `message_outbox.room_key` are the durable dispatch identities.
- Inbox/outbox workers refuse to send a canonical key to a provider; they use `chat_room_id` for delivery.
- `AppRuntime.attachRoomKey(ctx)` resolves `roomKey` from `platform + chatId` and attaches it to the context before any durable row is written.

## Provider responsibilities

Providers must:
1. Populate `receivedAt` before emitting the message event.
2. Calculate `isBotMentioned` from platform-specific mention syntax.
3. Begin lazy media downloads and resolve `mediaReady`.
4. Set `mediaPath` / `mimeType` once downloaded.
5. Never receive `roomKey` for I/O — only `chatId`.

## Synthetic context (scheduled tasks)

Scheduled agent runs build a synthetic `MessageContext` with no provider message behind it: `rawMessage: null`, `hasMedia: false`, `mediaReady: Promise.resolve()`, no-op `sendTyping`/`editMessage`/`react`, `downloadMedia` returns `null`, and mutating methods (`sendMedia`, `sendSticker`, `deleteMessage`, `forwardMessage`) throw `ScheduledTaskCapabilityError`. The scheduler runs with the baseline `user` role only.

## Verification

```
bun test --no-env-file test/roomKey.test.ts
bun test --no-env-file test/AppRuntime.test.ts
bun test --no-env-file test/agent.test.ts
```