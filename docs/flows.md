# Flows

ElastraX supports multi-step interactive flows (for example collecting several images for a PDF merge, or confirming a menfess). Flows are room- and user-scoped, persisted in SQLite, versioned against lost updates, and resumed after a restart.

## Model

- `src/core/FlowHandler.ts` owns flow state. A `UserSession` holds a map of `FlowSession` objects keyed by flow id, plus an `activeFlow` pointer.
- Each `FlowSession` carries `flow`, `step`, `data`, `expiresAt`, and optional `roomId`/`platform`/`version`.
- Processors are registered by name via `FlowHandler.register(flowName, processor)`. `src/flows/registry.ts` registers the built-in processors on startup through `registerFlows()` / `safeRegisterFlows()`.
- State is loaded from the `flow_sessions` table at initialization and pruned of expired entries; surviving sessions are written back.
- Concurrency is serialized per room/user through a promise lock; sessions are versioned so a stale writer raises `FlowVersionConflictError`.
- Expiry is enforced on every access; expired flows are removed and their ids collected for cleanup.

## Registered flows

| Flow name | Source tool | Purpose |
|---|---|---|
| `media_connect` | `MediaBindTool` | Link a chat room to Seerr/Jellyfin accounts. |
| `menfess_confirm` | `MenfessTool` | Confirm an anonymous confession before relay. |
| `pdf_img_collect` | `PDFTool` | Collect multiple images before producing a PDF. |
| `pdf_merge_collect` | `PDFTool` | Collect multiple PDFs before merging. |

## Cancellation

Flow steps can be cancelled with the commands listed in `CANCEL_COMMANDS` (`src/core/constants.ts`). Expired or abandoned sessions are removed by retention (`RETENTION_FLOW_SESSION_DAYS`, default 30 days).

## Adding a flow

1. Implement a `FlowProcessor` `(ctx, activeFlowData, flowId) => Promise<void>`.
2. Register it in `src/flows/registry.ts` (or a plugin) with `FlowHandler.register`.
3. Persist any multi-step data inside `activeFlowData.data`.
4. Respect versioning and expiry; do not bypass the lock.
