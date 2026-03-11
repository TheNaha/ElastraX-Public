/**
 * @file src/utils/ServiceBindingService.ts
 * @description CRUD for external service account bindings (Jellyfin, Seerr, etc.).
 */

import { db } from '../db';
import { serviceBindings } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from './logger';

const log = logger.child({ module: 'ServiceBindingService' });

type BindingDeps = {
  db: typeof import('../db').db;
  serviceBindings: typeof import('../db/schema').serviceBindings;
};

export class ServiceBindingService {
  private static deps: BindingDeps = { db, serviceBindings };

  static setDepsForTesting(deps: BindingDeps | null): void {
    this.deps = deps ?? { db, serviceBindings };
  }

  /** Create or update a service binding. */
  static async bind(opts: {
    userId: string;
    platform: string;
    serviceType: string;
    externalUserId: string;
    externalUsername: string;
    externalEmail?: string | null;
    metadata?: string | null;
  }): Promise<void> {
    const { db, serviceBindings } = this.deps;
    const existing = await this.getBinding(opts.userId, opts.platform, opts.serviceType);

    if (existing) {
      await db
        .update(serviceBindings)
        .set({
          externalUserId: opts.externalUserId,
          externalUsername: opts.externalUsername,
          externalEmail: opts.externalEmail ?? null,
          metadata: opts.metadata ?? existing.metadata,
        })
        .where(eq(serviceBindings.id, existing.id));
      log.info({ userId: opts.userId, serviceType: opts.serviceType }, 'Updated service binding');
    } else {
      await db.insert(serviceBindings).values({
        userId: opts.userId,
        platform: opts.platform,
        serviceType: opts.serviceType,
        externalUserId: opts.externalUserId,
        externalUsername: opts.externalUsername,
        externalEmail: opts.externalEmail ?? null,
        metadata: opts.metadata ?? null,
        created_at: new Date(),
      });
      log.info({ userId: opts.userId, serviceType: opts.serviceType }, 'Created service binding');
    }
  }

  /** Remove a service binding. */
  static async unbind(userId: string, platform: string, serviceType: string): Promise<boolean> {
    const { db, serviceBindings } = this.deps;
    const existing = await this.getBinding(userId, platform, serviceType);
    if (!existing) return false;
    await db
      .delete(serviceBindings)
      .where(eq(serviceBindings.id, existing.id));
    return true;
  }

  /** Get a single binding for a user + service. */
  static async getBinding(userId: string, platform: string, serviceType: string) {
    const { db, serviceBindings } = this.deps;
    const rows = await db
      .select()
      .from(serviceBindings)
      .where(
        and(
          eq(serviceBindings.userId, userId),
          eq(serviceBindings.platform, platform),
          eq(serviceBindings.serviceType, serviceType),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Get all bindings for a user across all services. */
  static async getBindings(userId: string, platform: string) {
    const { db, serviceBindings } = this.deps;
    return db
      .select()
      .from(serviceBindings)
      .where(
        and(
          eq(serviceBindings.userId, userId),
          eq(serviceBindings.platform, platform),
        ),
      );
  }

  /** Reverse lookup: find bot user(s) by external service user ID. */
  static async findByExternalUser(serviceType: string, externalUserId: string) {
    const { db, serviceBindings } = this.deps;
    return db
      .select()
      .from(serviceBindings)
      .where(
        and(
          eq(serviceBindings.serviceType, serviceType),
          eq(serviceBindings.externalUserId, externalUserId),
        ),
      );
  }

  /** Reverse lookup: find bot user(s) by external email. */
  static async findByExternalEmail(serviceType: string, email: string) {
    const { db, serviceBindings } = this.deps;
    return db
      .select()
      .from(serviceBindings)
      .where(
        and(
          eq(serviceBindings.serviceType, serviceType),
          eq(serviceBindings.externalEmail, email),
        ),
      );
  }

  /** Reverse lookup: find bot user(s) by external username. */
  static async findByExternalUsername(serviceType: string, username: string) {
    const { db, serviceBindings } = this.deps;
    return db
      .select()
      .from(serviceBindings)
      .where(
        and(
          eq(serviceBindings.serviceType, serviceType),
          eq(serviceBindings.externalUsername, username),
        ),
      );
  }

  /** Get all bindings for a service type that have isAdmin=true in metadata. */
  static async getAdminBindings(serviceType: string) {
    const { db, serviceBindings } = this.deps;
    const all = await db
      .select()
      .from(serviceBindings)
      .where(eq(serviceBindings.serviceType, serviceType));

    return all.filter((binding) => {
      if (!binding.metadata) return false;
      try {
        const meta = JSON.parse(binding.metadata);
        return meta.isAdmin === true;
      } catch {
        return false;
      }
    });
  }

  /** Update the metadata JSON for a binding. */
  static async updateMetadata(userId: string, platform: string, serviceType: string, metadata: string): Promise<boolean> {
    const { db, serviceBindings } = this.deps;
    const existing = await this.getBinding(userId, platform, serviceType);
    if (!existing) return false;
    await db
      .update(serviceBindings)
      .set({ metadata })
      .where(eq(serviceBindings.id, existing.id));
    return true;
  }
}
