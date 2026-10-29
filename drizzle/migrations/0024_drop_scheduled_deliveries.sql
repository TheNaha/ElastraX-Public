DROP TABLE `scheduled_deliveries`;--> statement-breakpoint
CREATE INDEX `memories_category_idx` ON `memories` (`category`);--> statement-breakpoint
CREATE INDEX `reminders_claimed_at_idx` ON `reminders` (`claimed_at`,`is_sent`);--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role`);