import { SeerrClient } from '../providers/seerr/SeerrClient';
import { JellyfinClient } from '../providers/jellyfin/JellyfinClient';
import { ServiceBindingService } from './ServiceBindingService';
import { NotificationSubscriptionService } from './NotificationSubscriptionService';

class MediaServiceClass {
  createSeerrClient(): SeerrClient {
    return new SeerrClient();
  }

  createJellyfinClient(): JellyfinClient {
    return new JellyfinClient();
  }

  bindingService: typeof ServiceBindingService = ServiceBindingService;

  notificationService: typeof NotificationSubscriptionService = NotificationSubscriptionService;
}

export const MediaService = new MediaServiceClass();
