import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, type ElastraXDatabase } from '../db';
import {
  canonicalIdentities,
  identityAliases,
  userIdentities,
  userRoles,
} from '../db/schema';

type IdentityRow = typeof userIdentities.$inferSelect;
type LegacyIdentityRow = Pick<IdentityRow, 'lid' | 'pn' | 'displayName' | 'platform' | 'updated_at'>;
type CanonicalRow = typeof canonicalIdentities.$inferSelect;

export interface IdentityServiceDeps {
  db: ElastraXDatabase;
  userIdentities: typeof userIdentities;
  canonicalIdentities?: typeof canonicalIdentities;
  identityAliases?: typeof identityAliases;
  userRoles: typeof userRoles;
}

export interface IdentityInfo {
  canonicalId: string;
  pn: string | null;
  lid: string | null;
  displayName: string | null;
  platform: string;
}

let deps: IdentityServiceDeps = {
  db,
  userIdentities,
  canonicalIdentities,
  identityAliases,
  userRoles,
};

export function setDepsForTesting(overrides: Partial<IdentityServiceDeps> | null): void {
  if (overrides === null) {
    deps = { db, userIdentities, canonicalIdentities, identityAliases, userRoles };
    return;
  }
  const next = { ...deps, ...overrides };
  if (Object.prototype.hasOwnProperty.call(overrides, 'db')) {
    next.canonicalIdentities = overrides.canonicalIdentities;
    next.identityAliases = overrides.identityAliases;
  }
  deps = next;
}

const identityAliasLocks = new Map<string, Promise<void>>();

async function withIdentityAliasLocks<T>(
  platform: string,
  aliases: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(aliases.map(alias => `${platform}:${alias}`))].sort();
  const previous = keys.map(key => identityAliasLocks.get(key) ?? Promise.resolve());
  const start = Promise.all(previous).then(operation);
  const lock = start.then(() => {}, () => {});
  for (const key of keys) identityAliasLocks.set(key, lock);
  try {
    return await start;
  } finally {
    for (const key of keys) {
      if (identityAliasLocks.get(key) === lock) identityAliasLocks.delete(key);
    }
  }
}

function normalized(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function aliasKinds(lid: string | null, pn: string | null): Array<{ value: string; kind: string }> {
  return [
    ...(lid ? [{ value: lid, kind: 'lid' }] : []),
    ...(pn ? [{ value: pn, kind: 'pn' }] : []),
  ];
}

async function legacyRowFor(aliases: string[], platform: string): Promise<LegacyIdentityRow | undefined> {
  if (aliases.length === 0) return undefined;
  return (await deps.db.select({
    lid: deps.userIdentities.lid,
    pn: deps.userIdentities.pn,
    displayName: deps.userIdentities.displayName,
    platform: deps.userIdentities.platform,
    updated_at: deps.userIdentities.updated_at,
  }).from(deps.userIdentities).where(and(
    eq(deps.userIdentities.platform, platform),
    or(...aliases.map(alias => or(
      eq(deps.userIdentities.lid, alias),
      eq(deps.userIdentities.pn, alias),
    ))),
  )).limit(1))[0];
}

async function canonicalForAlias(alias: string, platform: string): Promise<CanonicalRow | undefined> {
  if (!deps.canonicalIdentities || !deps.identityAliases) return undefined;
  const aliasRow = (await deps.db.select().from(deps.identityAliases).where(and(
    eq(deps.identityAliases.platform, platform),
    eq(deps.identityAliases.alias, alias),
  )).limit(1))[0];
  if (!aliasRow) return undefined;
  return (await deps.db.select().from(deps.canonicalIdentities)
    .where(eq(deps.canonicalIdentities.id, aliasRow.canonicalId))
    .limit(1))[0];
}

export const IdentityService = {
  setDepsForTesting,
  upsert: (...args: [string | null | undefined, string | null | undefined, (string | null)?, (string)?]) =>
    IdentityService.upsertIdentity(args[0] ?? null, args[1] ?? null, args[2], args[3]),
  async getIdentity(jid: string): Promise<IdentityInfo | null> {
    const alias = normalized(jid);
    if (!alias) return null;
    if (deps.canonicalIdentities && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(alias)) {
      const canonical = (await deps.db.select().from(deps.canonicalIdentities)
        .where(eq(deps.canonicalIdentities.id, alias)).limit(1))[0];
      if (canonical && deps.identityAliases) {
        const aliases = await deps.db.select().from(deps.identityAliases)
          .where(eq(deps.identityAliases.canonicalId, canonical.id));
        return {
          canonicalId: canonical.id,
          lid: aliases.find(row => row.aliasKind === 'lid')?.alias ?? null,
          pn: aliases.find(row => row.aliasKind === 'pn' || row.aliasKind === 'phone')?.alias ?? null,
          displayName: canonical.displayName,
          platform: canonical.platform,
        };
      }
    }
    const platform = alias.endsWith('@lid') || alias.endsWith('@s.whatsapp.net') ? 'whatsapp' : 'discord';
    const canonical = await canonicalForAlias(alias, platform);
    if (canonical && deps.identityAliases) {
      const aliases = await deps.db.select().from(deps.identityAliases)
        .where(and(
          eq(deps.identityAliases.platform, platform),
          eq(deps.identityAliases.canonicalId, canonical.id),
        ));
      return {
        canonicalId: canonical.id,
        lid: aliases.find(row => row.aliasKind === 'lid')?.alias ?? null,
        pn: aliases.find(row => row.aliasKind === 'pn' || row.aliasKind === 'phone')?.alias ?? null,
        displayName: canonical.displayName,
        platform,
      };
    }
    const row = (await deps.db.select({
      lid: deps.userIdentities.lid,
      pn: deps.userIdentities.pn,
      displayName: deps.userIdentities.displayName,
      platform: deps.userIdentities.platform,
    }).from(deps.userIdentities).where(and(
      eq(deps.userIdentities.platform, platform),
      or(eq(deps.userIdentities.lid, alias), eq(deps.userIdentities.pn, alias)),
    )).limit(1))[0];
    if (!row) return null;
    return {
      canonicalId: row.pn ?? row.lid ?? alias,
      lid: row.lid,
      pn: row.pn,
      displayName: row.displayName,
      platform,
    };
  },

  async getCanonicalId(jid: string): Promise<string | null> {
    return (await this.getIdentity(jid))?.canonicalId ?? null;
  },

  async getAllJids(jid: string): Promise<string[]> {
    const identity = await this.getIdentity(jid);
    if (!identity) return jid ? [jid] : [];
    const jids = [identity.canonicalId, identity.lid, identity.pn].filter((value): value is string => Boolean(value));
    if (!deps.identityAliases || !identity.canonicalId) return [...new Set(jids)];
    const aliases = await deps.db.select({ alias: deps.identityAliases.alias })
      .from(deps.identityAliases)
      .where(eq(deps.identityAliases.canonicalId, identity.canonicalId));
    return [...new Set([...jids, ...aliases.map(row => row.alias)])].filter(Boolean);
  },

  async getJidsAndRoles(userId: string, chatId?: string, platform?: string): Promise<{ jids: string[]; roles: Array<{ scope: string; role: string }> }> {
    const jids = await this.getAllJids(userId);
    if (jids.length === 0) return { jids, roles: [] };
    const scopeCondition = chatId
      ? or(eq(deps.userRoles.scope, 'global'), eq(deps.userRoles.scope, chatId))
      : eq(deps.userRoles.scope, 'global');
    const rows = platform
      ? await deps.db.select({ scope: deps.userRoles.scope, role: deps.userRoles.role })
        .from(deps.userRoles)
        .where(and(inArray(deps.userRoles.userId, jids), eq(deps.userRoles.platform, platform), scopeCondition))
      : await deps.db.select({ scope: deps.userRoles.scope, role: deps.userRoles.role })
        .from(deps.userRoles)
        .where(and(inArray(deps.userRoles.userId, jids), scopeCondition));
    return { jids, roles: rows };
  },

  async getLidForPn(pn: string): Promise<string | undefined> {
    const identity = await this.getIdentity(pn);
    return identity?.lid ?? undefined;
  },

  async getPnForLid(lid: string): Promise<string | undefined> {
    const identity = await this.getIdentity(lid);
    return identity?.pn ?? undefined;
  },

  async upsertIdentity(lid: string | null, pn: string | null, displayName?: string | null, platform: string = 'whatsapp'): Promise<void> {
    const normalizedLid = normalized(lid);
    const normalizedPn = normalized(pn);
    if (!normalizedLid && !normalizedPn) return;
    const aliases = aliasKinds(normalizedLid, normalizedPn);
    return withIdentityAliasLocks(platform, aliases.map(alias => alias.value), async () => {
    const nowMs = Date.now();
    const now = new Date();

    if (deps.canonicalIdentities && deps.identityAliases) {
      const existingRows = await Promise.all(aliases.map(alias => canonicalForAlias(alias.value, platform)));
      const primaryRows = await deps.db.select().from(deps.canonicalIdentities).where(and(
        eq(deps.canonicalIdentities.platform, platform),
        inArray(deps.canonicalIdentities.primaryAlias, aliases.map(alias => alias.value)),
      ));
      const existing = [...primaryRows, ...existingRows].find((row: CanonicalRow | undefined): row is CanonicalRow => Boolean(row));
      const canonicalId = existing?.id ?? randomUUID();
      const primaryAlias = existing?.primaryAlias ?? aliases[0]!.value;

      await deps.db.transaction(transaction => {
        transaction.insert(deps.canonicalIdentities!).values({
          id: canonicalId,
          platform,
          primaryAlias,
          displayName: displayName ?? existing?.displayName ?? null,
          created_at: nowMs,
          updated_at: nowMs,
        }).onConflictDoUpdate({
          target: deps.canonicalIdentities!.id,
          set: { displayName: displayName ?? existing?.displayName ?? null, updated_at: nowMs },
        }).run();

        for (const alias of aliases) {
          transaction.insert(deps.identityAliases!).values({
            canonicalId,
            platform,
            alias: alias.value,
            aliasKind: alias.kind,
            metadata: null,
            firstSeenAt: nowMs,
            lastSeenAt: nowMs,
          }).onConflictDoUpdate({
            target: [deps.identityAliases!.platform, deps.identityAliases!.alias],
            set: { canonicalId, lastSeenAt: nowMs },
          }).run();
        }
      });

      const legacy = await legacyRowFor(aliases.map(alias => alias.value), platform);
      if (!legacy) {
        await deps.db.insert(deps.userIdentities).values({
          canonicalId,
          lid: normalizedLid,
          pn: normalizedPn,
          platform,
          displayName: displayName ?? null,
          updated_at: now,
        }).onConflictDoNothing().run();
      }
      return;
    }

    const lidRows = normalizedLid
      ? await deps.db.select({
          lid: deps.userIdentities.lid,
          pn: deps.userIdentities.pn,
          displayName: deps.userIdentities.displayName,
          platform: deps.userIdentities.platform,
          updated_at: deps.userIdentities.updated_at,
        }).from(deps.userIdentities).where(eq(deps.userIdentities.lid, normalizedLid))
      : [];
    const pnRows = normalizedPn
      ? await deps.db.select({
          lid: deps.userIdentities.lid,
          pn: deps.userIdentities.pn,
          displayName: deps.userIdentities.displayName,
          platform: deps.userIdentities.platform,
          updated_at: deps.userIdentities.updated_at,
        }).from(deps.userIdentities).where(eq(deps.userIdentities.pn, normalizedPn))
      : [];
    const row = lidRows[0] ?? pnRows[0];
    if (!row) {
      await deps.db.insert(deps.userIdentities).values({
        lid: normalizedLid,
        pn: normalizedPn,
        displayName: displayName ?? null,
        platform,
        updated_at: now,
      }).run();
      return;
    }
    const staleIds = [...lidRows, ...pnRows]
      .filter(candidate => candidate.updated_at < row.updated_at)
      .map(candidate => candidate.updated_at.getTime());
    for (const stale of staleIds) {
      await deps.db.delete(deps.userIdentities).where(and(
        eq(deps.userIdentities.platform, platform),
        eq(deps.userIdentities.updated_at, new Date(stale)),
      )).run();
    }
    await deps.db.update(deps.userIdentities)
      .set({
        lid: normalizedLid ?? row.lid,
        pn: normalizedPn ?? row.pn,
        displayName: displayName ?? row.displayName,
        updated_at: now,
      })
      .where(and(
        eq(deps.userIdentities.platform, platform),
        or(
          ...(row.lid ? [eq(deps.userIdentities.lid, row.lid)] : []),
          ...(row.pn ? [eq(deps.userIdentities.pn, row.pn)] : []),
        ),
      ))
      .run();
    });
  },

  async setDisplayName(jid: string, displayName: string): Promise<void> {
    const identity = await this.getIdentity(jid);
    if (!identity) return;
    const now = new Date();
    const nowMs = now.getTime();
    if (deps.canonicalIdentities) {
      await deps.db.update(deps.canonicalIdentities)
        .set({ displayName, updated_at: nowMs })
        .where(eq(deps.canonicalIdentities.id, identity.canonicalId))
        .run();
    }
    const jids = await this.getAllJids(jid);
    await deps.db.update(deps.userIdentities)
      .set({ displayName, updated_at: now })
      .where(and(
        eq(deps.userIdentities.platform, jid.endsWith('@lid') || jid.endsWith('@s.whatsapp.net') ? 'whatsapp' : 'discord'),
        or(...jids.map(value => or(eq(deps.userIdentities.lid, value), eq(deps.userIdentities.pn, value)))),
      )).run();
  },

  async clearUserIdentities(userId: string): Promise<void> {
    const identity = await this.getIdentity(userId);
    if (identity && deps.identityAliases) {
      await deps.db.delete(deps.identityAliases).where(eq(deps.identityAliases.canonicalId, identity.canonicalId)).run();
    }
    await deps.db.delete(deps.userIdentities).where(or(
      eq(deps.userIdentities.lid, userId),
      eq(deps.userIdentities.pn, userId),
    )).run();
  },
};
