import type { WebhookBody } from '../types';
import { asNonEmptyString, normalizePriority, toStringArray } from '../utils';

export function buildGenericMessage(body: WebhookBody): string {
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
    return `📨 Webhook payload:\n${JSON.stringify(body, null, 2).slice(0, 500)}`;
  }

  const lines: string[] = [];
  if (title) {
    lines.push(`${icon} *${title}*`);
  } else if (event) {
    lines.push(`${icon} *${event}*`);
  }

  if (text) lines.push(text);
  if (source) lines.push(`🧩 Source: ${source}`);
  if (event && title) lines.push(`📌 Event: ${event}`);
  if (level) lines.push(`📊 Priority: ${level}`);
  if (tags.length > 0) lines.push(`🏷️ Tags: ${tags.join(', ')}`);
  if (link) lines.push(`🔗 ${link}`);

  return lines.join('\n');
}
