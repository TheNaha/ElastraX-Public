# Tasks

This change is documentation-only (spec baseline capture). There is no implementation to track. The items below record the verification step for the full baseline capture.

## 1. Baseline verification

- [x] 1.1 Run `openspec validate "baseline-specs" --type change --strict` and confirm all 14 specs pass strict validation with no warnings.
- [x] 1.2 Confirm all 14 spec files exist under `openspec/changes/baseline-specs/specs/` (batch 1: room-identity, inbox-outbox, scheduler, retention, digests; batch 2: message-context, agent-loop, flow-handler, model-router, memory-rag; batch 3: platform-providers, admin-dashboard, logging-errors, webhook-server).
- [x] 1.3 Confirm `proposal.md`, `design.md`, and `tasks.md` are complete; `openspec status --change baseline-specs` reports all artifacts `done`.

## Workflow follow-up

- Optionally archive once the user is satisfied with the baseline coverage, or keep the change open for incremental additions. Future behavioral changes SHALL declare deltas against these specs rather than editing them wholesale.
