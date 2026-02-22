CREATE TABLE `chat_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`system_prompt` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_room_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`sender_name` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`raw_message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_room_id`) REFERENCES `chat_rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wa_auth_state` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
