# Design

## Context

Migration `0022_room_keys` (journal `when=23`) is already applied in every database in scope. It added the `room_keys` registry, `room_key_conflicts` audit table, nullable `room_key` columns on `chat_rooms`, `messages`, `reminders`, `notification_subscriptions`, `message_inbox`, `message_outbox`, `user_roles`, `scope_room_key`, `flow_sessions`, plus covering indexes. The code reads the live Drizzle schema once at module load (`detectRoomKeyColumn`) and caches the active column set in `src/agent/roomKey.ts`; `hasCanonicalRoomKeyColumns()` gates every room read/write on whether `chat_rooms.room_key` exists. No pre-0022 databases remain, per the proposal.

## Goals / Non-Goals

**Goals**
- Remove every runtime branch on `hasCanonicalRoomKeyColumns()` / `hasRoomKeyColumn()`.
- New room inserts always use `room:<platform>:<remoteRoomId>` as `chat_rooms.id`.
- Room lookups query `room_key` only; no legacy `chat_room_id` OR branch.
- Remove the `setRoomKeyColumnsForTesting()` test seam.
- Provider sends still receive `ctx.chatId` (raw provider ID) — unchanged.

**Non-Goals**
- Dropping legacy `chat_room_id` columns from the schema (they remain as inert legacy data).
- Removing migration `0022` or rewriting existing `chat_rooms.id` values (backfill is an operator concern, not this change's code).
- Changing `ctx.chatId` / `ctx.roomKey` semantics at the provider boundary.

## Decisions

### 1. Always-on canonical reads/writes; remove the gate

**Decision:** Delete `hasCanonicalRoomKeyColumns()` and the `activeRoomKeyColumns` cache from `src/agent/roomKey.ts`. All call sites hard-code canonical-key behavior:

- `src/agent/index.ts:459`: `internalRoomId = roomIdentity.roomKey` (was `hasCanonicalRoomKeyColumns() ? roomKey : chatId`).
- `src/agent/index.ts:452`: `roomIdentityCondition` queries `room_key` only (drop the `chat_room_id` OR branch).
- `src/tools/ReminderTool.ts:375`: `canonicalRoomId = roomIdentity.roomKey` (was gated).
- `src/messaging/OutboxService.ts`: `roomKeyColumn = 'room_key'` always (was `hasRoomKeyColumn(...) ? 'room_key' : "''"`).

**Alternative considered:** Keep the gate behind an env flag (`ELASTRAX_ROOM_KEY_WINDOW_CLOSED`). **Rejected:** no pre-0022 databases exist, so the flag is dead code; simpler to remove entirely.

### 2. Remove the test seam

**Decision:** Delete `setRoomKeyColumnsForTesting()` from `src/agent/roomKey.ts`. Tests that exercise post-migration shape now run against a schema that has `room_key` columns; tests that exercise legacy shape cannot be supported without re-adding the gate.

**Alternative:** Keep the seam as a no-op. **Rejected:** a no-op seam is misleading and `roomKey.test.ts` pins the dual-read contract that this change removes.

### 3. No destructive schema migration in this change

**Decision:** Do not add a new migration that rewrites `chat_rooms.id` from raw provider ID to canonical key, and do not drop legacy `chat_room_id` columns. The code assumes `room_key` is populated; operators backfill NULL `room_key` rows before deploying (see Migration Plan).

**Alternative:** Add migration `0025` to backfill `chat_rooms.id` → canonical key and cascade FK updates. **Rejected:** `chat_rooms.id` is a primary key referenced by FKs across messages/reminders/subscriptions; rewriting it is destructive, non-additive, and out of scope for closing the code-level window.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Legacy `chat_rooms` rows with NULL `room_key` become unreachable after deploy | Operator backfill step before deploy (Migration Plan); add a startup validation that fails fast if any row lacks `room_key` |
| `room_key_conflicts` holds unresolved ambiguities from the backfill | Audit `room_key_conflicts` before deploy; unresolved conflicts must be resolved or they break canonical-key uniqueness assumptions |
| `roomKey.test.ts` pins dual-read/dual-write and `setRoomKeyColumnsForTesting` | Update tests to the canonical-only contract as part of this change |
| `OutboxService` claim/query paths use `hasRoomKeyColumn` in multiple places | Single code path change: always select `room_key` |

## Migration Plan

1. **Pre-deploy data check:** run `SELECT * FROM chat_rooms WHERE room_key IS NULL` (and equivalent for `messages`, `reminders`, etc.). Backfill any NULL `room_key` from `room_keys.remote_room_id` + platform, or derive `room:<platform>:remote_room_id`.
2. **Audit conflicts:** `SELECT * FROM room_key_conflicts` — resolve any unresolved collisions before closing the window.
3. **Deploy code:** remove gates/seam as above; tests exercise canonical-only path.
4. **Rollback:** not supported to pre-window code once deployed; rollback means reverting this code change only (data stays on 0022+ schema).

## Open Questions

None deferrable within this plan.
