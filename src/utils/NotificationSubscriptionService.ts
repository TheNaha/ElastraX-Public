import { db } from '../db';
import { notificationSubscriptions } from '../db/schema';
import { eq, and, or, type SQL } from 'drizzle-orm';
import { logger } from './logger';
import { ServiceBindingService } from './ServiceBindingService';

const log = logger.child({ module: 'NotificationSubscriptionService' });

type SubDeps = {
  db: typeof import('../db').db;
  notificationSubscriptions: typeof import('../db/schema').notificationSubscriptions;
};

export type NotificationServiceType = 'all' | 'jellyfin' | 'seerr' | (string & {});

export function normalizeServiceType(value: string | null | undefined): NotificationServiceType {
  const normalized = String(value ?? 'all').trim().toLowerCase();
  if (normalized === '*' || normalized === 'any' || normalized === 'media') return 'all';
  return normalized || 'all';
}

export const normalizeNotificationType = normalizeServiceType;

export function normalizeNotifyTypes(value: string | string[] | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  let rawValues: unknown[];
  if (Array.isArray(value)) rawValues = value;
  else {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      rawValues = Array.isArray(parsed) ? parsed : trimmed.split(',');
    } catch {
      rawValues = trimmed.split(',');
    }
  }
  const normalized = [...new Set(rawValues.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0 || normalized.includes('all') || normalized.includes('*')) return null;
  return normalized;
}

function storedNotifyTypes(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    return normalizeNotifyTypes(JSON.parse(value) as unknown as string[] | string);
  } catch {
    return normalizeNotifyTypes(value);
  }
}

function matchesEvent(value: string | null | undefined, eventType?: string): boolean {
  if (!eventType) return true;
  const types = storedNotifyTypes(value);
  return types === null || types.includes(eventType.trim().toLowerCase()) || types.includes('all');
}

export class NotificationSubscriptionService {
  private static deps: SubDeps = { db, notificationSubscriptions };

  static setDepsForTesting(deps: SubDeps | null): void {
    this.deps = deps ?? { db, notificationSubscriptions };
  }

  static normalizeServiceType(value: string | null | undefined): NotificationServiceType {
    return normalizeServiceType(value);
  }

  static normalizeNotifyTypes(value: string | string[] | null | undefined): string[] | null {
    return normalizeNotifyTypes(value);
  }

  static assertRoomAccess(opts: {
    currentRoomId?: string;
    requestedRoomId: string;
    isOwner?: boolean;
    roomVerified?: boolean;
    requireOwner?: boolean;
  }): void {
    if (typeof opts.requestedRoomId !== 'string' || !opts.requestedRoomId.trim()) throw new Error('A notification room is required.');
    if (opts.currentRoomId !== undefined && opts.requestedRoomId !== opts.currentRoomId && !opts.isOwner) {
      throw new Error('Foreign notification rooms require owner permission.');
    }
    if (opts.currentRoomId !== undefined && opts.requestedRoomId !== opts.currentRoomId && opts.roomVerified !== true) {
      throw new Error('Foreign notification rooms require verified platform membership.');
    }
    if (opts.requireOwner && !opts.isOwner) throw new Error('Owner permission is required.');
  }

  static async subscribe(opts: {
    userId: string;
    platform: string;
    serviceType: string;
    chatRoomId: string;
    notifyTypes?: string[] | string | null;
    currentRoomId?: string;
    isOwner?: boolean;
    roomVerified?: boolean;
    requireOwner?: boolean;
  }): Promise<void> {
    if (typeof opts.userId !== 'string' || typeof opts.platform !== 'string' || !opts.userId.trim() || !opts.platform.trim()) throw new Error('A user and platform are required.');
    this.assertRoomAccess({
      currentRoomId: opts.currentRoomId,
      requestedRoomId: opts.chatRoomId,
      isOwner: opts.isOwner,
      roomVerified: opts.roomVerified,
      requireOwner: opts.requireOwner,
    });
    const serviceType = normalizeServiceType(opts.serviceType);
    const { db, notificationSubscriptions } = this.deps;
    const existing = await db.select().from(notificationSubscriptions).where(and(
      eq(notificationSubscriptions.userId, opts.userId),
      eq(notificationSubscriptions.platform, opts.platform),
      eq(notificationSubscriptions.serviceType, serviceType),
      eq(notificationSubscriptions.chatRoomId, opts.chatRoomId),
    )).limit(1);
    const normalizedTypes = normalizeNotifyTypes(opts.notifyTypes);
    const notifyTypesJson = normalizedTypes ? JSON.stringify(normalizedTypes) : null;
    if (existing.length > 0) {
      await db.update(notificationSubscriptions).set({ notifyTypes: notifyTypesJson }).where(eq(notificationSubscriptions.id, existing[0].id));
      log.info({ userId: opts.userId, chatRoomId: opts.chatRoomId, serviceType }, 'Updated notification subscription');
    } else {
      await db.insert(notificationSubscriptions).values({ userId: opts.userId, platform: opts.platform, serviceType, chatRoomId: opts.chatRoomId, notifyTypes: notifyTypesJson, created_at: new Date() });
      log.info({ userId: opts.userId, chatRoomId: opts.chatRoomId, serviceType }, 'Created notification subscription');
    }
  }

  static async unsubscribe(userId: string, platform: string, serviceType: string, chatRoomId: string, access?: { currentRoomId?: string; isOwner?: boolean; roomVerified?: boolean; requireOwner?: boolean }): Promise<boolean> {
    if (!userId?.trim() || !platform?.trim() || typeof chatRoomId !== 'string' || !chatRoomId.trim()) return false;
    if (access) this.assertRoomAccess({ currentRoomId: access.currentRoomId, requestedRoomId: chatRoomId, isOwner: access.isOwner, roomVerified: access.roomVerified, requireOwner: access.requireOwner });
    const normalizedType = normalizeServiceType(serviceType);
    const { db, notificationSubscriptions } = this.deps;
    const existing = await db.select({ id: notificationSubscriptions.id }).from(notificationSubscriptions).where(and(
      eq(notificationSubscriptions.userId, userId),
      eq(notificationSubscriptions.platform, platform),
      eq(notificationSubscriptions.serviceType, normalizedType),
      eq(notificationSubscriptions.chatRoomId, chatRoomId),
    )).limit(1);
    if (existing.length === 0) return false;
    await db.delete(notificationSubscriptions).where(eq(notificationSubscriptions.id, existing[0].id));
    return true;
  }

  static async getSubscriptions(userId: string, platform: string, serviceType?: string, eventType?: string) {
    const { db, notificationSubscriptions } = this.deps;
    const conditions: SQL[] = [eq(notificationSubscriptions.userId, userId), eq(notificationSubscriptions.platform, platform)];
    if (serviceType) {
      const serviceCondition = or(eq(notificationSubscriptions.serviceType, normalizeServiceType(serviceType)), eq(notificationSubscriptions.serviceType, 'all'))!;
      conditions.push(serviceCondition);
    }
    const rows = await db.select().from(notificationSubscriptions).where(and(...conditions));
    return rows.filter((row) => matchesEvent(row.notifyTypes, eventType));
  }

  static async getSubscribersForService(serviceType: string, eventType?: string) {
    const normalized = normalizeServiceType(serviceType);
    const { db, notificationSubscriptions } = this.deps;
    const rows = await db.select().from(notificationSubscriptions).where(or(eq(notificationSubscriptions.serviceType, normalized), eq(notificationSubscriptions.serviceType, 'all')));
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (!matchesEvent(row.notifyTypes, eventType)) return false;
      const key = `${row.platform}:${row.userId}:${row.chatRoomId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  static async getNotificationRooms(userId: string, platform: string, serviceType: string, eventType?: string): Promise<{ chatRoomId: string; platform: string }[]> {
    const normalized = normalizeServiceType(serviceType);
    const { db, notificationSubscriptions } = this.deps;
    const rows = await db.select().from(notificationSubscriptions).where(and(
      eq(notificationSubscriptions.userId, userId),
      eq(notificationSubscriptions.platform, platform),
      or(eq(notificationSubscriptions.serviceType, normalized), eq(notificationSubscriptions.serviceType, 'all')),
    ));
    const seen = new Set<string>();
    return rows.filter((row) => matchesEvent(row.notifyTypes, eventType)).filter((row) => {
      if (seen.has(row.chatRoomId)) return false;
      seen.add(row.chatRoomId);
      return true;
    }).map((row) => ({ chatRoomId: row.chatRoomId, platform: row.platform }));
  }

  static async getAdminNotificationRooms(serviceType: string, eventType?: string): Promise<{ chatRoomId: string; platform: string; userId: string }[]> {
    const adminBindings = await ServiceBindingService.getAdminBindings(normalizeServiceType(serviceType));
    const roomGroups = await Promise.all(adminBindings.map(async (binding) => ({ userId: binding.userId, rooms: await this.getNotificationRooms(binding.userId, binding.platform, serviceType, eventType) })));
    const rooms: { chatRoomId: string; platform: string; userId: string }[] = [];
    const seen = new Set<string>();
    for (const group of roomGroups) {
      for (const room of group.rooms) {
        const key = `${room.platform}:${room.chatRoomId}`;
        if (!seen.has(key)) {
          seen.add(key);
          rooms.push({ ...room, userId: group.userId });
        }
      }
    }
    return rooms;
  }
}
