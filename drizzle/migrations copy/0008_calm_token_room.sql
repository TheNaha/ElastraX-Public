-- V8.0: chat_rooms temperature as REAL + max_tokens support
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_chat_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`system_prompt` text,
	`context_limit` integer,
	`temperature` real,
	`max_tokens` integer,
	`allow_tools` integer,
	`auto_reply_all` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_chat_rooms` (
	`id`,
	`platform`,
	`language`,
	`system_prompt`,
	`context_limit`,
	`temperature`,
	`max_tokens`,
	`allow_tools`,
	`auto_reply_all`,
	`created_at`
)
SELECT
	`id`,
	`platform`,
	`language`,
	`system_prompt`,
	`context_limit`,
	CAST(`temperature` AS real),
	NULL,
	`allow_tools`,
	`auto_reply_all`,
	`created_at`
FROM `chat_rooms`;
--> statement-breakpoint
DROP TABLE `chat_rooms`;
--> statement-breakpoint
ALTER TABLE `__new_chat_rooms` RENAME TO `chat_rooms`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
