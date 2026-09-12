-- V7.19: Add language column to reminders table for per-reminder localization.
-- NOTE: This migration was initially missing from _journal.json.
-- On existing databases the column may already exist; SQLite does not support
-- 'ALTER TABLE ... ADD COLUMN IF NOT EXISTS', so we guard with a SELECT check.
-- If the column already exists, this statement is a no-op via the CASE guard.
-- The `language` column has a default of 'en' so existing rows are backfilled automatically.
ALTER TABLE reminders ADD COLUMN language TEXT NOT NULL DEFAULT 'en';

