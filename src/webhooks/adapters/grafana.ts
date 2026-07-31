import type { WebhookBody } from '../types';
import { asNonEmptyString, asRecord, toObjectArray } from '../utils';

export function adaptGrafana(body: WebhookBody): string {
  const alerts = toObjectArray(body.alerts);
  if (alerts.length === 0) return `🔔 *Grafana Alert*\n${JSON.stringify(body).slice(0, 300)}`;

  return alerts.map((alert) => {
    const labels = asRecord(alert.labels);
    const annotations = asRecord(alert.annotations);
    const status = asNonEmptyString(alert.status) || 'unknown';
    const icon = status === 'firing' ? '🔥' : '✅';
    const name = asNonEmptyString(labels?.alertname) || 'Unknown Alert';
    const summary = asNonEmptyString(annotations?.summary) || asNonEmptyString(annotations?.description) || '';
    return `${icon} *${name}* (${status.toUpperCase()})\n${summary}`.trim();
  }).join('\n\n');
}
