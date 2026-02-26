-- V7.9: User permission / role management
CREATE TABLE IF NOT EXISTS `user_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL DEFAULT 'whatsapp',
	`scope` text NOT NULL DEFAULT 'global',
	`role` text NOT NULL DEFAULT 'user',
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_user_scope_idx` ON `user_roles` (`user_id`,`scope`);
--> statement-breakpoint
CREATE INDEX `user_roles_scope_idx` ON `user_roles` (`scope`,`role`);
