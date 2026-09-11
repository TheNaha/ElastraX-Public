/**
 * @file src/webhookServer.ts
 * @description Backwards-compatibility shim.
 *
 * The webhook implementation was consolidated into `src/webhooks/` during the
 * modularization effort:
 *   - `WebhookServer` class  -> `src/webhooks/WebhookServer.ts`
 *   - message adapters       -> `src/webhooks/adapters/index.ts`
 *   - helpers (port/body limits, signature verification, room resolution) ->
 *     `src/webhooks/utils.ts`
 *
 * This file remains so existing imports of `../webhookServer` keep working.
 * New code should import from `./webhooks/*` directly. The test suite still
 * imports from this path, which also keeps the public surface pinned.
 */
export { WebhookServer } from './webhooks/WebhookServer';
export { buildWebhookMessage } from './webhooks/adapters/index';
export {
  readRequestBodyWithLimit,
  resolveRoomIds,
  resolveWebhookMaxBodyBytes,
  resolveWebhookPort,
  verifyGitHubSignature,
} from './webhooks/utils';
