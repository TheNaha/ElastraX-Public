# Codebase Audit - 2026-03-18

## Scope

This audit focused on the active `v7` application code under `src/`, the test suite, runtime wiring, and deployment-facing integration paths. It did not remove legacy artifacts such as `ElastraBOT-v6/` because that would be a destructive repo cleanup decision.

## Findings

### Fixed in this pass

1. Queue metrics were never registered with the health collector, so `/health` and `/metrics` always reported queue depth as zero even under load.
2. Failed LLM requests were recorded with `0ms` latency, which polluted latency percentiles and made observability misleading during provider outages.
3. Providers returning empty non-tool responses were treated as soft fallbacks without being put into cooldown, so the router could keep retrying unhealthy providers on every request.
4. Streaming failover could mix partial output from one provider with fallback output from another provider if the first stream failed mid-response.
5. Admin media notification routing used the wrong service binding path for Seerr and ignored per-service room filtering for admin broadcasts.
6. The rate limiter still depended on import-time environment snapshots and pruned buckets using a global default window instead of each bucket's real window.
7. Media cleanup parsed `MEDIA_RETENTION_HOURS` ad hoc; invalid values could silently disable file pruning.

### Not auto-fixed

1. The repo still has a large lint-warning backlog (currently 267 warnings, mostly test-only `any` usage and a few unused imports/variables). The code now passes lint because they are warnings, but the debt is still real.
2. `ElastraBOT-v6/` is a detached legacy system living inside the repo. It is excluded from tests and not part of the active runtime, but removing or archiving it should be an explicit product/repo decision.
3. `plan.md` contains stale audit notes that no longer match the current implementation. It should either be refreshed or replaced with a tracked issue/backlog workflow.

## Plan

1. Fix production-path correctness and monitoring first.
2. Add regression tests for each repaired seam.
3. Re-run lint, type-checking, and the test suite.
4. Leave destructive repository cleanup as a separate explicit decision.
