# Proposal

## Why

ElastraX's canonical room identity (`room:<platform>:<remoteRoomId>`) was introduced by migration `0022_room_keys` with an explicit "migration window": queries read both the canonical `room_key` column and the legacy `chat_room_id` column, and new room rows fall back to the raw provider ID when `room_key` columns are absent. No pre-0022 databases remain in the wild, so the fallback is dead weight — it adds runtime branching, test seams, and a rollback safety story that no longer applies. Closing the window means the code assumes `room_key` columns always exist and always holds the canonical database identity.

## What Changes

- Remove the `hasCanonicalRoomKeyColumns()` runtime gate and the legacy `chat_room_id` OR-branch from room lookups (`src/agent/roomKey.ts`, `src/agent/index.ts`, `src/tools/ReminderTool.ts`, `src/messaging/OutboxService.ts`). Always use the canonical `room_key` as `chat_rooms.id` on insert and read `room_key` only on query.
- Remove the `setRoomKeyColumnsForTesting()` test seam.
- Outbox/inbox workers always select `room_key`; drop the `hasRoomKeyColumn` conditional.
- Update the `room-identity` spec: drop the "legacy fallback during the migration window" requirement; revise "Additive migration" and "Rollback safety" since legacy columns are no longer retained as a readable room identity.
- **BREAKING**: All databases must be on migration `0022` or later with `room_key` backfilled for every `chat_rooms` row. Legacy rows whose `room_key` is NULL become unreachable by canonical key unless backfilled before the window closes.

## Capabilities

### Modified Capabilities

- `room-identity` (`openspec/specs/room-identity/spec.md`) — Requirements change: "Queries prefer room_key with legacy fallback" becomes canonical-key-only; "Additive migration" and "Rollback safety" no longer describe retained legacy columns as a safe rollback path.

## Impact

- Code: agent loop, reminder tool, outbox/inbox workers, scheduler, flow handler, role tool — every reader/writer of `room_key` vs `chat_room_id`.
- Tests: `test/roomKey.test.ts` pins the dual-read/dual-write contract and `setRoomKeyColumnsForTesting`; both must be updated.
- Migrations: migration `0022` stays applied and additive; no new migration is required for the code change, but operators must ensure `room_key` is backfilled before deploying the post-window code.
- Docs: `docs/room-identity-migration.md` "Runtime contract" references the migration window and legacy fallback.
