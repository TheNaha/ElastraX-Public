import { SeerrClient } from '../providers/seerr/SeerrClient';
import { JellyfinClient } from '../providers/jellyfin/JellyfinClient';
import { ServiceBindingService } from './ServiceBindingService';
import { NotificationSubscriptionService } from './NotificationSubscriptionService';

/**
 * Lazily caches clients keyed by the env-derived config they were built with,
 * so repeated tool calls reuse one HTTP client per distinct configuration
 * instead of re-reading env and re-building a client on every execute().
 */
class MediaServiceClass {
  private seerrClients = new Map<string, SeerrClient>();
  private jellyfinClients = new Map<string, JellyfinClient>();

  createSeerrClient(): SeerrClient {
    const key = `${process.env.SEERR_API_URL ?? ''}|${process.env.SEERR_API_KEY ?? ''}`;
    let client = this.seerrClients.get(key);
    if (!client) {
      client = new SeerrClient();
      this.seerrClients.set(key, client);
    }
    return client;
  }

  createJellyfinClient(): JellyfinClient {
    const key = [
      process.env.JELLYFIN_API_URL ?? '',
      process.env.JELLYFIN_API_KEY ?? '',
      process.env.JELLYFIN_EXTERNAL_URL ?? '',
    ].join('|');
    let client = this.jellyfinClients.get(key);
    if (!client) {
      client = new JellyfinClient();
      this.jellyfinClients.set(key, client);
    }
    return client;
  }

  bindingService: typeof ServiceBindingService = ServiceBindingService;

  notificationService: typeof NotificationSubscriptionService = NotificationSubscriptionService;
}

export const MediaService = new MediaServiceClass();
