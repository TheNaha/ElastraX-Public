ALTER TABLE `messages` ADD `provider_message_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_provider_message_id_unique` ON `messages` (`provider_message_id`);