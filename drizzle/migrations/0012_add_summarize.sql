-- V7.13: Add summarize column to chat_rooms
-- Enables per-chatroom toggle for LLM-powered conversation history summarization.
-- NULL  = use the global CONTEXT_SUMMARIZE env var (default: true)
-- 1     = force summarization ON for this room
-- 0     = force summarization OFF for this room
ALTER TABLE `chat_rooms` ADD COLUMN `summarize` integer;
