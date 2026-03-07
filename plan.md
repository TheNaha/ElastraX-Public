**Audit**
I went through the repository structure, core runtime files, docs, tests, CI, and diagnostics. This is enough to support a real stabilization and refactor plan for the current app, with legacy folders treated as cleanup concerns rather than active runtime scope.

**Issue Compilation**
- The repository is carrying multiple system eras at once. The current app lives beside an ignored legacy bot in ElastraBOT-v6, and that folder is explicitly excluded in .gitignore and bunfig.toml. That makes onboarding and ownership blurry, especially for multiple contributors or agents.
- CI is too weak for the size of the codebase. ci.yml only runs tests, while package.json already exposes lint and coverage commands that are not enforced. That means type-safety drift, lint regressions, and coverage loss can land unnoticed.
- The current diagnostics snapshot is noisy and unhealthy. There are 264 reported issues; many are markdown lint in legacy/docs, but there are also real type-safety findings in SessionManager.ts.
- Flow state persistence is fragile. SessionManager.ts keeps state in memory and writes through to SQLite asynchronously without ordering or explicit coordination. Under concurrent updates, stale data can win.
- Flow ownership is split across two places. FlowHandler.ts routes stateful flows while SessionManager.ts persists them. That overlap is manageable for one maintainer, but it is a poor shape for parallel work and future refactors.
- Provider failover is availability-oriented but not efficiency-oriented. ModelRouter.ts retries providers sequentially for each request with no health cache or circuit-breaker behavior, so a dead provider adds latency to every request until it recovers.
- The main agent loop has weak failure boundaries. index.ts runs tool calls in parallel and has no per-tool timeout layer, so one hanging tool can stall a room. The same file also swallows some edit failures during streaming, which makes response degradation harder to observe.
- The AI client is better than some of the audit notes suggested, because client.ts already uses request timeouts. The remaining issue there is resilience and observability, not a proven infinite loop.
- Test isolation is weak. setup.ts sets global env and dependency stubs, while index.ts points at a file-backed SQLite database. That is a bad foundation for deterministic concurrency and integration tests.
- The test suite is broad in unit coverage but thin in system coverage. I found no integration, end-to-end, performance, or stress test files under the current test tree.
- Provider complexity is under-verified relative to risk. whatsapp.ts and discord.ts are central runtime adapters, but the current verification story is still much more unit-oriented than lifecycle-oriented.
- Authorization and quota logic are spread across multiple services. RoleService.ts and PrivilegeService.ts both participate in access behavior, and RoleService.ts still carries deprecated compatibility paths. That is a long-term maintainability and auditability problem.
- The repo already contains known small fixes in codebase_audit_tasks.md, but they are not connected to a visible backlog. One item in that document is now stale, because architecture.md already points at the current provider files. That is a sign the audit process itself needs better tracking.

**Plan**
I saved the working plan to session memory. This is the scannable version.

1. Phase 1, establish control. Turn the confirmed findings into a tracked backlog by severity and subsystem, and explicitly mark what is in scope: current app only, stability first, no feature expansion.
2. Phase 1, add safety rails. Update ci.yml to run lint, tests, and coverage, and make local verification match CI. Use package.json as the starting point rather than inventing new commands.
3. Phase 1, make tests deterministic. Isolate database state used by setup.ts and the SQLite layer in index.ts, then identify and fix shared-state assumptions before adding more tests.
4. Phase 2, fix correctness hotspots first. Prioritize SessionManager.ts, FlowHandler.ts, index.ts, and ModelRouter.ts, because they control state integrity, execution flow, and production latency.
5. Phase 2, add targeted missing tests in parallel. Add integration coverage for provider input to agent loop to persisted output, plus focused tests for failover, concurrent flow updates, hanging tools, malformed streaming responses, and provider lifecycle behavior.
6. Phase 3, normalize boundaries. Separate orchestration, provider adapters, AI routing, persistence, authorization, and flow state into clearer module boundaries so contributors are not editing overlapping responsibilities.
7. Phase 3, standardize contracts. Tighten type boundaries and runtime validation for env config, tool arguments, provider capabilities, webhook normalization, and persistence interfaces. The goal is to reduce hidden fallback behavior and broad any usage.
8. Phase 4, make the repo collaboration-safe. Clarify canonical entrypoints, define subsystem ownership, archive or isolate legacy artifacts from the active working path, and document how to add tools, providers, tests, and migrations.
9. Phase 4, improve operability. Standardize logs and health signals around providers, tools, queues, and persistence so outages and degraded modes are visible instead of silent.
10. Phase 5, only after stability proves out, decide whether deeper moves are warranted. That includes whether SQLite remains sufficient, whether provider routing needs circuit-breaker semantics, and whether adjacent systems should live outside this repo.

**Verification**
1. CI should fail on lint errors, failing tests, and coverage regression.
2. The suite should include integration tests for the end-to-end message path.
3. The suite should include concurrency tests for sessions, queueing, and DB writes.
4. The suite should include failure-mode tests for provider outage, timeout, malformed streaming, and migration problems.
5. Manual smoke checks should cover WhatsApp startup, Discord startup, reconnection, reminders, and media handling.

If you want, the next refinement step can be one of these:
1. Turn this into a prioritized issue backlog with severity, owner area, and expected effort.
2. Rewrite the plan into a sprint-by-sprint roadmap.
3. Narrow the first stabilization sprint to the highest-value 5 to 10 fixes.