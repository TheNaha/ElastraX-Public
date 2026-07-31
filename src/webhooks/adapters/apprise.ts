import type { WebhookBody } from '../types';
import { asNonEmptyString, toStringArray } from '../utils';

export function isApprisePayload(headers: Record<string, string | undefined>, body: WebhookBody): boolean {
  if (headers['x-apprise-notification-type']) return true;
  if (headers['x-apprise-title']) return true;

  if (body.notify_type !== undefined && body.notify_type !== null) return true;
  if (body.apprise !== undefined && body.apprise !== null) return true;

  const hasSubject = asNonEmptyString(body.subject) !== null;
  const hasBodyLikeText = asNonEmptyString(body.body)
    || asNonEmptyString(body.message)
    || asNonEmptyString(body.text);

  return hasSubject && hasBodyLikeText !== null;
}

export function adaptApprise(body: WebhookBody): string {
  const title = asNonEmptyString(body.title) || asNonEmptyString(body.subject);
  const content = asNonEmptyString(body.body)
    || asNonEmptyString(body.message)
    || asNonEmptyString(body.text)
    || asNonEmptyString(body.msg)
    || '';
  const notifyType = asNonEmptyString(body.notify_type)
    || asNonEmptyString(body.type)
    || 'info';
  const tags = toStringArray(body.tag ?? body.tags);
  const source = asNonEmptyString(body.source)
    || asNonEmptyString(body.service)
    || asNonEmptyString(body.app)
    || null;
  const timestamp = asNonEmptyString(body.timestamp) || asNonEmptyString(body.ts);
  const link = asNonEmptyString(body.url) || asNonEmptyString(body.link);

  const icon = notifyType.toLowerCase() === 'success'
    ? '✅'
    : notifyType.toLowerCase() === 'warning'
      ? '⚠️'
      : (notifyType.toLowerCase() === 'failure' || notifyType.toLowerCase() === 'error')
        ? '❌'
        : notifyType.toLowerCase() === 'info'
          ? 'ℹ️'
          : '🔔';

  const lines = [
    `${icon} *${title || 'Apprise Notification'}*`,
    content || '(empty message body)',
  ];

  if (source) lines.push(`🧩 Source: ${source}`);
  if (tags.length > 0) lines.push(`🏷️ Tags: ${tags.join(', ')}`);
  if (timestamp) lines.push(`🕒 Time: ${timestamp}`);
  if (link) lines.push(`🔗 ${link}`);

  return lines.join('\n');
}
