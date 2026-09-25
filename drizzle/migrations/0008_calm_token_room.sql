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
CREATE TABLE `__new_messages` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `chat_room_id` text NOT NULL,
  `provider_message_id` text,
  `sender_id` text NOT NULL,
  `sender_name` text NOT NULL,
  `role` text NOT NULL,
  `content` text NOT NULL,
  `raw_message` text,
  `tool_calls` text,
  `tool_call_id` text,
  `media_path` text,
  `mime_type` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`chat_room_id`) REFERENCES `__new_chat_rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `__new_reminders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `chat_room_id` text NOT NULL,
  `sender_id` text NOT NULL,
  `sender_name` text NOT NULL,
  `message` text NOT NULL,
  `remind_at` integer NOT NULL,
  `is_sent` integer DEFAULT false NOT NULL,
  `platform` text DEFAULT 'whatsapp' NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`chat_room_id`) REFERENCES `__new_chat_rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_chat_rooms` (
  `id`, `platform`, `language`, `system_prompt`, `context_limit`, `temperature`,
  `max_tokens`, `allow_tools`, `auto_reply_all`, `created_at`
)
SELECT
  `id`, `platform`, `language`, `system_prompt`, `context_limit`,
  CAST(`temperature` AS real), NULL, `allow_tools`, `auto_reply_all`, `created_at`
FROM `chat_rooms`;
--> statement-breakpoint
INSERT INTO `__new_messages` (
  `id`, `chat_room_id`, `provider_message_id`, `sender_id`, `sender_name`, `role`,
  `content`, `raw_message`, `tool_calls`, `tool_call_id`, `media_path`, `mime_type`, `created_at`
)
SELECT
  `id`, `chat_room_id`, `provider_message_id`, `sender_id`, `sender_name`, `role`,
  `content`, `raw_message`, `tool_calls`, `tool_call_id`, `media_path`, `mime_type`, `created_at`
FROM `messages`;
--> statement-breakpoint
INSERT INTO `__new_reminders` (
  `id`, `chat_room_id`, `sender_id`, `sender_name`, `message`, `remind_at`,
  `is_sent`, `platform`, `created_at`
)
SELECT
  `id`, `chat_room_id`, `sender_id`, `sender_name`, `message`, `remind_at`,
  `is_sent`, `platform`, `created_at`
FROM `reminders`;
--> statement-breakpoint
DROP TABLE `reminders`;
--> statement-breakpoint
DROP TABLE `messages`;
--> statement-breakpoint
DROP TABLE `chat_rooms`;
--> statement-breakpoint
ALTER TABLE `__new_chat_rooms` RENAME TO `chat_rooms`;
--> statement-breakpoint
ALTER TABLE `__new_reminders` RENAME TO `reminders`;
--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_provider_message_id_unique` ON `messages` (`provider_message_id`);
--> statement-breakpoint
CREATE INDEX `messages_chat_room_id_created_at_idx` ON `messages` (`chat_room_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `messages_chat_room_id_idx` ON `messages` (`chat_room_id`);
--> statement-breakpoint
CREATE INDEX `reminders_remind_at_idx` ON `reminders` (`remind_at`,`is_sent`);
