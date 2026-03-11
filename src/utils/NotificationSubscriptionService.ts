/**
 * @file src/utils/NotificationSubscriptionService.ts
 * @description Manages which chat rooms receive notifications from external services.
 */

import { db } from '../db';
import { notificationSubscriptions } from '../db/schema';
import { eq, and, or } from 'drizzle-orm';
import { logger } from './logger';
import { ServiceBindingService } from './ServiceBindingService';

const log = logger.child({ module: 'NotificationSubscriptionService' });

type SubDeps = {
  db: typeof import('../db').db;
  notificationSubscriptions: typeof import('../db/schema').notificationSubscriptions;
};

export class NotificationSubscriptionService {
  private static deps: SubDeps = { db, notificationSubscriptions };

  static setDepsForTesting(deps: SubDeps | null): void {
    this.deps = deps ?? { db, notificationSubscriptions };
  }

  /** Subscribe a chat room to receive notifications. */
  static async subscribe(opts: {
    userId: string;
    platform: string;
    serviceType: string;
    chatRoomId: string;
    notifyTypes?: string[] | null;
  }): Promise<void> {
    const { db, notificationSubscriptions } = this.deps;
    const existing = await db
      .select()
      .from(notificationSubscriptions)
      .where(
        and(
          eq(notificationSubscriptions.userId, opts.userId),
          eq(notificationSubscriptions.platform, opts.platform),
          eq(notificationSubscriptions.serviceType, opts.serviceType),
          eq(notificationSubscriptions.chatRoomId, opts.chatRoomId),
        ),
      )
      .limit(1);

    const notifyTypesJson = opts.notifyTypes ? JSON.stringify(opts.notifyTypes) : null;

    if (existing.length > 0) {
      await db
        .update(notificationSubscriptions)
        .set({ notifyTypes: notifyTypesJson })
        .where(eq(notificationSubscriptions.id, existing[0].id));
      log.info({ userId: opts.userId, chatRoomId: opts.chatRoomId, serviceType: opts.serviceType }, 'Updated notification subscription');
    } else {
      await db.insert(notificationSubscriptions).values({
        userId: opts.userId,
        platform: opts.platform,
        serviceType: opts.serviceType,
        chatRoomId: opts.chatRoomId,
        notifyTypes: notifyTypesJson,
        created_at: new Date(),
      });
      log.info({ userId: opts.userId, chatRoomId: opts.chatRoomId, serviceType: opts.serviceType }, 'Created notification subscription');
    }
  }

  /** Unsubscribe a chat room from notifications. */
  static async unsubscribe(userId: string, platform: string, serviceType: string, chatRoomId: string): Promise<boolean> {
    const { db, notificationSubscriptions } = this.deps;
    const existing = await db
      .select({ id: notificationSubscriptions.id })
      .from(notificationSubscriptions)
      .where(
        and(
          eq(notificationSubscriptions.userId, userId),
          eq(notificationSubscriptions.platform, platform),
          eq(notificationSubscriptions.serviceType, serviceType),
          eq(notificationSubscriptions.chatRoomId, chatRoomId),
        ),
      )
      .limit(1);
    if (existing.length === 0) return false;
    await db.delete(notificationSubscriptions).where(eq(notificationSubscriptions.id, existing[0].id));
    return true;
  }

  /** List all notification subscriptions for a user. */
  static async getSubscriptions(userId: string, platform: string, serviceType?: string) {
    const { db, notificationSubscriptions } = this.deps;
    const conditions = [
      eq(notificationSubscriptions.userId, userId),
      eq(notificationSubscriptions.platform, platform),
    ];
    if (serviceType) {
      conditions.push(eq(notificationSubscriptions.serviceType, serviceType));
    }
    return db
      .select()
      .from(notificationSubscriptions)
      .where(and(...conditions));
  }

  /** Get all subscribers for a given service type (for broadcast routing). */
  static async getSubscribersForService(serviceType: string) {
    const { db, notificationSubscriptions } = this.deps;
    return db
      .select()
      .from(notificationSubscriptions)
      .where(
        or(
          eq(notificationSubscriptions.serviceType, serviceType),
          eq(notificationSubscriptions.serviceType, 'all'),
        ),
      );
  }

  /**
   * Resolve which chat rooms a specific user's notification should be sent to.
   * Returns an array of { chatRoomId, platform } objects.
   */
  static async getNotificationRooms(userId: string, platform: string, serviceType: string): Promise<{ chatRoomId: string; platform: string }[]> {
    const subs = await this.getSubscriptions(userId, platform, serviceType);
    // Also get 'all' type subscriptions for this user
    const allSubs = await this.getSubscriptions(userId, platform, 'all');
    const combined = [...subs, ...allSubs];
    // Deduplicate by chatRoomId
    const seen = new Set<string>();
    return combined
      .filter((sub) => {
        if (seen.has(sub.chatRoomId)) return false;
        seen.add(sub.chatRoomId);
        return true;
      })
      .map((sub) => ({ chatRoomId: sub.chatRoomId, platform: sub.platform }));
  }

  /**
   * Get notification rooms for Jellyfin admin users.
   * Admins receive ALL notifications for a service type.
   */
  static async getAdminNotificationRooms(serviceType: string): Promise<{ chatRoomId: string; platform: string; userId: string }[]> {
    const adminBindings = await ServiceBindingService.getAdminBindings(serviceType === 'seerr' ? 'jellyfin' : serviceType);
    const rooms: { chatRoomId: string; platform: string; userId: string }[] = [];
    const seen = new Set<string>();

    for (const binding of adminBindings) {
      const subs = await this.getSubscriptions(binding.userId, binding.platform);
      for (const sub of subs) {
        const key = `${sub.chatRoomId}:${sub.platform}`;
        if (!seen.has(key)) {
          seen.add(key);
          rooms.push({ chatRoomId: sub.chatRoomId, platform: sub.platform, userId: binding.userId });
        }
      }
    }

    return rooms;
  }
}
