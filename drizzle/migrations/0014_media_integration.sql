CREATE TABLE `service_bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`service_type` text NOT NULL,
	`external_user_id` text NOT NULL,
	`external_username` text NOT NULL,
	`external_email` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_bindings_user_service_idx` ON `service_bindings` (`user_id`,`platform`,`service_type`);--> statement-breakpoint
CREATE INDEX `service_bindings_external_idx` ON `service_bindings` (`service_type`,`external_user_id`);--> statement-breakpoint
CREATE INDEX `service_bindings_email_idx` ON `service_bindings` (`service_type`,`external_email`);--> statement-breakpoint
CREATE INDEX `service_bindings_username_idx` ON `service_bindings` (`service_type`,`external_username`);--> statement-breakpoint
CREATE TABLE `notification_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`service_type` text NOT NULL,
	`chat_room_id` text NOT NULL,
	`notify_types` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_subs_user_room_idx` ON `notification_subscriptions` (`user_id`,`platform`,`service_type`,`chat_room_id`);--> statement-breakpoint
CREATE INDEX `notification_subs_service_idx` ON `notification_subscriptions` (`service_type`);
