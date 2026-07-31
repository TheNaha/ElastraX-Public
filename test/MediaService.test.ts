import { expect, test, describe } from 'bun:test';
import { MediaService } from '../src/utils/MediaService';
import { SeerrClient } from '../src/providers/seerr/SeerrClient';
import { JellyfinClient } from '../src/providers/jellyfin/JellyfinClient';
import { ServiceBindingService } from '../src/utils/ServiceBindingService';
import { NotificationSubscriptionService } from '../src/utils/NotificationSubscriptionService';

describe('MediaService', () => {
  test('should create a new SeerrClient instance', () => {
    const client = MediaService.createSeerrClient();
    expect(client).toBeInstanceOf(SeerrClient);
  });

  test('should create a new JellyfinClient instance', () => {
    const client = MediaService.createJellyfinClient();
    expect(client).toBeInstanceOf(JellyfinClient);
  });

  test('should provide access to ServiceBindingService', () => {
    expect(MediaService.bindingService).toBe(ServiceBindingService);
  });

  test('should provide access to NotificationSubscriptionService', () => {
    expect(MediaService.notificationService).toBe(NotificationSubscriptionService);
  });
});
