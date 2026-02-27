-- V7.11: Per-role privilege quotas
-- Stores DB overrides for per-role rate limits, context limits, etc.
-- NULL values mean "use default from environment variable".
CREATE TABLE IF NOT EXISTS `role_privileges` (
	`role` text PRIMARY KEY NOT NULL,
	`max_messages_per_window` integer,
	`rate_limit_window_sec` integer,
	`context_limit` integer,
	`max_download_mb` integer
);
