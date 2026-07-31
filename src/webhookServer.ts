/**
 * @file src/webhookServer.ts
 * @description Lightweight HTTP webhook server for inbound notifications.
 * This file is now a facade. The implementation has been modularized into src/webhooks/.
 */

export { WebhookServer } from './webhooks/WebhookServer';
