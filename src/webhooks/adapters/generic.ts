import type { WebhookBody } from '../types';
import { asNonEmptyString, normalizePriority, toStringArray } from '../utils';
import { t } from '../../utils/i18n';

export function buildGenericMessage(body: WebhookBody, lang: string = 'en'): string {
  const title = asNonEmptyString(body.title);
  const text = asNonEmptyString(body.text)
    || asNonEmptyString(body.message)
    || asNonEmptyString(body.body)
    || asNonEmptyString(body.description)
    || null;
  const source = asNonEmptyString(body.source) || asNonEmptyString(body.service);
  const event = asNonEmptyString(body.event) || asNonEmptyString(body.event_type);
  const level = normalizePriority(
    asNonEmptyString(body.priority)
    || asNonEmptyString(body.severity)
    || asNonEmptyString(body.level),
  );
  const tags = toStringArray(body.tags ?? body.tag);
  const link = asNonEmptyString(body.url) || asNonEmptyString(body.link);

  const icon = level === 'critical'
    ? '🚨'
    : level === 'high'
      ? '⚠️'
      : level === 'low'
        ? '🔎'
        : '📨';

  if (!title && !text && !source && !event && tags.length === 0 && !link) {
    const keys = Object.keys(body).slice(0, 20);
    return keys.length > 0
      ? t(lang, 'webhook.generic.received_fields', { fields: keys.join(', ') })
      : t(lang, 'webhook.generic.received');
  }

  const lines: string[] = [];
  if (title) {
    lines.push(`${icon} *${title}*`);
  } else if (event) {
    lines.push(`${icon} *${event}*`);
  }

  if (text) lines.push(text);
  if (source) lines.push(t(lang, 'webhook.generic.source', { source }));
  if (event && title) lines.push(t(lang, 'webhook.generic.event', { event }));
  if (level) lines.push(t(lang, 'webhook.generic.priority', { level }));
  if (tags.length > 0) lines.push(t(lang, 'webhook.generic.tags', { tags: tags.join(', ') }));
  if (link) lines.push(`🔗 ${link}`);

  return lines.join('\n');
}
