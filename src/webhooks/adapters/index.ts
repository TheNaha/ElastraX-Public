import type { WebhookBody } from '../types';
import { adaptGitHub } from './github';
import { adaptGrafana } from './grafana';
import { adaptApprise, isApprisePayload } from './apprise';
import { buildGenericMessage } from './generic';

export function buildWebhookMessage(headers: Record<string, string | undefined>, body: WebhookBody): string {
  // GitHub
  const githubEvent = headers['x-github-event'];
  if (githubEvent) return adaptGitHub(githubEvent, body);

  // Grafana
  const grafanaOrigin = headers['x-grafana-origin'];
  if (grafanaOrigin || body.alerts) return adaptGrafana(body);

  // Apprise-compatible payload
  if (isApprisePayload(headers, body)) return adaptApprise(body);

  // Rich generic payload
  return buildGenericMessage(body);
}

export * from './media';
