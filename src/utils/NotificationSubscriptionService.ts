import { db } from '../db';
import { notificationSubscriptions } from '../db/schema';
import { eq, and, or, type SQL } from 'drizzle-orm';
import { logger } from './logger';
import { ServiceBindingService } from './ServiceBindingService';
import {
  isRoomKeyFor,
  isSameRoom,
  normalizeRoomId,
  roomIdentityCondition,
  roomKeyBackfill,
  subscriptionRoomColumns,
  subscriptionRoomKeyInsertValues,
  toRoomKey,
  type RoomColumns,
} from '../agent/roomKey';

const log = logger.child({ module: 'NotificationSubscriptionService' });

type SubDeps = {
  db: typeof import('../db').db;
  notificationSubscriptions: typeof import('../db/schema').notificationSubscriptions;
};

export type NotificationServiceType = 'all' | 'jellyfin' | 'seerr' | (string & {});

/** A notification destination: canonical room key plus the raw provider room id. */
export interface NotificationRoomRef {
  /** Raw provider room id — the only value a provider may be asked to send to. */
  chatRoomId: string;
  /** Canonical `room:<platform>:<chatRoomId>` key. */
  roomKey: string;
  platform: string;
}

/**
 * Resolve a caller supplied room reference (raw id or canonical key) into both
 * forms. A reference that belongs to another platform is passed through as the
 * room id so authorization can reject it instead of silently retargeting.
 */
function normalizeRoomRef(platform: string, room: string): NotificationRoomRef {
  const remoteRoomId = normalizeRoomId(platform, room);
  const roomKey = isRoomKeyFor(room, platform) ? room : toRoomKey(platform, remoteRoomId);
  return { chatRoomId: remoteRoomId, roomKey, platform };
}

/** Columns addressing a subscription row, with the canonical column if present. */
function subRoomColumns(table: unknown): RoomColumns {
  return subscriptionRoomColumns(table);
}

function subIdentity(ref: NotificationRoomRef) {
  return { platform: ref.platform, roomKey: ref.roomKey, roomId: ref.chatRoomId };
}

/** Canonical key of a stored subscription row, derived when the column is empty. */
function subscriptionRoomKey(row: { platform: string; chatRoomId: string; roomKey?: string | null }): string {
  const stored = typeof row.roomKey === 'string' ? row.roomKey.trim() : '';
  return stored.length > 0 ? stored : toRoomKey(row.platform, row.chatRoomId);
}

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
    currentRoomKey?: string;
    requestedRoomId: string;
    /** Canonical key of the requested room; derived from `requestedRoomId` when omitted. */
    requestedRoomKey?: string;
    /** Platform of both references; required to compare a key with a raw id. */
    platform?: string;
    isOwner?: boolean;
    roomVerified?: boolean;
    requireOwner?: boolean;
  }): void {
    if (typeof opts.requestedRoomId !== 'string' || !opts.requestedRoomId.trim()) throw new Error('A notification room is required.');
    // Current-room comparison uses both forms: a canonical key and a raw provider
    // chat id must resolve to the same room, while a key for another platform
    // never matches.
    const isCurrentRoom = (): boolean => {
      if (opts.currentRoomId === undefined) return false;
      if (opts.requestedRoomId === opts.currentRoomId) return true;
      if (typeof opts.platform !== 'string' || !opts.platform) return false;
      return isSameRoom(
        opts.platform,
        opts.currentRoomKey ?? opts.currentRoomId,
        opts.requestedRoomKey ?? opts.requestedRoomId,
      );
    };
    const foreign = opts.currentRoomId !== undefined && !isCurrentRoom();
    if (foreign && !opts.isOwner) {
      throw new Error('Foreign notification rooms require owner permission.');
    }
    if (foreign && opts.roomVerified !== true) {
      throw new Error('Foreign notification rooms require verified platform membership.');
    }
    if (opts.requireOwner && !opts.isOwner) throw new Error('Owner permission is required.');
  }

  static async subscribe(opts: {
    userId: string;
    platform: string;
    serviceType: string;
    chatRoomId: string;
    /** Canonical room key; derived from `chatRoomId` when omitted. */
    roomKey?: string;
    notifyTypes?: string[] | string | null;
    currentRoomId?: string;
    currentRoomKey?: string;
    isOwner?: boolean;
    roomVerified?: boolean;
    requireOwner?: boolean;
  }): Promise<void> {
    if (typeof opts.userId !== 'string' || typeof opts.platform !== 'string' || !opts.userId.trim() || !opts.platform.trim()) throw new Error('A user and platform are required.');
    this.assertRoomAccess({
      currentRoomId: opts.currentRoomId,
      currentRoomKey: opts.currentRoomKey,
      requestedRoomId: opts.chatRoomId,
      requestedRoomKey: opts.roomKey,
      platform: opts.platform,
      isOwner: opts.isOwner,
      roomVerified: opts.roomVerified,
      requireOwner: opts.requireOwner,
    });
    const serviceType = normalizeServiceType(opts.serviceType);
    const { db, notificationSubscriptions } = this.deps;
    // The canonical key is stored next to the legacy raw room id (kept for
    // rollback), and the existing-row lookup accepts either form.
    const roomRef = normalizeRoomRef(opts.platform, opts.roomKey ?? opts.chatRoomId);
    const roomColumns = subRoomColumns(notificationSubscriptions);
    const roomCondition = roomIdentityCondition(roomColumns, subIdentity(roomRef));
    const existing = await db.select().from(notificationSubscriptions).where(and(
      eq(notificationSubscriptions.userId, opts.userId),
      eq(notificationSubscriptions.platform, opts.platform),
      eq(notificationSubscriptions.serviceType, serviceType),
      roomCondition,
    )).limit(1);
    const normalizedTypes = normalizeNotifyTypes(opts.notifyTypes);
    const notifyTypesJson = normalizedTypes ? JSON.stringify(normalizedTypes) : null;
    if (existing.length > 0) {
      // Dual write: adopt the canonical key on a row the migration has not
      // backfilled yet so the next lookup resolves through room_key.
      const backfill = roomKeyBackfill(roomColumns.canonical, existing[0].roomKey, roomRef.roomKey);
      await db.update(notificationSubscriptions).set({ notifyTypes: notifyTypesJson, ...backfill }).where(eq(notificationSubscriptions.id, existing[0].id));
      log.info({ userId: opts.userId, chatRoomId: roomRef.chatRoomId, roomKey: roomRef.roomKey, serviceType }, 'Updated notification subscription');
    } else {
      await db.insert(notificationSubscriptions).values({
        userId: opts.userId,
        platform: opts.platform,
        serviceType,
        chatRoomId: roomRef.chatRoomId,
        ...subscriptionRoomKeyInsertValues(roomColumns.canonical, roomRef.roomKey),
        notifyTypes: notifyTypesJson,
        created_at: new Date(),
      });
      log.info({ userId: opts.userId, chatRoomId: roomRef.chatRoomId, roomKey: roomRef.roomKey, serviceType }, 'Created notification subscription');
    }
  }

  static async unsubscribe(userId: string, platform: string, serviceType: string, chatRoomId: string, access?: { currentRoomId?: string; currentRoomKey?: string; isOwner?: boolean; roomVerified?: boolean; requireOwner?: boolean }): Promise<boolean> {
    if (!userId?.trim() || !platform?.trim() || typeof chatRoomId !== 'string' || !chatRoomId.trim()) return false;
    if (access) this.assertRoomAccess({ currentRoomId: access.currentRoomId, currentRoomKey: access.currentRoomKey, requestedRoomId: chatRoomId, platform, isOwner: access.isOwner, roomVerified: access.roomVerified, requireOwner: access.requireOwner });
    const normalizedType = normalizeServiceType(serviceType);
    const { db, notificationSubscriptions } = this.deps;
    // Accept a raw room id or a canonical key; both reach the stored row.
    const roomRef = normalizeRoomRef(platform, chatRoomId);
    const existing = await db.select({ id: notificationSubscriptions.id }).from(notificationSubscriptions).where(and(
      eq(notificationSubscriptions.userId, userId),
      eq(notificationSubscriptions.platform, platform),
      eq(notificationSubscriptions.serviceType, normalizedType),
      roomIdentityCondition(subRoomColumns(notificationSubscriptions), subIdentity(roomRef)),
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
      // Dedupe on the canonical room key so a migrated row and a row still keyed
      // by the raw chat id collapse into one notification target.
      const key = `${row.platform}:${row.userId}:${subscriptionRoomKey(row)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  static async getNotificationRooms(userId: string, platform: string, serviceType: string, eventType?: string): Promise<NotificationRoomRef[]> {
    const normalized = normalizeServiceType(serviceType);
    const { db, notificationSubscriptions } = this.deps;
    const rows = await db.select().from(notificationSubscriptions).where(and(
      eq(notificationSubscriptions.userId, userId),
      eq(notificationSubscriptions.platform, platform),
      or(eq(notificationSubscriptions.serviceType, normalized), eq(notificationSubscriptions.serviceType, 'all')),
    ));
    const seen = new Set<string>();
    return rows.filter((row) => matchesEvent(row.notifyTypes, eventType)).filter((row) => {
      const key = subscriptionRoomKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
      // `chatRoomId` stays the raw provider room id because callers hand it
      // straight to a provider; the canonical key is exposed alongside it.
    }).map((row) => ({ chatRoomId: row.chatRoomId, roomKey: subscriptionRoomKey(row), platform: row.platform }));
  }

  static async getAdminNotificationRooms(serviceType: string, eventType?: string): Promise<Array<NotificationRoomRef & { userId: string }>> {
    const adminBindings = await ServiceBindingService.getAdminBindings(normalizeServiceType(serviceType));
    const roomGroups = await Promise.all(adminBindings.map(async (binding) => ({ userId: binding.userId, rooms: await this.getNotificationRooms(binding.userId, binding.platform, serviceType, eventType) })));
    const rooms: Array<NotificationRoomRef & { userId: string }> = [];
    const seen = new Set<string>();
    for (const group of roomGroups) {
      for (const room of group.rooms) {
        const key = `${room.platform}:${room.roomKey}`;
        if (!seen.has(key)) {
          seen.add(key);
          rooms.push({ ...room, userId: group.userId });
        }
      }
    }
    return rooms;
  }
}
