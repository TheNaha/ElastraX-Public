-- V7.10: Flow sessions persistence + recurring reminders
-- Flow sessions table for persistent interactive session state (survives restarts)
CREATE TABLE IF NOT EXISTS `flow_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_sessions_updated_idx` ON `flow_sessions` (`updated_at`);--> statement-breakpoint
-- Add recurrence column to reminders for cron-style recurring schedules
ALTER TABLE `reminders` ADD COLUMN `recurrence` text;
