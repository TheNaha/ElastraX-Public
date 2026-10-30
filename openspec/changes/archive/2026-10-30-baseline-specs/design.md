# Design

> This is a documentation-only baseline capture. There is no implementation; design.md records why the planning artifacts below are sufficient and where implementation lives today.

## Context

See proposal.md - Why. The purpose of this change is to freeze the existing documented behavior of ElastraX's durable subsystems as OpenSpec specs so future changes have a contract to diff against. No code, schema, or behavior changes are made. The behavior described in the specs is already present in the current source under `src/` and `docs/`.

## Goals / Non-Goals

- **Goal:** Provide a spec baseline for room identity, inbox/outbox, scheduler, retention, and digests, each grounded in existing source.
- **Non-Goal:** Change any behavior. This change introduces no new capabilities, modifies no requirements, and adds no tasks.
- **Non-Goal:** Spec depth beyond what is needed to anchor future deltas; batch-2 capabilities (message-context, agent-loop, etc.) are explicitly deferred to a follow-up change.

## Decisions

1. **One capability → one spec path.** Each durable subsystem gets a single `specs/<capability>/spec.md` rather than per-feature specs, so requirements cohere under an owner the team can evolve.
2. **Specs describe behavior, not code.** Internal class names and SQL column lists are referenced only when they are an observable contract boundary (e.g. `room_key` vs `chat_room_id` is part of the room-identity contract).
3. **Batch-then-review.** Rather than authoring all ~14 specs in one pass (risking shallow, low-signal content), the work is split into batches. Batch 1 captures the contract-heavy subsystems with the most regression risk.

## Risks / Trade-offs

- [Risk: Specs drift from code without a sync gate.] → Mitigation: the migration drift gate (`bun run db:generate`) already enforces schema drift separately; spec accuracy is enforced by `openspec validate --strict` plus future changes declaring deltas.
- [Risk: Scenario depth is shallow for some requirements.] → Mitigation: each scenario is written to be testable and reviewable; depth can be added per-capability on request.

## Migration Plan

No migration. No database, code, or dependency changes. To adopt: review each spec against the corresponding source; flag mismatches as a follow-up change rather than editing here.

## Open Questions

None for this documentation-only baseline. Open questions about future behavioral changes belong to the changes that propose them.
