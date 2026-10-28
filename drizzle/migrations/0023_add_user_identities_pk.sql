PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Drop triggers on user_identities (auto-dropped by DROP TABLE, but be explicit)
DROP TRIGGER IF EXISTS `user_identities_canonical_after_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `user_identities_canonical_after_update`;--> statement-breakpoint
CREATE TABLE `__new_user_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_id` text,
	`lid` text,
	`pn` text,
	`platform` text DEFAULT 'whatsapp' NOT NULL,
	`display_name` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user_identities`("canonical_id", "lid", "pn", "platform", "display_name", "updated_at") SELECT "canonical_id", "lid", "pn", "platform", "display_name", "updated_at" FROM `user_identities`;--> statement-breakpoint
DROP TABLE `user_identities`;--> statement-breakpoint
ALTER TABLE `__new_user_identities` RENAME TO `user_identities`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_platform_lid_unique_idx` ON `user_identities` (`platform`,`lid`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_platform_pn_unique_idx` ON `user_identities` (`platform`,`pn`);--> statement-breakpoint
CREATE INDEX `user_identities_canonical_idx` ON `user_identities` (`platform`,`canonical_id`);--> statement-breakpoint
-- Recreate triggers that were auto-dropped by DROP TABLE
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
END;--> statement-breakpoint
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
END;--> statement-breakpoint
PRAGMA foreign_keys=ON;