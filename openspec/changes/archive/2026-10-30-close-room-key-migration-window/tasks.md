# Tasks

## 1. Remove runtime migration gates

- [x] 1.1 Delete `hasCanonicalRoomKeyColumns()` and `activeRoomKeyColumns` cache from `src/agent/roomKey.ts`; hard-code canonical-key reads/writes at all call sites
  - Verify: `grep -R hasCanonicalRoomKeyColumns src` returns no matches; `bun run typecheck` passes
- [x] 1.2 Update `src/agent/index.ts:459` so `internalRoomId = roomIdentity.roomKey` unconditionally
  - Verify: new room creation path uses canonical key only (unit test asserts `chat_rooms.id === room:<platform>:<chatId>`)
- [x] 1.3 Update `src/agent/index.ts:452` so `roomIdentityCondition` queries `room_key` only; drop the legacy `chat_room_id` OR branch
  - Verify: room-scoped query returns no row when `room_key` is NULL even if `chat_room_id` matches
- [x] 1.4 Update `src/tools/ReminderTool.ts:375` so `canonicalRoomId = roomIdentity.roomKey` unconditionally
  - Verify: reminder room resolution uses canonical key only
- [x] 1.5 Update `src/messaging/OutboxService.ts` so `roomKeyColumn = 'room_key'` always; drop `hasRoomKeyColumn` conditionals
  - Verify: outbox claim/query selects `room_key` regardless of schema detection

## 2. Remove test seam and update pinned tests

- [x] 2.1 Delete `setRoomKeyColumnsForTesting()` from `src/agent/roomKey.ts`
  - Verify: `grep -R setRoomKeyColumnsForTesting src test` returns no matches
- [x] 2.2 Update `test/roomKey.test.ts` to the canonical-only contract (no dual-read/dual-write, no `setRoomKeyColumnsForTesting`)
  - Verify: `bun test --no-env-file test/roomKey.test.ts` passes
- [x] 2.3 Add a test asserting legacy-only rows (NULL `room_key`) are not returned by room-scoped queries
  - Verify: `bun test --no-env-file test/roomKey.test.ts` includes and passes the new scenario

## 3. Update spec contract

- [x] 3.1 Confirm `openspec/changes/close-room-key-migration-window/specs/room-identity/spec.md` (delta spec) matches final code behavior
  - Verify: `openspec status --change close-room-key-migration-window --json` reports specs `done`; spec and code agree on canonical-key-only queries

## 4. Verify full gate

- [x] 4.1 Run `bun run check` (lint + typecheck + test + `drizzle-kit check`)
  - Verify: all checks pass, no new warnings (`--max-warnings=0`)
- [x] 4.2 Run `bun test test/migration.test.ts` to confirm migration state unchanged
  - Verify: migration test passes; `0022_room_keys` still applied and additive

## Workflow follow-up

- Review all four artifacts (proposal, specs, design, tasks) before starting `/opsx-apply`.
- When ready, run `/opsx-apply` to implement the change using these artifacts as the plan.
