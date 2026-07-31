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

  get bindingService(): typeof ServiceBindingService {
    return ServiceBindingService;
  }

  get notificationService(): typeof NotificationSubscriptionService {
    return NotificationSubscriptionService;
  }
}

export const MediaService = new MediaServiceClass();
