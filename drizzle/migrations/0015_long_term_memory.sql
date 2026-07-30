CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`content` text NOT NULL,
	`category` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_owner_idx` ON `memories` (`owner_id`);
--> statement-breakpoint
ALTER TABLE chat_rooms ADD `long_term_memory` integer;
