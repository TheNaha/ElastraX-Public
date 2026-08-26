-- Consolidation fixes: reconcile the live schema with src/db/schema.ts.
--
-- (1) user_roles UNIQUE(user_id, scope): already created by 0007; schema.ts
--     previously declared it non-unique (drift only, no action needed here).
--
-- (2) user_identities: migration 0013's unique indexes are missing from some
--     databases and placeholder PNs ("0@s.whatsapp.net" emitted for anonymized
--     group senders) would violate uniqueness. Dedupe, neutralize placeholders,
--     then enforce one row per JID. SQLite UNIQUE permits multiple NULLs, so
--     NULLed placeholders coexist safely.

DELETE FROM user_identities
WHERE lid IS NOT NULL
  AND rowid NOT IN (
    SELECT MAX(rowid)
    FROM user_identities
    WHERE lid IS NOT NULL
    GROUP BY lid
  );
--> statement-breakpoint

DELETE FROM user_identities
WHERE pn IS NOT NULL
  AND rowid NOT IN (
    SELECT MAX(rowid)
    FROM user_identities
    WHERE pn IS NOT NULL
    GROUP BY pn
  );
--> statement-breakpoint

UPDATE user_identities SET pn = NULL WHERE pn IS NOT NULL AND pn LIKE '0@%';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `user_identities_lid_unique_idx` ON `user_identities` (`lid`);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `user_identities_pn_unique_idx` ON `user_identities` (`pn`);
--> statement-breakpoint

-- Redundant: superseded by the unique indexes above (pure write amplification).
DROP INDEX IF EXISTS `user_identities_lid_idx`;
--> statement-breakpoint

DROP INDEX IF EXISTS `user_identities_pn_idx`;
--> statement-breakpoint

-- Declared in schema.ts but never migrated.
CREATE INDEX IF NOT EXISTS `chat_rooms_platform_idx` ON `chat_rooms` (`platform`);
