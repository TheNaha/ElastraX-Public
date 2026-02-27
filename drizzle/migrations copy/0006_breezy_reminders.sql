CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_room_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`sender_name` text NOT NULL,
	`message` text NOT NULL,
	`remind_at` integer NOT NULL,
	`is_sent` integer DEFAULT false NOT NULL,
	`platform` text DEFAULT 'whatsapp' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_room_id`) REFERENCES `chat_rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reminders_remind_at_idx` ON `reminders` (`remind_at`,`is_sent`);