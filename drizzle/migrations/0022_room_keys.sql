-- V8.1 canonical room identity (additive; no destructive rebuild).
--
-- A room key is a deterministic, transparent string: `room:<platform>:<remoteRoomId>`.
-- Any stored key can be parsed back into the platform/remote-id pair without a lookup,
-- and the same remote id on two platforms always yields two distinct keys/rooms.
--
-- Every legacy column is retained (`chat_rooms.id`, `messages.chat_room_id`,
-- `reminders.chat_room_id`, `notification_subscriptions.chat_room_id`,
-- `message_inbox.chat_room_id`, `message_outbox.chat_room_id`,
-- `scheduled_deliveries.chat_room_id`, `user_roles.scope`) so a rollback to the
-- pre-0022 code is still possible without data loss. Existing rows keep their raw
-- provider room id in `chat_rooms.id`; new V8.1 rows may use the canonical room key
-- as their `chat_rooms.id` while `room_keys.remote_room_id` remains the provider id.
--
-- Backfill order is deterministic and idempotent:
--   1. one `room_keys` row per `chat_rooms` row, ordered by (platform, id);
--   2. child `room_key` columns copied from the room row first, then the registry,
--      then the derived form so no row is left NULL;
--   3. every ambiguity recorded in `room_key_conflicts` (also exposed as the
--      `room_key_collisions` view) with a deterministic fingerprint.

CREATE TABLE `room_keys` (
  `room_key` text PRIMARY KEY NOT NULL,
  `platform` text NOT NULL,
  `remote_room_id` text NOT NULL,
  `legacy_room_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_keys_platform_remote_room_unique_idx` ON `room_keys` (`platform`,`remote_room_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_keys_platform_legacy_room_unique_idx` ON `room_keys` (`platform`,`legacy_room_id`) WHERE `legacy_room_id` IS NOT NULL AND `legacy_room_id` <> '';
--> statement-breakpoint
CREATE INDEX `room_keys_legacy_room_idx` ON `room_keys` (`legacy_room_id`) WHERE `legacy_room_id` IS NOT NULL AND `legacy_room_id` <> '';
--> statement-breakpoint
CREATE INDEX `room_keys_platform_created_idx` ON `room_keys` (`platform`,`created_at`);
--> statement-breakpoint
CREATE TABLE `room_key_conflicts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `fingerprint` text NOT NULL,
  `conflict_type` text NOT NULL,
  `platform` text DEFAULT '' NOT NULL,
  `room_key` text,
  `remote_room_id` text,
  `legacy_room_id` text,
  `details` text,
  `detected_by` text DEFAULT 'migration:0022_room_keys' NOT NULL,
  `detected_at` integer NOT NULL,
  `resolved_at` integer,
  `resolution` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_key_conflicts_fingerprint_unique_idx` ON `room_key_conflicts` (`fingerprint`);
--> statement-breakpoint
CREATE INDEX `room_key_conflicts_type_detected_idx` ON `room_key_conflicts` (`conflict_type`,`detected_at`);
--> statement-breakpoint
CREATE INDEX `room_key_conflicts_platform_remote_idx` ON `room_key_conflicts` (`platform`,`remote_room_id`);
--> statement-breakpoint
CREATE INDEX `room_key_conflicts_unresolved_idx` ON `room_key_conflicts` (`conflict_type`,`resolved_at`);
--> statement-breakpoint
CREATE VIEW `room_key_collisions` AS
  SELECT `id`, `fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`,
         `legacy_room_id`, `details`, `detected_by`, `detected_at`, `resolved_at`, `resolution`
  FROM `room_key_conflicts`;
--> statement-breakpoint
ALTER TABLE `chat_rooms` ADD `room_key` text;
--> statement-breakpoint
CREATE INDEX `chat_rooms_room_key_idx` ON `chat_rooms` (`room_key`);
--> statement-breakpoint
ALTER TABLE `messages` ADD `room_key` text;
--> statement-breakpoint
CREATE INDEX `messages_room_key_created_at_idx` ON `messages` (`room_key`,`created_at`);
--> statement-breakpoint
ALTER TABLE `reminders` ADD `room_key` text;
--> statement-breakpoint
CREATE INDEX `reminders_room_key_idx` ON `reminders` (`room_key`,`is_sent`,`remind_at`);
--> statement-breakpoint
ALTER TABLE `notification_subscriptions` ADD `room_key` text;
--> statement-breakpoint
CREATE INDEX `notification_subs_room_key_idx` ON `notification_subscriptions` (`room_key`);
--> statement-breakpoint
ALTER TABLE `message_inbox` ADD `room_key` text;
--> statement-breakpoint
CREATE INDEX `message_inbox_room_key_idx` ON `message_inbox` (`room_key`,`received_at`);
--> statement-breakpoint
ALTER TABLE `message_outbox` ADD `room_key` text;
--> statement-breakpoint
CREATE INDEX `message_outbox_room_key_idx` ON `message_outbox` (`room_key`,`created_at`);
--> statement-breakpoint
ALTER TABLE `scheduled_deliveries` ADD `room_key` text;
--> statement-breakpoint
CREATE INDEX `scheduled_deliveries_room_key_idx` ON `scheduled_deliveries` (`room_key`,`scheduled_at`);
--> statement-breakpoint
ALTER TABLE `user_roles` ADD `scope_room_key` text;
--> statement-breakpoint
CREATE INDEX `user_roles_scope_room_key_idx` ON `user_roles` (`scope_room_key`,`role`);
--> statement-breakpoint
ALTER TABLE `flow_sessions` ADD `room_key` text;
--> statement-breakpoint
CREATE INDEX `flow_sessions_room_key_idx` ON `flow_sessions` (`room_key`,`updated_at`);

-- ---------------------------------------------------------------------------
-- Backfill 1/3: registry rows for every pre-existing room.
-- `created_at` is epoch milliseconds here, converted from the legacy
-- `chat_rooms.created_at` seconds value and clamped to "now" for raw-written rows.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
INSERT OR IGNORE INTO `room_keys` (`room_key`, `platform`, `remote_room_id`, `legacy_room_id`, `created_at`)
SELECT
  CASE WHEN substr(`chat_rooms`.`id`, 1, 5) = 'room:'
            AND instr(substr(`chat_rooms`.`id`, 6), ':') > 1
            AND substr(`chat_rooms`.`id`, 6, instr(substr(`chat_rooms`.`id`, 6), ':') - 1)
                = `chat_rooms`.`platform`
       THEN `chat_rooms`.`id`
       ELSE 'room:' || `chat_rooms`.`platform` || ':' || `chat_rooms`.`id`
  END,
  `chat_rooms`.`platform`,
  CASE WHEN substr(`chat_rooms`.`id`, 1, 5) = 'room:'
            AND instr(substr(`chat_rooms`.`id`, 6), ':') > 1
            AND substr(`chat_rooms`.`id`, 6, instr(substr(`chat_rooms`.`id`, 6), ':') - 1)
                = `chat_rooms`.`platform`
       THEN substr(`chat_rooms`.`id`, 6 + instr(substr(`chat_rooms`.`id`, 6), ':'))
       ELSE `chat_rooms`.`id`
  END,
  CASE WHEN substr(`chat_rooms`.`id`, 1, 5) = 'room:'
            AND instr(substr(`chat_rooms`.`id`, 6), ':') > 1
            AND substr(`chat_rooms`.`id`, 6, instr(substr(`chat_rooms`.`id`, 6), ':') - 1)
                = `chat_rooms`.`platform`
       THEN NULL
       ELSE `chat_rooms`.`id`
  END,
  MIN(COALESCE(`chat_rooms`.`created_at`, 0) * 1000, CAST(unixepoch() AS INTEGER) * 1000)
FROM `chat_rooms`
WHERE `chat_rooms`.`platform` IS NOT NULL
  AND `chat_rooms`.`platform` <> ''
  AND `chat_rooms`.`id` IS NOT NULL
  AND `chat_rooms`.`id` <> ''
ORDER BY `chat_rooms`.`platform`, `chat_rooms`.`id`;

-- ---------------------------------------------------------------------------
-- Backfill 2/3: room_key copies. The room row wins, then an exact registry row,
-- then a legacy-alias registry row, and finally the derived key so that a queue
-- row for a room that was never registered still gets a stable, parseable key.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
UPDATE `chat_rooms`
SET `room_key` = COALESCE(
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `chat_rooms`.`platform` AND k.`remote_room_id` = `chat_rooms`.`id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `chat_rooms`.`platform` AND k.`legacy_room_id` = `chat_rooms`.`id`),
  CASE WHEN substr(`chat_rooms`.`id`, 1, 5) = 'room:'
            AND instr(substr(`chat_rooms`.`id`, 6), ':') > 1
            AND substr(`chat_rooms`.`id`, 6, instr(substr(`chat_rooms`.`id`, 6), ':') - 1)
                = `chat_rooms`.`platform`
       THEN `chat_rooms`.`id` END,
  'room:' || `chat_rooms`.`platform` || ':' || `chat_rooms`.`id`
)
WHERE `room_key` IS NULL OR `room_key` = '';
--> statement-breakpoint
UPDATE `messages`
SET `room_key` = COALESCE(
  (SELECT r.`room_key` FROM `chat_rooms` r WHERE r.`id` = `messages`.`chat_room_id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `messages`.`platform` AND k.`remote_room_id` = `messages`.`chat_room_id`),
  CASE WHEN substr(`messages`.`chat_room_id`, 1, 5) = 'room:'
            AND instr(substr(`messages`.`chat_room_id`, 6), ':') > 1
            AND substr(`messages`.`chat_room_id`, 6, instr(substr(`messages`.`chat_room_id`, 6), ':') - 1)
                = COALESCE(
                    `messages`.`platform`,
                    (SELECT r.`platform` FROM `chat_rooms` r WHERE r.`id` = `messages`.`chat_room_id`),
                    'whatsapp'
                  )
       THEN `messages`.`chat_room_id` END,
  'room:' || COALESCE(
    `messages`.`platform`,
    (SELECT r.`platform` FROM `chat_rooms` r WHERE r.`id` = `messages`.`chat_room_id`),
    'whatsapp'
  ) || ':' || `messages`.`chat_room_id`
)
WHERE `room_key` IS NULL OR `room_key` = '';
--> statement-breakpoint
UPDATE `reminders`
SET `room_key` = COALESCE(
  (SELECT r.`room_key` FROM `chat_rooms` r WHERE r.`id` = `reminders`.`chat_room_id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `reminders`.`platform` AND k.`remote_room_id` = `reminders`.`chat_room_id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `reminders`.`platform` AND k.`legacy_room_id` = `reminders`.`chat_room_id`),
  CASE WHEN substr(`reminders`.`chat_room_id`, 1, 5) = 'room:'
            AND instr(substr(`reminders`.`chat_room_id`, 6), ':') > 1
            AND substr(`reminders`.`chat_room_id`, 6, instr(substr(`reminders`.`chat_room_id`, 6), ':') - 1)
                = `reminders`.`platform`
       THEN `reminders`.`chat_room_id` END,
  'room:' || `reminders`.`platform` || ':' || `reminders`.`chat_room_id`
)
WHERE `room_key` IS NULL OR `room_key` = '';
--> statement-breakpoint
UPDATE `notification_subscriptions`
SET `room_key` = COALESCE(
  (SELECT r.`room_key` FROM `chat_rooms` r WHERE r.`id` = `notification_subscriptions`.`chat_room_id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `notification_subscriptions`.`platform`
      AND k.`remote_room_id` = `notification_subscriptions`.`chat_room_id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `notification_subscriptions`.`platform`
      AND k.`legacy_room_id` = `notification_subscriptions`.`chat_room_id`),
  CASE WHEN substr(`notification_subscriptions`.`chat_room_id`, 1, 5) = 'room:'
            AND instr(substr(`notification_subscriptions`.`chat_room_id`, 6), ':') > 1
            AND substr(`notification_subscriptions`.`chat_room_id`, 6, instr(substr(`notification_subscriptions`.`chat_room_id`, 6), ':') - 1)
                = `notification_subscriptions`.`platform`
       THEN `notification_subscriptions`.`chat_room_id` END,
  'room:' || `notification_subscriptions`.`platform` || ':' || `notification_subscriptions`.`chat_room_id`
)
WHERE `room_key` IS NULL OR `room_key` = '';
--> statement-breakpoint
UPDATE `message_inbox`
SET `room_key` = COALESCE(
  (SELECT r.`room_key` FROM `chat_rooms` r
    WHERE r.`id` = `message_inbox`.`chat_room_id` AND r.`platform` = `message_inbox`.`platform`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `message_inbox`.`platform` AND k.`remote_room_id` = `message_inbox`.`chat_room_id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `message_inbox`.`platform` AND k.`legacy_room_id` = `message_inbox`.`chat_room_id`),
  CASE WHEN substr(`message_inbox`.`chat_room_id`, 1, 5) = 'room:'
            AND instr(substr(`message_inbox`.`chat_room_id`, 6), ':') > 1
            AND substr(`message_inbox`.`chat_room_id`, 6, instr(substr(`message_inbox`.`chat_room_id`, 6), ':') - 1)
                = `message_inbox`.`platform`
       THEN `message_inbox`.`chat_room_id` END,
  'room:' || `message_inbox`.`platform` || ':' || `message_inbox`.`chat_room_id`
)
WHERE `room_key` IS NULL OR `room_key` = '';
--> statement-breakpoint
UPDATE `message_outbox`
SET `room_key` = COALESCE(
  (SELECT r.`room_key` FROM `chat_rooms` r
    WHERE r.`id` = `message_outbox`.`chat_room_id` AND r.`platform` = `message_outbox`.`platform`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `message_outbox`.`platform` AND k.`remote_room_id` = `message_outbox`.`chat_room_id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `message_outbox`.`platform` AND k.`legacy_room_id` = `message_outbox`.`chat_room_id`),
  CASE WHEN substr(`message_outbox`.`chat_room_id`, 1, 5) = 'room:'
            AND instr(substr(`message_outbox`.`chat_room_id`, 6), ':') > 1
            AND substr(`message_outbox`.`chat_room_id`, 6, instr(substr(`message_outbox`.`chat_room_id`, 6), ':') - 1)
                = `message_outbox`.`platform`
       THEN `message_outbox`.`chat_room_id` END,
  'room:' || `message_outbox`.`platform` || ':' || `message_outbox`.`chat_room_id`
)
WHERE `room_key` IS NULL OR `room_key` = '';
--> statement-breakpoint
UPDATE `scheduled_deliveries`
SET `room_key` = COALESCE(
  (SELECT r.`room_key` FROM `chat_rooms` r
    WHERE r.`id` = `scheduled_deliveries`.`chat_room_id` AND r.`platform` = `scheduled_deliveries`.`platform`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `scheduled_deliveries`.`platform`
      AND k.`remote_room_id` = `scheduled_deliveries`.`chat_room_id`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `scheduled_deliveries`.`platform`
      AND k.`legacy_room_id` = `scheduled_deliveries`.`chat_room_id`),
  CASE WHEN substr(`scheduled_deliveries`.`chat_room_id`, 1, 5) = 'room:'
            AND instr(substr(`scheduled_deliveries`.`chat_room_id`, 6), ':') > 1
            AND substr(`scheduled_deliveries`.`chat_room_id`, 6, instr(substr(`scheduled_deliveries`.`chat_room_id`, 6), ':') - 1)
                = `scheduled_deliveries`.`platform`
       THEN `scheduled_deliveries`.`chat_room_id` END,
  'room:' || `scheduled_deliveries`.`platform` || ':' || `scheduled_deliveries`.`chat_room_id`
)
WHERE `room_key` IS NULL OR `room_key` = '';
-- `user_roles.scope` is 'global' or a room id; only room scopes get a key.
--> statement-breakpoint
UPDATE `user_roles`
SET `scope_room_key` = COALESCE(
  (SELECT r.`room_key` FROM `chat_rooms` r
    WHERE r.`id` = `user_roles`.`scope` AND r.`platform` = `user_roles`.`platform`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `user_roles`.`platform` AND k.`remote_room_id` = `user_roles`.`scope`),
  (SELECT k.`room_key` FROM `room_keys` k
    WHERE k.`platform` = `user_roles`.`platform` AND k.`legacy_room_id` = `user_roles`.`scope`)
)
WHERE (`scope_room_key` IS NULL OR `scope_room_key` = '')
  AND `scope` IS NOT NULL
  AND `scope` <> ''
  AND lower(trim(`scope`)) <> 'global';
-- `flow_sessions` rows are user scoped ("platform:userId"); their room_key stays
-- NULL until a flow is explicitly bound to a room.

-- ---------------------------------------------------------------------------
-- Backfill 3/3: migration audit. Every finding is keyed by a deterministic
-- fingerprint and inserted with OR IGNORE, so re-running the audit is a no-op.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'legacy_room_claimed|' || r.`platform` || '|' || r.`id`,
  'legacy_room_claimed',
  r.`platform`,
  CASE WHEN substr(r.`id`, 1, 5) = 'room:'
            AND instr(substr(r.`id`, 6), ':') > 1
            AND substr(r.`id`, 6, instr(substr(r.`id`, 6), ':') - 1) = r.`platform`
       THEN r.`id`
       ELSE 'room:' || r.`platform` || ':' || r.`id`
  END,
  r.`id`,
  r.`id`,
  'chat_rooms row could not claim its room key because another room_keys row holds it',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `chat_rooms` r
WHERE r.`id` IS NOT NULL AND r.`id` <> '' AND r.`platform` IS NOT NULL AND r.`platform` <> ''
  AND NOT EXISTS (
    SELECT 1 FROM `room_keys` k
    WHERE k.`room_key` = CASE WHEN substr(r.`id`, 1, 5) = 'room:'
              AND instr(substr(r.`id`, 6), ':') > 1
              AND substr(r.`id`, 6, instr(substr(r.`id`, 6), ':') - 1) = r.`platform`
         THEN r.`id`
         ELSE 'room:' || r.`platform` || ':' || r.`id`
    END
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'room_key_not_transparent|' || k.`room_key`,
  'room_key_not_transparent',
  k.`platform`,
  k.`room_key`,
  k.`remote_room_id`,
  k.`legacy_room_id`,
  'stored room key does not encode its own platform/remote pair',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `room_keys` k
WHERE k.`room_key` <> 'room:' || k.`platform` || ':' || k.`remote_room_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'room_key_taken|' || k.`platform` || '|' || k.`remote_room_id`,
  'room_key_taken',
  k.`platform`,
  k.`room_key`,
  k.`remote_room_id`,
  k.`legacy_room_id`,
  'the derived room key for this platform/remote pair is stored under a different key',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `room_keys` k
WHERE EXISTS (
  SELECT 1 FROM `room_keys` o
  WHERE o.`room_key` = 'room:' || k.`platform` || ':' || k.`remote_room_id`
    AND o.`room_key` <> k.`room_key`
);
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'chat_room_key_not_transparent|' || r.`id`,
  'chat_room_key_not_transparent',
  r.`platform`,
  r.`room_key`,
  r.`id`,
  r.`id`,
  'chat_rooms.room_key is neither the canonical derived key nor the room id',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `chat_rooms` r
WHERE r.`room_key` IS NOT NULL AND r.`room_key` <> ''
  AND r.`id` <> r.`room_key`
  AND r.`room_key` <> 'room:' || COALESCE(r.`platform`, '') || ':' || r.`id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'room_key_mismatch|messages|' || m.`id`,
  'room_key_mismatch',
  COALESCE(m.`platform`, ''),
  m.`room_key`,
  m.`chat_room_id`,
  m.`chat_room_id`,
  'messages.room_key differs from the room key of the referenced chat_rooms row',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `messages` m
WHERE m.`room_key` IS NOT NULL AND m.`room_key` <> ''
  AND EXISTS (
    SELECT 1 FROM `chat_rooms` r
    WHERE r.`id` = m.`chat_room_id` AND r.`room_key` IS NOT NULL AND r.`room_key` <> ''
      AND r.`room_key` <> m.`room_key`
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'room_key_mismatch|reminders|' || r.`id`,
  'room_key_mismatch',
  r.`platform`,
  r.`room_key`,
  r.`chat_room_id`,
  r.`chat_room_id`,
  'reminders.room_key differs from the room key of the referenced chat_rooms row',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `reminders` r
WHERE r.`room_key` IS NOT NULL AND r.`room_key` <> ''
  AND EXISTS (
    SELECT 1 FROM `chat_rooms` cr
    WHERE cr.`id` = r.`chat_room_id` AND cr.`room_key` IS NOT NULL AND cr.`room_key` <> ''
      AND cr.`room_key` <> r.`room_key`
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'room_key_mismatch|notification_subscriptions|' || s.`id`,
  'room_key_mismatch',
  s.`platform`,
  s.`room_key`,
  s.`chat_room_id`,
  s.`chat_room_id`,
  'notification_subscriptions.room_key differs from the room key of the referenced chat_rooms row',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `notification_subscriptions` s
WHERE s.`room_key` IS NOT NULL AND s.`room_key` <> ''
  AND EXISTS (
    SELECT 1 FROM `chat_rooms` cr
    WHERE cr.`id` = s.`chat_room_id` AND cr.`room_key` IS NOT NULL AND cr.`room_key` <> ''
      AND cr.`room_key` <> s.`room_key`
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'unresolved_scope|' || u.`platform` || '|' || u.`scope`,
  'unresolved_scope',
  u.`platform`,
  NULL,
  u.`scope`,
  u.`scope`,
  'user_roles scope is room scoped but does not resolve to a known room',
  'migration:0022_room_keys',
  MIN(u.`created_at`)
FROM `user_roles` u
WHERE u.`scope` IS NOT NULL AND u.`scope` <> '' AND lower(trim(u.`scope`)) <> 'global'
  AND NOT EXISTS (
    SELECT 1 FROM `chat_rooms` r WHERE r.`id` = u.`scope` AND r.`platform` = u.`platform`
  )
  AND NOT EXISTS (
    SELECT 1 FROM `room_keys` k
    WHERE k.`platform` = u.`platform` AND (k.`remote_room_id` = u.`scope` OR k.`legacy_room_id` = u.`scope`)
  )
GROUP BY u.`platform`, u.`scope`;

-- ---------------------------------------------------------------------------
-- Backfill 4/4: collapse duplicated room keys before the unique indexes land.
--
-- The pre-0022 tables had no room identity, so an alias pair (a raw id and the
-- canonical key of the same room) can backfill to the same key. The lowest rowid
-- of a duplicate group keeps the key, later rows fall back to their derived key,
-- and only when that is also taken is the nullable column cleared. Every affected
-- row is recorded first, so nothing is silently dropped.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'duplicate_chat_room_key|' || r.`platform` || '|' || r.`id`,
  'duplicate_chat_room_key',
  r.`platform`,
  r.`room_key`,
  r.`id`,
  r.`id`,
  'another chat_rooms row already owns this room key',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `chat_rooms` r
WHERE r.`room_key` IS NOT NULL AND r.`room_key` <> ''
  AND EXISTS (
    SELECT 1 FROM `chat_rooms` o
    WHERE o.`rowid` < r.`rowid`
      AND o.`room_key` IS NOT NULL AND o.`room_key` <> ''
      AND o.`room_key` = r.`room_key`
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'chat_room_key_unresolved|' || r.`platform` || '|' || r.`id`,
  'chat_room_key_unresolved',
  r.`platform`,
  r.`room_key`,
  r.`id`,
  r.`id`,
  'duplicate room key and derived key are both taken; chat_rooms.room_key left NULL',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `chat_rooms` r
WHERE r.`room_key` IS NOT NULL AND r.`room_key` <> ''
  AND EXISTS (
    SELECT 1 FROM `chat_rooms` o
    WHERE o.`rowid` < r.`rowid`
      AND o.`room_key` IS NOT NULL AND o.`room_key` <> ''
      AND o.`room_key` = r.`room_key`
  )
  AND EXISTS (
    SELECT 1 FROM `chat_rooms` o
    WHERE o.`rowid` <> r.`rowid`
      AND o.`room_key` IS NOT NULL AND o.`room_key` <> ''
      AND o.`room_key` = 'room:' || COALESCE(r.`platform`, '') || ':' || r.`id`
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `room_key_conflicts`
  (`fingerprint`, `conflict_type`, `platform`, `room_key`, `remote_room_id`, `legacy_room_id`,
   `details`, `detected_by`, `detected_at`)
SELECT
  'duplicate_subscription_room_key|' || s.`platform` || '|' || s.`user_id` || '|' || s.`service_type` || '|' || s.`id`,
  'duplicate_subscription_room_key',
  s.`platform`,
  s.`room_key`,
  s.`chat_room_id`,
  s.`chat_room_id`,
  'another notification subscription for this user and service already owns this room key',
  'migration:0022_room_keys',
  CAST(unixepoch() AS INTEGER) * 1000
FROM `notification_subscriptions` s
WHERE s.`room_key` IS NOT NULL AND s.`room_key` <> ''
  AND EXISTS (
    SELECT 1 FROM `notification_subscriptions` o
    WHERE o.`rowid` < s.`rowid`
      AND o.`user_id` = s.`user_id`
      AND o.`platform` = s.`platform`
      AND o.`service_type` = s.`service_type`
      AND o.`room_key` IS NOT NULL AND o.`room_key` <> ''
      AND o.`room_key` = s.`room_key`
  );
--> statement-breakpoint
UPDATE `chat_rooms`
SET `room_key` = CASE
  WHEN EXISTS (
    SELECT 1 FROM `chat_rooms` o
    WHERE o.`rowid` < `chat_rooms`.`rowid`
      AND o.`room_key` IS NOT NULL AND o.`room_key` <> ''
      AND o.`room_key` = `chat_rooms`.`room_key`
  ) THEN CASE WHEN EXISTS (
      SELECT 1 FROM `chat_rooms` o
      WHERE o.`rowid` <> `chat_rooms`.`rowid`
        AND o.`room_key` IS NOT NULL AND o.`room_key` <> ''
        AND o.`room_key` = 'room:' || COALESCE(`chat_rooms`.`platform`, '') || ':' || `chat_rooms`.`id`
    ) THEN NULL
    ELSE 'room:' || COALESCE(`chat_rooms`.`platform`, '') || ':' || `chat_rooms`.`id`
  END
  ELSE `chat_rooms`.`room_key`
END
WHERE `chat_rooms`.`room_key` IS NOT NULL AND `chat_rooms`.`room_key` <> '';
--> statement-breakpoint
UPDATE `notification_subscriptions`
SET `room_key` = NULL
WHERE `room_key` IS NOT NULL AND `room_key` <> ''
  AND EXISTS (
    SELECT 1 FROM `notification_subscriptions` o
    WHERE o.`rowid` < `notification_subscriptions`.`rowid`
      AND o.`user_id` = `notification_subscriptions`.`user_id`
      AND o.`platform` = `notification_subscriptions`.`platform`
      AND o.`service_type` = `notification_subscriptions`.`service_type`
      AND o.`room_key` IS NOT NULL AND o.`room_key` <> ''
      AND o.`room_key` = `notification_subscriptions`.`room_key`
  );
-- Uniqueness of the canonical room identity. Both indexes skip NULL/empty keys, so
-- an unresolved row stays allowed while a real identity can only exist once.
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_rooms_room_key_unique_idx` ON `chat_rooms` (`room_key`) WHERE `room_key` IS NOT NULL AND `room_key` <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_subs_room_key_unique_idx` ON `notification_subscriptions` (`user_id`,`platform`,`service_type`,`room_key`) WHERE `room_key` IS NOT NULL AND `room_key` <> '';

-- ---------------------------------------------------------------------------
-- Forward coverage: new rows keep a room key even when the writing lane has not
-- migrated yet. The triggers only fill a NULL/empty key, so an explicitly
-- supplied canonical key is always preserved.
--
-- The chat_rooms trigger registers the room under the key the room already claims:
-- an explicit canonical `room_key` wins, then a canonical `id` (V8.1 rows are born
-- keyed), and only a legacy id produces the derived `room:<platform>:<id>` form. A
-- non-canonical supplied value never becomes a registry row, so a legacy id plus an
-- explicit key can no longer produce a double-prefixed `room:<platform>:room:...`.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE TRIGGER `chat_rooms_room_key_after_insert` AFTER INSERT ON `chat_rooms`
BEGIN
  INSERT OR IGNORE INTO `room_keys` (`room_key`, `platform`, `remote_room_id`, `legacy_room_id`, `created_at`)
  SELECT
    COALESCE(
      src.`supplied_key`,
      src.`id_key`,
      'room:' || src.`raw_platform` || ':' || src.`raw_id`
    ),
    COALESCE(
      CASE WHEN src.`supplied_key` IS NOT NULL
        THEN substr(src.`supplied_key`, 6, instr(substr(src.`supplied_key`, 6), ':') - 1) END,
      CASE WHEN src.`id_key` IS NOT NULL
        THEN substr(src.`id_key`, 6, instr(substr(src.`id_key`, 6), ':') - 1) END,
      src.`raw_platform`
    ),
    COALESCE(
      CASE WHEN src.`supplied_key` IS NOT NULL
        THEN substr(src.`supplied_key`, 6 + instr(substr(src.`supplied_key`, 6), ':')) END,
      CASE WHEN src.`id_key` IS NOT NULL
        THEN substr(src.`id_key`, 6 + instr(substr(src.`id_key`, 6), ':')) END,
      src.`raw_id`
    ),
    CASE WHEN src.`supplied_key` IS NULL AND src.`id_key` IS NULL THEN src.`raw_id` ELSE NULL END,
    MIN(COALESCE(src.`created_at`, 0) * 1000, CAST(unixepoch() AS INTEGER) * 1000)
  FROM (
    SELECT
      NEW.`platform` AS `raw_platform`,
      NEW.`id` AS `raw_id`,
      NEW.`created_at` AS `created_at`,
      CASE WHEN substr(NEW.`room_key`, 1, 5) = 'room:'
            AND instr(substr(NEW.`room_key`, 6), ':') > 1
        THEN NEW.`room_key` END AS `supplied_key`,
      CASE WHEN substr(NEW.`id`, 1, 5) = 'room:'
            AND instr(substr(NEW.`id`, 6), ':') > 1
        THEN NEW.`id` END AS `id_key`
  ) AS src;
  UPDATE `chat_rooms`
  SET `room_key` = (
    SELECT COALESCE(
       s.`supplied_key`,
       s.`id_key`,
       'room:' || s.`raw_platform` || ':' || s.`raw_id`
     ) FROM (
       SELECT
         NEW.`platform` AS `raw_platform`,
         NEW.`id` AS `raw_id`,
         CASE WHEN substr(NEW.`room_key`, 1, 5) = 'room:'
                   AND instr(substr(NEW.`room_key`, 6), ':') > 1
           THEN NEW.`room_key` END AS `supplied_key`,
         CASE WHEN substr(NEW.`id`, 1, 5) = 'room:'
                   AND instr(substr(NEW.`id`, 6), ':') > 1
           THEN NEW.`id` END AS `id_key`
     ) AS s)
  WHERE `rowid` = NEW.`rowid` AND (`room_key` IS NULL OR `room_key` = '');
END;
--> statement-breakpoint
CREATE TRIGGER `messages_room_key_after_insert` AFTER INSERT ON `messages`
BEGIN
  UPDATE `messages`
  SET `room_key` = COALESCE(
    (SELECT r.`room_key` FROM `chat_rooms` r WHERE r.`id` = NEW.`chat_room_id`),
    (SELECT k.`room_key` FROM `room_keys` k
      WHERE k.`platform` = NEW.`platform` AND k.`remote_room_id` = NEW.`chat_room_id`),
    CASE WHEN substr(NEW.`chat_room_id`, 1, 5) = 'room:'
              AND instr(substr(NEW.`chat_room_id`, 6), ':') > 1
              AND substr(NEW.`chat_room_id`, 6, instr(substr(NEW.`chat_room_id`, 6), ':') - 1)
                  = COALESCE(
                      NEW.`platform`,
                      (SELECT r.`platform` FROM `chat_rooms` r WHERE r.`id` = NEW.`chat_room_id`),
                      'whatsapp'
                    )
         THEN NEW.`chat_room_id` END,
    'room:' || COALESCE(
      NEW.`platform`,
      (SELECT r.`platform` FROM `chat_rooms` r WHERE r.`id` = NEW.`chat_room_id`),
      'whatsapp'
    ) || ':' || NEW.`chat_room_id`
  )
  WHERE `rowid` = NEW.`rowid` AND (`room_key` IS NULL OR `room_key` = '');
END;
--> statement-breakpoint
CREATE TRIGGER `reminders_room_key_after_insert` AFTER INSERT ON `reminders`
BEGIN
  UPDATE `reminders`
  SET `room_key` = COALESCE(
    (SELECT r.`room_key` FROM `chat_rooms` r WHERE r.`id` = NEW.`chat_room_id`),
    (SELECT k.`room_key` FROM `room_keys` k
      WHERE k.`platform` = NEW.`platform` AND k.`remote_room_id` = NEW.`chat_room_id`),
    CASE WHEN substr(NEW.`chat_room_id`, 1, 5) = 'room:'
              AND instr(substr(NEW.`chat_room_id`, 6), ':') > 1
              AND substr(NEW.`chat_room_id`, 6, instr(substr(NEW.`chat_room_id`, 6), ':') - 1) = NEW.`platform`
         THEN NEW.`chat_room_id` END,
    'room:' || NEW.`platform` || ':' || NEW.`chat_room_id`
  )
  WHERE `rowid` = NEW.`rowid` AND (`room_key` IS NULL OR `room_key` = '');
END;
--> statement-breakpoint
CREATE TRIGGER `notification_subscriptions_room_key_after_insert` AFTER INSERT ON `notification_subscriptions`
BEGIN
  UPDATE `notification_subscriptions`
  SET `room_key` = COALESCE(
    (SELECT r.`room_key` FROM `chat_rooms` r WHERE r.`id` = NEW.`chat_room_id`),
    (SELECT k.`room_key` FROM `room_keys` k
      WHERE k.`platform` = NEW.`platform` AND k.`remote_room_id` = NEW.`chat_room_id`),
    CASE WHEN substr(NEW.`chat_room_id`, 1, 5) = 'room:'
              AND instr(substr(NEW.`chat_room_id`, 6), ':') > 1
              AND substr(NEW.`chat_room_id`, 6, instr(substr(NEW.`chat_room_id`, 6), ':') - 1) = NEW.`platform`
         THEN NEW.`chat_room_id` END,
    'room:' || NEW.`platform` || ':' || NEW.`chat_room_id`
  )
  WHERE `rowid` = NEW.`rowid` AND (`room_key` IS NULL OR `room_key` = '');
END;
--> statement-breakpoint
CREATE TRIGGER `message_inbox_room_key_after_insert` AFTER INSERT ON `message_inbox`
BEGIN
  UPDATE `message_inbox`
  SET `room_key` = COALESCE(
    (SELECT r.`room_key` FROM `chat_rooms` r
      WHERE r.`id` = NEW.`chat_room_id` AND r.`platform` = NEW.`platform`),
    (SELECT k.`room_key` FROM `room_keys` k
      WHERE k.`platform` = NEW.`platform` AND k.`remote_room_id` = NEW.`chat_room_id`),
    CASE WHEN substr(NEW.`chat_room_id`, 1, 5) = 'room:'
              AND instr(substr(NEW.`chat_room_id`, 6), ':') > 1
              AND substr(NEW.`chat_room_id`, 6, instr(substr(NEW.`chat_room_id`, 6), ':') - 1) = NEW.`platform`
         THEN NEW.`chat_room_id` END,
    'room:' || NEW.`platform` || ':' || NEW.`chat_room_id`
  )
  WHERE `rowid` = NEW.`rowid` AND (`room_key` IS NULL OR `room_key` = '');
END;
--> statement-breakpoint
CREATE TRIGGER `message_outbox_room_key_after_insert` AFTER INSERT ON `message_outbox`
BEGIN
  UPDATE `message_outbox`
  SET `room_key` = COALESCE(
    (SELECT r.`room_key` FROM `chat_rooms` r
      WHERE r.`id` = NEW.`chat_room_id` AND r.`platform` = NEW.`platform`),
    (SELECT k.`room_key` FROM `room_keys` k
      WHERE k.`platform` = NEW.`platform` AND k.`remote_room_id` = NEW.`chat_room_id`),
    CASE WHEN substr(NEW.`chat_room_id`, 1, 5) = 'room:'
              AND instr(substr(NEW.`chat_room_id`, 6), ':') > 1
              AND substr(NEW.`chat_room_id`, 6, instr(substr(NEW.`chat_room_id`, 6), ':') - 1) = NEW.`platform`
         THEN NEW.`chat_room_id` END,
    'room:' || NEW.`platform` || ':' || NEW.`chat_room_id`
  )
  WHERE `rowid` = NEW.`rowid` AND (`room_key` IS NULL OR `room_key` = '');
END;
--> statement-breakpoint
CREATE TRIGGER `scheduled_deliveries_room_key_after_insert` AFTER INSERT ON `scheduled_deliveries`
BEGIN
  UPDATE `scheduled_deliveries`
  SET `room_key` = COALESCE(
    (SELECT r.`room_key` FROM `chat_rooms` r
      WHERE r.`id` = NEW.`chat_room_id` AND r.`platform` = NEW.`platform`),
    (SELECT k.`room_key` FROM `room_keys` k
      WHERE k.`platform` = NEW.`platform` AND k.`remote_room_id` = NEW.`chat_room_id`),
    CASE WHEN substr(NEW.`chat_room_id`, 1, 5) = 'room:'
              AND instr(substr(NEW.`chat_room_id`, 6), ':') > 1
              AND substr(NEW.`chat_room_id`, 6, instr(substr(NEW.`chat_room_id`, 6), ':') - 1) = NEW.`platform`
         THEN NEW.`chat_room_id` END,
    'room:' || NEW.`platform` || ':' || NEW.`chat_room_id`
  )
  WHERE `rowid` = NEW.`rowid` AND (`room_key` IS NULL OR `room_key` = '');
END;
