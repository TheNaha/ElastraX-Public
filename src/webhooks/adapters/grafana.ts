import type { WebhookBody } from '../types';
import { asNonEmptyString, asRecord, toObjectArray } from '../utils';
import { t } from '../../utils/i18n';

/** Grafana alert notifications. `lang` is the target room's language. */
export function adaptGrafana(body: WebhookBody, lang: string = 'en'): string {
  const alerts = toObjectArray(body.alerts);
  if (alerts.length === 0) {
    return `${t(lang, 'webhook.grafana.alert', { title: t(lang, 'webhook.unknown') })}\n${JSON.stringify(body).slice(0, 300)}`;
  }

  return alerts.map((alert) => {
    const labels = asRecord(alert.labels);
    const annotations = asRecord(alert.annotations);
    const status = asNonEmptyString(alert.status) || t(lang, 'webhook.unknown');
    const icon = status === 'firing' ? '🔥' : '✅';
    const name = asNonEmptyString(labels?.alertname) || t(lang, 'webhook.unknown');
    const summary = asNonEmptyString(annotations?.summary) || asNonEmptyString(annotations?.description) || '';
    return `${icon} *${name}* (${status.toUpperCase()})\n${summary}`.trim();
  }).join('\n\n');
}
