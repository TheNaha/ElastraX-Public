import type { WebhookBody } from '../types';
import { asNonEmptyString, asScalarString } from '../utils';
import { t } from '../../utils/i18n';

/**
 * Seerr notifications.
 *
 * Labels come from the translation table so a room subscribed to the media
 * service reads them in its own language; only the service-supplied subject and
 * message are forwarded verbatim.
 */
export function adaptSeerr(body: WebhookBody, lang: string = 'en'): string {
  const notifType = asNonEmptyString(body.notification_type) ?? 'UNKNOWN';
  const subject = asNonEmptyString(body.subject) ?? '';
  const message = asNonEmptyString(body.message) ?? '';
  const line = (key: string) => `${t(lang, key, { subject })}${message ? `\n${message}` : ''}`.trim();
  switch (notifType) {
    case 'MEDIA_PENDING':
      return line('webhook.seerr.new_request');
    case 'MEDIA_APPROVED':
      return line('webhook.seerr.approved');
    case 'MEDIA_AUTO_APPROVED':
      return line('webhook.seerr.auto_approved');
    case 'MEDIA_AVAILABLE':
      return line('webhook.seerr.available');
    case 'MEDIA_DECLINED':
      return line('webhook.seerr.declined');
    case 'MEDIA_FAILED':
      return line('webhook.seerr.failed');
    case 'ISSUE_CREATED':
      return line('webhook.seerr.issue_created');
    case 'ISSUE_RESOLVED':
      return t(lang, 'webhook.seerr.issue_resolved', { subject }).trim();
    case 'ISSUE_COMMENT': {
      const comment = asNonEmptyString(body.comment_message) ?? message;
      return `${t(lang, 'webhook.seerr.issue_comment', { subject })}${comment ? `\n${comment}` : ''}`.trim();
    }
    case 'TEST_NOTIFICATION':
      return t(lang, 'webhook.seerr.test');
    default:
      return `${t(lang, 'webhook.seerr.update', { type: notifType, subject })}${message ? `\n${message}` : ''}`.trim();
  }
}

export function adaptJellyfin(body: WebhookBody, lang: string = 'en'): string | null {
  const notifType = asNonEmptyString(body.NotificationType) ?? 'Unknown';

  if (notifType === 'Unknown' || notifType === 'UNKNOWN') return null;
  const name = asNonEmptyString(body.Name) ?? t(lang, 'webhook.unknown');
  const overview = asNonEmptyString(body.Overview) ?? '';
  const year = asScalarString(body.Year) ?? '';
  const seriesName = asNonEmptyString(body.SeriesName);
  const seasonNum = asScalarString(body.SeasonNumber00);
  const episodeNum = asScalarString(body.EpisodeNumber00);
  const username = asNonEmptyString(body.NotificationUsername) ?? '';
  const deviceName = asNonEmptyString(body.DeviceName) ?? '';

  let displayName = name;
  if (seriesName) {
    displayName = `${seriesName}`;
    if (seasonNum && episodeNum) displayName += ` S${seasonNum}E${episodeNum}`;
    displayName += ` — ${name}`;
  }
  const yearStr = year ? ` (${year})` : '';
  const shown = `${displayName}${yearStr}`;

  switch (notifType) {
    case 'ItemAdded':
      return `${t(lang, 'webhook.jellyfin.item_added', { name: shown })}${overview ? `\n${overview}` : ''}`.trim();
    case 'ItemDeleted':
      return t(lang, 'webhook.jellyfin.item_deleted', { name: shown });
    case 'PlaybackStart':
      return t(lang, 'webhook.jellyfin.playback_start', { name: shown })
        + (username ? t(lang, 'webhook.jellyfin.user_label', { user: username }) : '')
        + (deviceName ? t(lang, 'webhook.jellyfin.device_label', { device: deviceName }) : '');
    case 'PlaybackStop':
      return t(lang, 'webhook.jellyfin.playback_stop', { name: shown })
        + (username ? t(lang, 'webhook.jellyfin.user_label', { user: username }) : '');
    case 'UserCreated':
      return t(lang, 'webhook.jellyfin.user_created', { user: username });
    case 'AuthenticationFailure':
      return t(lang, 'webhook.jellyfin.auth_failure', { user: username });
    case 'PendingRestart':
      return t(lang, 'webhook.jellyfin.pending_restart');
    case 'TaskCompleted': {
      const taskName = asNonEmptyString(body.TaskName) ?? t(lang, 'webhook.unknown');
      return t(lang, 'webhook.jellyfin.task_completed', { task: taskName });
    }
    case 'PluginInstalled':
      return t(lang, 'webhook.jellyfin.plugin_installed', { name });
    default:
      return t(lang, 'webhook.jellyfin.update', { type: notifType, name: shown });
  }
}
