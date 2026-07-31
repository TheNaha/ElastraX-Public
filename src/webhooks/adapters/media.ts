import type { WebhookBody } from '../types';
import { asNonEmptyString } from '../utils';

export function adaptSeerr(body: WebhookBody): string {
  const notifType = asNonEmptyString(body.notification_type) ?? 'UNKNOWN';
  const subject = asNonEmptyString(body.subject) ?? '';
  const message = asNonEmptyString(body.message) ?? '';
  switch (notifType) {
    case 'MEDIA_PENDING':
      return `🎬 *New Request* — ${subject}\n${message}`.trim();
    case 'MEDIA_APPROVED':
      return `✅ *Request Approved* — ${subject}\n${message}`.trim();
    case 'MEDIA_AUTO_APPROVED':
      return `✅ *Auto-Approved* — ${subject}\n${message}`.trim();
    case 'MEDIA_AVAILABLE':
      return `🎉 *Now Available!* — ${subject}\n${message}`.trim();
    case 'MEDIA_DECLINED':
      return `❌ *Request Declined* — ${subject}\n${message}`.trim();
    case 'MEDIA_FAILED':
      return `⚠️ *Request Failed* — ${subject}\n${message}`.trim();
    case 'ISSUE_CREATED':
      return `🐛 *Issue Reported* — ${subject}\n${message}`.trim();
    case 'ISSUE_RESOLVED':
      return `✅ *Issue Resolved* — ${subject}`.trim();
    case 'ISSUE_COMMENT': {
      const comment = asNonEmptyString(body.comment_message) ?? message;
      return `💬 *New Comment* on ${subject}\n${comment}`.trim();
    }
    case 'TEST_NOTIFICATION':
      return '🔔 Request service notification test successful!';
    default:
      return `🔔 *Media Update (${notifType})* — ${subject}\n${message}`.trim();
  }
}

export function adaptJellyfin(body: WebhookBody): string | null {
  const notifType = asNonEmptyString(body.NotificationType) ?? 'Unknown';

  if (notifType === 'Unknown' || notifType === 'UNKNOWN') return null;
  const name = asNonEmptyString(body.Name) ?? 'Unknown';
  const overview = asNonEmptyString(body.Overview) ?? '';
  const year = asNonEmptyString(body.Year) ?? '';
  const seriesName = asNonEmptyString(body.SeriesName);
  const seasonNum = asNonEmptyString(body.SeasonNumber00);
  const episodeNum = asNonEmptyString(body.EpisodeNumber00);
  const username = asNonEmptyString(body.NotificationUsername) ?? '';
  const deviceName = asNonEmptyString(body.DeviceName) ?? '';

  let displayName = name;
  if (seriesName) {
    displayName = `${seriesName}`;
    if (seasonNum && episodeNum) displayName += ` S${seasonNum}E${episodeNum}`;
    displayName += ` — ${name}`;
  }
  const yearStr = year ? ` (${year})` : '';

  switch (notifType) {
    case 'ItemAdded':
      return `📥 *New Media Added* — ${displayName}${yearStr}\n${overview}`.trim();
    case 'ItemDeleted':
      return `🗑️ *Media Removed* — ${displayName}${yearStr}`;
    case 'PlaybackStart':
      return `▶️ *Now Playing* — ${displayName}\nUser: ${username}\nDevice: ${deviceName}`;
    case 'PlaybackStop':
      return `⏹️ *Stopped Playing* — ${displayName}\nUser: ${username}`;
    case 'UserCreated':
      return `👤 *New User Created* — ${username}`;
    case 'AuthenticationFailure':
      return `🔒 *Auth Failure* — User: ${username}`;
    case 'PendingRestart':
      return '🔄 *Server Pending Restart*';
    case 'TaskCompleted': {
      const taskName = asNonEmptyString(body.TaskName) ?? 'Unknown Task';
      return `✅ *Task Completed* — ${taskName}`;
    }
    case 'PluginInstalled':
      return `🔌 *Plugin Installed* — ${name}`;
    default:
      return `🔔 *Streaming Service (${notifType})* — ${displayName}${yearStr}`;
  }
}
