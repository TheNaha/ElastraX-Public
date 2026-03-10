/**
 * @file src/utils/IdentityService.ts
 * @description Persistent LID <-> PN identity mapping for Baileys V7.
 */

import { db } from '../db';
import { userIdentities } from '../db/schema';
import { eq, or, sql } from 'drizzle-orm';
import { logger } from './logger';

type IdentityRow = {
  rowId: number;
  lid: string | null;
  pn: string | null;
  displayName: string | null;
};

type IdentityDeps = {
  db: typeof import('../db').db;
  userIdentities: typeof import('../db/schema').userIdentities;
};

function buildRowIdFilter(rowIds: number[]) {
  return sql`rowid in (${sql.join(rowIds.map((rowId) => sql`${rowId}`), sql`, `)})`;
}

export class IdentityService {
  private static deps: IdentityDeps = { db, userIdentities };

  static setDepsForTesting(deps: IdentityDeps | null): void {
    this.deps = deps ?? { db, userIdentities };
  }

  private static async findMatchingRows(lid?: string, pn?: string): Promise<IdentityRow[]> {
    const { db, userIdentities } = this.deps;
    const conditions = [];
    if (lid) conditions.push(eq(userIdentities.lid, lid));
    if (pn) conditions.push(eq(userIdentities.pn, pn));
    if (conditions.length === 0) return [];

    return db
      .select({
        rowId: sql<number>`rowid`.as('rowId'),
        lid: userIdentities.lid,
        pn: userIdentities.pn,
        displayName: userIdentities.displayName,
      })
      .from(userIdentities)
      .where(conditions.length === 1 ? conditions[0] : or(...conditions));
  }

  static async upsert(
    lid: string | undefined,
    pn: string | undefined,
    displayName?: string,
    platform: string = 'whatsapp',
  ): Promise<void> {
    if (!lid && !pn) return;

    try {
      const { db, userIdentities } = this.deps;
      const existing = await this.findMatchingRows(lid, pn);

      if (existing.length > 0) {
        const canonical = existing.find((row) => row.lid && row.pn) ?? existing[0];
        const mergedLid = lid ?? existing.find((row) => row.lid)?.lid ?? null;
        const mergedPn = pn ?? existing.find((row) => row.pn)?.pn ?? null;
        const mergedDisplayName = displayName ?? existing.find((row) => row.displayName)?.displayName ?? null;
        const duplicateRowIds = existing
          .filter((row) => row.rowId !== canonical.rowId)
          .map((row) => row.rowId);

        if (duplicateRowIds.length > 0) {
          await db.delete(userIdentities).where(buildRowIdFilter(duplicateRowIds));
        }

        await db
          .update(userIdentities)
          .set({
            lid: mergedLid,
            pn: mergedPn,
            displayName: mergedDisplayName,
            updated_at: new Date(),
          })
          .where(sql`rowid = ${canonical.rowId}`);

        logger.debug(
          {
            lid: mergedLid,
            pn: mergedPn,
            displayName: mergedDisplayName,
            mergedDuplicates: duplicateRowIds.length,
          },
          '[IdentityService] Updated existing identity',
        );
      } else {
        await db.insert(userIdentities).values({
          lid: lid ?? null,
          pn: pn ?? null,
          platform,
          displayName: displayName ?? null,
          updated_at: new Date(),
        });

        logger.info({ lid, pn, displayName }, '[IdentityService] Stored new identity mapping');
      }
    } catch (err) {
      logger.error({ err, lid, pn }, '[IdentityService] Failed to upsert identity');
    }
  }

  static async getAllJids(jid: string): Promise<string[]> {
    if (!jid) return [];

    try {
      const { db, userIdentities } = this.deps;
      const isLid = jid.includes('@lid');
      const condition = isLid ? eq(userIdentities.lid, jid) : eq(userIdentities.pn, jid);

      const rows = await db
        .select({ lid: userIdentities.lid, pn: userIdentities.pn })
        .from(userIdentities)
        .where(condition)
        .limit(1);

      if (rows.length === 0) return [jid];

      const result = new Set<string>();
      if (rows[0].lid) result.add(rows[0].lid);
      if (rows[0].pn) result.add(rows[0].pn);
      result.add(jid);

      return Array.from(result);
    } catch (err) {
      logger.error({ err, jid }, '[IdentityService] Failed to look up identity');
      return [jid];
    }
  }

  static async getPnForLid(lid: string): Promise<string | undefined> {
    try {
      const { db, userIdentities } = this.deps;
      const rows = await db
        .select({ pn: userIdentities.pn })
        .from(userIdentities)
        .where(eq(userIdentities.lid, lid))
        .limit(1);

      return rows[0]?.pn ?? undefined;
    } catch (err) {
      logger.error({ err, lid }, '[IdentityService] Failed to get PN for LID');
      return undefined;
    }
  }

  static async getLidForPn(pn: string): Promise<string | undefined> {
    try {
      const { db, userIdentities } = this.deps;
      const rows = await db
        .select({ lid: userIdentities.lid })
        .from(userIdentities)
        .where(eq(userIdentities.pn, pn))
        .limit(1);

      return rows[0]?.lid ?? undefined;
    } catch (err) {
      logger.error({ err, pn }, '[IdentityService] Failed to get LID for PN');
      return undefined;
    }
  }

  static async getIdentity(jid: string): Promise<{
    lid: string | null;
    pn: string | null;
    displayName: string | null;
    platform: string;
  } | null> {
    try {
      const { db, userIdentities } = this.deps;
      const isLid = jid.includes('@lid');
      const condition = isLid ? eq(userIdentities.lid, jid) : eq(userIdentities.pn, jid);

      const rows = await db.select().from(userIdentities).where(condition).limit(1);

      if (rows.length === 0) return null;
      return {
        lid: rows[0].lid,
        pn: rows[0].pn,
        displayName: rows[0].displayName,
        platform: rows[0].platform,
      };
    } catch (err) {
      logger.error({ err, jid }, '[IdentityService] Failed to get identity');
      return null;
    }
  }
}
