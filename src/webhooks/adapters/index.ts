import type { WebhookBody } from '../types';
import { sanitizeWebhookBody } from '../utils';
import { adaptGitHub } from './github';
import { adaptGrafana } from './grafana';
import { adaptApprise, isApprisePayload } from './apprise';
import { buildGenericMessage } from './generic';

export function buildWebhookMessage(headers: Record<string, string | undefined>, body: WebhookBody): string {
  const safeBody = sanitizeWebhookBody(body);
  const githubEvent = headers['x-github-event'];
  if (githubEvent) return adaptGitHub(githubEvent, safeBody);

  const grafanaOrigin = headers['x-grafana-origin'];
  if (grafanaOrigin || safeBody.alerts) return adaptGrafana(safeBody);

  if (isApprisePayload(headers, safeBody)) return adaptApprise(safeBody);

  return buildGenericMessage(safeBody);
}

export * from './media';
