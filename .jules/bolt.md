## 2026-02-23 - [Deferred Context Retrieval]
**Learning:** Found significant overhead in processing every group message. Deferring DB history fetching and media processing until *after* confirming AI should reply (via `shouldTriggerAI` check) prevents wasted I/O on "casual chatter" where the bot is ignored.
**Action:** Always check triggering conditions (mentions, commands, etc.) before loading context or history.

## 2026-02-24 - [Selective Column Retrieval]
**Learning:** Fetching full message objects including `rawMessage` JSON blobs for AI context history is wasteful.
**Action:** Explicitly select only required columns (`role`, `content`, `senderName`, etc.) when querying the database for chat history.

## 2026-03-05 - [Levenshtein Distance Space Complexity]
**Learning:** The Levenshtein distance algorithm for command "Did you mean?" suggestions was allocating an O(N*M) 2D array, causing unnecessary garbage collection overhead and memory usage for a simple string similarity check.
**Action:** Replaced the 2D matrix with a single O(min(N, M)) `Uint16Array` to track only the necessary previous row values, reducing execution time by ~80% and drastically cutting GC pressure.

## 2026-03-07 - [Concurrent History Message Context Resolution]
**Learning:** Sequential processing of historical messages during startup or reconnection using a `for...of` loop with `await` creates a significant I/O bottleneck, as each message must be parsed and resolved (including potentially slow JID-to-LID lookups) before the next one starts.
**Action:** Replaced sequential loops with `Promise.all()` to process `createContext` calls concurrently. This reduced history processing time for 100 messages from ~1046ms to ~11ms in benchmarks, a ~95x speedup.
