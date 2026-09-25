CREATE TABLE `canonical_identities` (
  `id` text PRIMARY KEY NOT NULL,
  `platform` text NOT NULL,
  `primary_alias` text NOT NULL,
  `display_name` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canonical_identities_platform_primary_idx` ON `canonical_identities` (`platform`,`primary_alias`);
--> statement-breakpoint
CREATE INDEX `canonical_identities_platform_updated_idx` ON `canonical_identities` (`platform`,`updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `database_leases` (
  `name` text PRIMARY KEY NOT NULL,
  `owner` text NOT NULL,
  `expires_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `db_schema_meta` (
  `id` integer PRIMARY KEY NOT NULL,
  `schema_version` integer NOT NULL,
  `fingerprint` text NOT NULL,
  `migration_count` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `db_schema_meta_singleton_check` CHECK (`id` = 1)
);
--> statement-breakpoint
CREATE TABLE `identity_aliases` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `canonical_id` text NOT NULL,
  `platform` text NOT NULL,
  `alias` text NOT NULL,
  `alias_kind` text NOT NULL,
  `metadata` text,
  `first_seen_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  FOREIGN KEY (`canonical_id`) REFERENCES `canonical_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_aliases_platform_alias_unique_idx` ON `identity_aliases` (`platform`,`alias`);
--> statement-breakpoint
CREATE INDEX `identity_aliases_canonical_idx` ON `identity_aliases` (`canonical_id`,`last_seen_at`);
--> statement-breakpoint
CREATE TABLE `message_inbox` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `platform` text NOT NULL,
  `chat_room_id` text NOT NULL,
  `provider_message_id` text,
  `event_key` text NOT NULL,
  `state` text DEFAULT 'received' NOT NULL CHECK (`state` IN ('received', 'processing', 'completed', 'failed', 'dead_letter')),
  `payload` text,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `available_at` integer NOT NULL,
  `lease_owner` text,
  `lease_expires_at` integer,
  `last_error` text,
  `received_at` integer NOT NULL,
  `completed_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`attempt_count` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_inbox_platform_event_unique_idx` ON `message_inbox` (`platform`,`event_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_inbox_platform_provider_unique_idx` ON `message_inbox` (`platform`,`chat_room_id`,`provider_message_id`) WHERE `provider_message_id` IS NOT NULL AND lower(trim(`provider_message_id`)) NOT IN ('','unknown','null');
--> statement-breakpoint
CREATE INDEX `message_inbox_work_idx` ON `message_inbox` (`state`,`available_at`,`lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `message_inbox_room_idx` ON `message_inbox` (`platform`,`chat_room_id`,`received_at`);
--> statement-breakpoint
CREATE TABLE `message_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `platform` text NOT NULL,
  `chat_room_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `provider_message_id` text,
  `state` text DEFAULT 'pending' NOT NULL CHECK (`state` IN ('pending', 'leased', 'sent', 'failed', 'dead_letter')),
  `payload` text NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `available_at` integer NOT NULL,
  `lease_owner` text,
  `lease_expires_at` integer,
  `last_error` text,
  `sent_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`attempt_count` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_outbox_platform_idempotency_unique_idx` ON `message_outbox` (`platform`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_outbox_platform_provider_unique_idx` ON `message_outbox` (`platform`,`chat_room_id`,`provider_message_id`) WHERE `provider_message_id` IS NOT NULL AND lower(trim(`provider_message_id`)) NOT IN ('','unknown','null');
--> statement-breakpoint
CREATE INDEX `message_outbox_work_idx` ON `message_outbox` (`state`,`available_at`,`lease_expires_at`);
--> statement-breakpoint
CREATE TABLE `scheduled_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `platform` text NOT NULL,
  `job_key` text NOT NULL,
  `chat_room_id` text NOT NULL,
  `provider_message_id` text,
  `state` text DEFAULT 'pending' NOT NULL CHECK (`state` IN ('pending', 'leased', 'sent', 'failed', 'dead_letter')),
  `payload` text NOT NULL,
  `scheduled_at` integer NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `available_at` integer NOT NULL,
  `lease_owner` text,
  `lease_expires_at` integer,
  `last_error` text,
  `sent_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`attempt_count` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_deliveries_platform_job_unique_idx` ON `scheduled_deliveries` (`platform`,`job_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_deliveries_platform_provider_unique_idx` ON `scheduled_deliveries` (`platform`,`chat_room_id`,`provider_message_id`) WHERE `provider_message_id` IS NOT NULL AND lower(trim(`provider_message_id`)) NOT IN ('','unknown','null');
--> statement-breakpoint
CREATE INDEX `scheduled_deliveries_work_idx` ON `scheduled_deliveries` (`state`,`scheduled_at`,`available_at`,`lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `scheduled_deliveries_room_idx` ON `scheduled_deliveries` (`platform`,`chat_room_id`,`scheduled_at`);
--> statement-breakpoint
DROP INDEX `messages_provider_message_id_unique`;
--> statement-breakpoint
ALTER TABLE `messages` ADD `platform` text;
--> statement-breakpoint
UPDATE `messages`
SET `platform` = COALESCE(
  (SELECT `platform` FROM `chat_rooms` WHERE `chat_rooms`.`id` = `messages`.`chat_room_id`),
  'whatsapp'
);
--> statement-breakpoint
CREATE TRIGGER `messages_set_platform_insert`
AFTER INSERT ON `messages`
BEGIN
  UPDATE `messages`
  SET `platform` = COALESCE(
    (SELECT `platform` FROM `chat_rooms` WHERE `chat_rooms`.`id` = NEW.`chat_room_id`),
    NEW.`platform`,
    'whatsapp'
  )
  WHERE `rowid` = NEW.`rowid`;
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_platform_provider_message_id_unique` ON `messages` (`platform`,`chat_room_id`,`provider_message_id`) WHERE `provider_message_id` IS NOT NULL AND lower(trim(`provider_message_id`)) NOT IN ('','unknown','null');
--> statement-breakpoint
DROP INDEX `user_identities_lid_unique_idx`;
--> statement-breakpoint
DROP INDEX `user_identities_pn_unique_idx`;
--> statement-breakpoint
ALTER TABLE `user_identities` ADD `canonical_id` text;
--> statement-breakpoint
UPDATE `user_identities`
SET `canonical_id` = `platform` || ':' || COALESCE(`pn`, `lid`, 'row:' || `rowid`)
WHERE `canonical_id` IS NULL OR `canonical_id` = '';
--> statement-breakpoint
INSERT OR IGNORE INTO `canonical_identities`
  (`id`, `platform`, `primary_alias`, `display_name`, `created_at`, `updated_at`)
SELECT `canonical_id`, `platform`, COALESCE(`pn`, `lid`), `display_name`, `updated_at`, `updated_at`
FROM `user_identities`
WHERE `canonical_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `identity_aliases`
  (`canonical_id`, `platform`, `alias`, `alias_kind`, `first_seen_at`, `last_seen_at`)
SELECT `canonical_id`, `platform`, `lid`, 'lid', `updated_at`, `updated_at`
FROM `user_identities`
WHERE `canonical_id` IS NOT NULL AND `lid` IS NOT NULL AND `lid` <> '';
--> statement-breakpoint
INSERT OR IGNORE INTO `identity_aliases`
  (`canonical_id`, `platform`, `alias`, `alias_kind`, `first_seen_at`, `last_seen_at`)
SELECT `canonical_id`, `platform`, `pn`, 'pn', `updated_at`, `updated_at`
FROM `user_identities`
WHERE `canonical_id` IS NOT NULL AND `pn` IS NOT NULL AND `pn` <> '';
--> statement-breakpoint
CREATE TRIGGER `user_identities_canonical_after_insert`
AFTER INSERT ON `user_identities`
BEGIN
  UPDATE `user_identities`
  SET `canonical_id` = COALESCE(
    (
      SELECT `identity_aliases`.`canonical_id`
      FROM `identity_aliases`
      WHERE `identity_aliases`.`platform` = NEW.`platform`
        AND (`identity_aliases`.`alias` = NEW.`lid` OR `identity_aliases`.`alias` = NEW.`pn`)
      ORDER BY `identity_aliases`.`last_seen_at` DESC
      LIMIT 1
    ),
    NEW.`platform` || ':' || COALESCE(NEW.`pn`, NEW.`lid`, 'row:' || NEW.`rowid`)
  )
  WHERE `rowid` = NEW.`rowid` AND (`canonical_id` IS NULL OR `canonical_id` = '');
  INSERT OR IGNORE INTO `canonical_identities`
    (`id`, `platform`, `primary_alias`, `display_name`, `created_at`, `updated_at`)
  SELECT `canonical_id`, `platform`, COALESCE(`pn`, `lid`, 'row:' || `rowid`),
         `display_name`, `updated_at`, `updated_at`
  FROM `user_identities`
  WHERE `rowid` = NEW.`rowid`;
  INSERT OR IGNORE INTO `identity_aliases`
    (`canonical_id`, `platform`, `alias`, `alias_kind`, `first_seen_at`, `last_seen_at`)
  SELECT `canonical_id`, `platform`, `lid`, 'lid', `updated_at`, `updated_at`
  FROM `user_identities`
  WHERE `rowid` = NEW.`rowid` AND `lid` IS NOT NULL AND `lid` <> '';
  INSERT OR IGNORE INTO `identity_aliases`
    (`canonical_id`, `platform`, `alias`, `alias_kind`, `first_seen_at`, `last_seen_at`)
  SELECT `canonical_id`, `platform`, `pn`, 'pn', `updated_at`, `updated_at`
  FROM `user_identities`
  WHERE `rowid` = NEW.`rowid` AND `pn` IS NOT NULL AND `pn` <> '';
END;
--> statement-breakpoint
CREATE TRIGGER `user_identities_canonical_after_update`
AFTER UPDATE OF `lid`, `pn`, `platform`, `canonical_id` ON `user_identities`
BEGIN
  UPDATE `user_identities`
  SET `canonical_id` = COALESCE(
    `canonical_id`,
    (
      SELECT `identity_aliases`.`canonical_id`
      FROM `identity_aliases`
      WHERE `identity_aliases`.`platform` = NEW.`platform`
        AND (`identity_aliases`.`alias` = NEW.`lid` OR `identity_aliases`.`alias` = NEW.`pn`)
      ORDER BY `identity_aliases`.`last_seen_at` DESC
      LIMIT 1
    ),
    NEW.`platform` || ':' || COALESCE(NEW.`pn`, NEW.`lid`, 'row:' || NEW.`rowid`)
  )
  WHERE `rowid` = NEW.`rowid` AND `canonical_id` IS NOT NEW.`canonical_id`;
  UPDATE `identity_aliases`
  SET `canonical_id` = NEW.`canonical_id`, `last_seen_at` = NEW.`updated_at`
  WHERE (`identity_aliases`.`platform` = NEW.`platform`)
    AND (`identity_aliases`.`alias` = NEW.`lid` OR `identity_aliases`.`alias` = NEW.`pn`)
    AND NOT EXISTS (
      SELECT 1 FROM `user_identities` AS `active_identity`
      WHERE `active_identity`.`canonical_id` = `identity_aliases`.`canonical_id`
        AND `active_identity`.`rowid` <> NEW.`rowid`
    );
  INSERT OR IGNORE INTO `canonical_identities`
    (`id`, `platform`, `primary_alias`, `display_name`, `created_at`, `updated_at`)
  SELECT `canonical_id`, `platform`, COALESCE(`pn`, `lid`), `display_name`, `updated_at`, `updated_at`
  FROM `user_identities`
  WHERE `rowid` = NEW.`rowid`;
  INSERT OR IGNORE INTO `identity_aliases`
    (`canonical_id`, `platform`, `alias`, `alias_kind`, `first_seen_at`, `last_seen_at`)
  SELECT `canonical_id`, `platform`, `lid`, 'lid', `updated_at`, `updated_at`
  FROM `user_identities`
  WHERE `rowid` = NEW.`rowid` AND `lid` IS NOT NULL AND `lid` <> '';
  INSERT OR IGNORE INTO `identity_aliases`
    (`canonical_id`, `platform`, `alias`, `alias_kind`, `first_seen_at`, `last_seen_at`)
  SELECT `canonical_id`, `platform`, `pn`, 'pn', `updated_at`, `updated_at`
  FROM `user_identities`
  WHERE `rowid` = NEW.`rowid` AND `pn` IS NOT NULL AND `pn` <> '';
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_platform_lid_unique_idx` ON `user_identities` (`platform`,`lid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_platform_pn_unique_idx` ON `user_identities` (`platform`,`pn`);
--> statement-breakpoint
CREATE INDEX `user_identities_canonical_idx` ON `user_identities` (`platform`,`canonical_id`);
--> statement-breakpoint
DROP INDEX `user_roles_user_scope_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_platform_user_scope_unique_idx` ON `user_roles` (`platform`,`user_id`,`scope`);
--> statement-breakpoint
DROP INDEX `reminders_sender_id_idx`;
--> statement-breakpoint
CREATE INDEX `reminders_due_idx` ON `reminders` (`is_sent`,`remind_at`,`claimed_at`);
--> statement-breakpoint
CREATE INDEX `reminders_sender_id_idx` ON `reminders` (`sender_id`,`is_sent`,`remind_at`);
