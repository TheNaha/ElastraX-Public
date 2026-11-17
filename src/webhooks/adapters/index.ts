import type { WebhookBody } from '../types';
import { sanitizeWebhookBody } from '../utils';
import { adaptGitHub } from './github';
import { adaptGrafana } from './grafana';
import { adaptApprise, isApprisePayload } from './apprise';
import { buildGenericMessage } from './generic';

/** Grafana alert payloads carry an `alerts` array and a `receiver` name. */
function looksLikeGrafanaPayload(body: WebhookBody): boolean {
  if (Array.isArray(body.alerts)) return true;
  return typeof body.receiver === 'string' && (body.status === 'firing' || body.status === 'resolved');
}

export function buildWebhookMessage(headers: Record<string, string | undefined>, body: WebhookBody): string {
  const safeBody = sanitizeWebhookBody(body);
  const githubEvent = headers['x-github-event'];
  if (githubEvent) return adaptGitHub(githubEvent, safeBody);

  // A Grafana generic-webhook contact point sends JSON only; the origin header
  // is set by Grafana's own webhook integration, not by the contact point. Keying
  // on the header alone sent real alerts to the generic formatter.
  const grafanaOrigin = headers['x-grafana-origin'];
  if (grafanaOrigin || looksLikeGrafanaPayload(safeBody)) return adaptGrafana(safeBody);

  if (isApprisePayload(headers, safeBody)) return adaptApprise(safeBody);

  return buildGenericMessage(safeBody);
}

export * from './media';
