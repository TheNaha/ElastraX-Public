CREATE TABLE `flow_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `flow_sessions_updated_idx` ON `flow_sessions` (`updated_at`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_room_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`sender_name` text NOT NULL,
	`message` text NOT NULL,
	`remind_at` integer NOT NULL,
	`is_sent` integer DEFAULT false NOT NULL,
	`platform` text DEFAULT 'whatsapp' NOT NULL,
	`recurrence` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_room_id`) REFERENCES `chat_rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reminders_remind_at_idx` ON `reminders` (`remind_at`,`is_sent`);--> statement-breakpoint
CREATE TABLE `role_privileges` (
	`role` text PRIMARY KEY NOT NULL,
	`max_messages_per_window` integer,
	`rate_limit_window_sec` integer,
	`context_limit` integer,
	`max_download_mb` integer
);
--> statement-breakpoint
CREATE TABLE `user_identities` (
	`lid` text,
	`pn` text,
	`platform` text DEFAULT 'whatsapp' NOT NULL,
	`display_name` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_identities_lid_idx` ON `user_identities` (`lid`);--> statement-breakpoint
CREATE INDEX `user_identities_pn_idx` ON `user_identities` (`pn`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`platform` text DEFAULT 'whatsapp' NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_roles_user_scope_idx` ON `user_roles` (`user_id`,`scope`);--> statement-breakpoint
CREATE INDEX `user_roles_scope_idx` ON `user_roles` (`scope`,`role`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`summarize` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_chat_rooms`("id", "platform", "language", "system_prompt", "context_limit", "temperature", "max_tokens", "allow_tools", "auto_reply_all", "summarize", "created_at") SELECT "id", "platform", "language", "system_prompt", "context_limit", "temperature", "max_tokens", "allow_tools", "auto_reply_all", "summarize", "created_at" FROM `chat_rooms`;--> statement-breakpoint
DROP TABLE `chat_rooms`;--> statement-breakpoint
ALTER TABLE `__new_chat_rooms` RENAME TO `chat_rooms`;--> statement-breakpoint
PRAGMA foreign_keys=ON;