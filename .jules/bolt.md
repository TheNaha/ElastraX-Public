## 2026-02-23 - [Deferred Context Retrieval]
**Learning:** Found significant overhead in processing every group message. Deferring DB history fetching and media processing until *after* confirming AI should reply (via `shouldTriggerAI` check) prevents wasted I/O on "casual chatter" where the bot is ignored.
**Action:** Always check triggering conditions (mentions, commands, etc.) before loading context or history.

## 2026-02-24 - [Selective Column Retrieval]
**Learning:** Fetching full message objects including `rawMessage` JSON blobs for AI context history is wasteful.
**Action:** Explicitly select only required columns (`role`, `content`, `senderName`, etc.) when querying the database for chat history.
