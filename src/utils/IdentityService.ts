/**
 * @file src/utils/IdentityService.ts
 * @description Persistent LID ↔ PN identity mapping for Baileys V7.
 *
 * Baileys V7 uses "LID" JIDs (Linked IDs) as the primary identifier for
 * WhatsApp users.  Phone-number JIDs (`@s.whatsapp.net`) are a secondary
 * fallback and are NOT always available — especially in group contexts.
 *
 * This service maintains a `user_identities` table that maps LID ↔ PN so
 * that:
 *  - `RoleService` can look up all JIDs for a user when checking DB roles.
 *  - `/role check` can display the correct identity regardless of JID format.
 *  - `BOT_OWNER_JID` (a PN) can be matched against a LID-based senderId.
 *
 * The mapping is populated:
 *  - On every incoming message (upsert with latest pushName).
 *  - At startup for the bot owner (seeded from `BOT_OWNER_JID` env var).
 */

import { db } from '../db';
import { userIdentities } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import { logger } from './logger';

export class IdentityService {
  // ── Upsert ──────────────────────────────────────────────────────────────

  /**
   * Store or update the LID ↔ PN mapping for a user.
   *
   * Called on every incoming message (cheap upsert).  If only one of lid/pn
   * is known the other column stays NULL until a future message fills it in.
   *
   * @param lid         LID JID (`xxx@lid`) — may be undefined.
   * @param pn          Phone-number JID (`xxx@s.whatsapp.net`) — may be undefined.
   * @param displayName Latest pushName for logging/display.
   * @param platform    Always `'whatsapp'` for now.
   */
  static async upsert(
    lid: string | undefined,
    pn: string | undefined,
    displayName?: string,
    platform: string = 'whatsapp',
  ): Promise<void> {
    if (!lid && !pn) return; // nothing to store

    try {
      // Try to find an existing row by either lid or pn.
      const conditions = [];
      if (lid) conditions.push(eq(userIdentities.lid, lid));
      if (pn) conditions.push(eq(userIdentities.pn, pn));

      const existing = await db
        .select()
        .from(userIdentities)
        .where(conditions.length === 1 ? conditions[0] : or(...conditions))
        .limit(1);

      if (existing.length > 0) {
        // Merge: fill in any missing columns, update displayName + timestamp.
        const row = existing[0];
        const updates: Record<string, any> = { updated_at: new Date() };
        if (lid && !row.lid) updates.lid = lid;
        if (pn && !row.pn) updates.pn = pn;
        if (displayName) updates.display_name = displayName;

        // Build a condition that matches the existing row
        const matchCondition = row.lid
          ? eq(userIdentities.lid, row.lid)
          : eq(userIdentities.pn, row.pn!);

        await db.update(userIdentities).set(updates).where(matchCondition);

        logger.debug(
          { lid: lid ?? row.lid, pn: pn ?? row.pn, displayName },
          '[IdentityService] Updated existing identity',
        );
      } else {
        // Insert new row.
        await db.insert(userIdentities).values({
          lid: lid ?? null,
          pn: pn ?? null,
          platform,
          displayName: displayName ?? null,
          updated_at: new Date(),
        });

        logger.info(
          { lid, pn, displayName },
          '[IdentityService] Stored new identity mapping',
        );
      }
    } catch (err) {
      logger.error({ err, lid, pn }, '[IdentityService] Failed to upsert identity');
    }
  }

  // ── Query ───────────────────────────────────────────────────────────────

  /**
   * Given any single JID (LID or PN), return ALL known JIDs for that user.
   *
   * @returns Array of unique JID strings (may contain 1 or 2 entries).
   *          Returns `[jid]` if no mapping is found (passthrough).
   */
  static async getAllJids(jid: string): Promise<string[]> {
    if (!jid) return [];

    try {
      const isLid = jid.includes('@lid');
      const condition = isLid
        ? eq(userIdentities.lid, jid)
        : eq(userIdentities.pn, jid);

      const rows = await db
        .select({ lid: userIdentities.lid, pn: userIdentities.pn })
        .from(userIdentities)
        .where(condition)
        .limit(1);

      if (rows.length === 0) return [jid];

      const result = new Set<string>();
      if (rows[0].lid) result.add(rows[0].lid);
      if (rows[0].pn) result.add(rows[0].pn);
      // Always include the original JID in case it matches neither column exactly
      result.add(jid);

      return Array.from(result);
    } catch (err) {
      logger.error({ err, jid }, '[IdentityService] Failed to look up identity');
      return [jid];
    }
  }

  /**
   * Get the PN (phone-number JID) for a given LID, or undefined.
   */
  static async getPnForLid(lid: string): Promise<string | undefined> {
    try {
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

  /**
   * Get the LID for a given phone-number JID, or undefined.
   */
  static async getLidForPn(pn: string): Promise<string | undefined> {
    try {
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

  /**
   * Get the full identity record for a user by any JID.
   */
  static async getIdentity(jid: string): Promise<{
    lid: string | null;
    pn: string | null;
    displayName: string | null;
    platform: string;
  } | null> {
    try {
      const isLid = jid.includes('@lid');
      const condition = isLid
        ? eq(userIdentities.lid, jid)
        : eq(userIdentities.pn, jid);

      const rows = await db
        .select()
        .from(userIdentities)
        .where(condition)
        .limit(1);

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
