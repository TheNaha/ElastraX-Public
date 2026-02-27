-- V7.12: User identity mapping (LID ↔ PN ↔ display name)
-- Persists Baileys V7 LID-to-phone-number mappings so that role lookups
-- can find all JIDs for a given user regardless of which JID format was used.
CREATE TABLE IF NOT EXISTS `user_identities` (
	`lid` text,
	`pn` text,
	`platform` text NOT NULL DEFAULT 'whatsapp',
	`display_name` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_identities_lid_idx` ON `user_identities` (`lid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_identities_pn_idx` ON `user_identities` (`pn`);
