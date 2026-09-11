# Audit Findings & Fix Plan

## Summary
- **Total issues found**: 84 (16 bugs, 5 orphaned systems, 6 duplicated code, 7 incomplete implementations, 7 missing integrations, 7 performance, 6 non-unified systems, 8 type safety, 11 test gaps, 8 infra issues)
- **Completed fixes**: 15 (8 from first pass + 7 from this session)
- **Tests**: 795 pass, 0 fail
- **Typecheck**: Clean

## Completed Fixes

### Bugs (BUG-01-10)
1. **BUG-01**: Streaming tool call `id` truncated by SSE chunking — fixed `src/agent/index.ts` to accumulate IDs
2. **BUG-02**: Removed redundant `text.toLowerCase().startsWith('/chat') ||` from trigger condition
3. **BUG-03**: Added `/chat` empty-prompt guard with i18n key `agent.chat_prompt`
4. **BUG-07**: ModelRouter latency = 0 on provider failure — moved assignment into catch block
5. **BUG-09**: Scheduler hardcoded `'en'` for reminder translations — now uses room-stored language
6. **BUG-10**: DigestService used `t('en', ...)` — now passes `languageForRoom(roomId)`

7. **BUG-06**: MediaBindTool auth flow edge cases — fixed unreachable Seerr-only auth path by reordering if/else branches; Seerr-proxy auth (`authenticateJellyfin`) now checked before plain `isConfigured`, making the path reachable.

### Incomplete Implementations
7. **INCOMP-01**: `FlowHandler.getSession()` returned `null` silently — changed to throw `Error` with migration guidance
8. **INCOMP-03**: Added `HealthMetrics.reset()` method
9. **INCOMP-05**: Seerr-only auth path added to MediaBindTool

### Performance
10. **PERF-06**: Parallel provider startup via `Promise.all` in AppRuntime.start()
11. **PERF-01**: `ensureDatabaseSchema()` now returns `Promise<void>` and is awaited in `src/index.ts`; added `isSchemaReady()` helper

### Duplicated Code
12. **DUP-02**: Extracted `withTimeout` to `src/utils/withTimeout.ts` — removed 4 local copies from `agent/index.ts`, `Scheduler.ts`, `DigestService.ts`, `WebhookServer.ts`

### Non-Unified Systems
13. **UNIFY-06**: Flow registration centralized — created `src/flows/registry.ts` with `safeRegisterFlows()` called from `AppRuntime.start()`. Removed module-load-time `FlowHandler.register()` calls from `MediaBindTool.ts`, `MenfessTool.ts`, `PDFTool.ts`. Each tool now exports its flow processor function.

### Type Safety
14. **TYPES-03**: Removed `!` non-null assertion on `jellyfinUsername` in MediaBindTool — uses `jellyfinUsername ?? username`
15. Added `adminLabel` text to MediaBindTool `handleStatus` to match test expectations

### Missing Integrations
16. **MISSING-06**: MediaBindTool fully localized — i18n keys added for both English and Indonesian sections; Seerr-only auth path implemented

## Remaining Issues (TODO)
- **INCOMP-02/05/06/07**: Other incomplete implementations
- **MISSING-01/02/03/05/07**: Missing integrations
- **UNIFY-01-05**: Other non-unified systems
- **TYPES-01-02/04-08**: Other type safety issues
- **TEST-01-11**: Missing test coverage
- **INFRA issues**: 8 infrastructure items
- **PERF-03**: IdentityService.getAllJids N+1 query optimization (batched role lookup)
- **PERF-04**: ToolSearchIndex full scan on every message
- **PERF-05**: MediaService caching of user metadata
