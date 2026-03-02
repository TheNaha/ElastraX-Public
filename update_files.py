import re

with open('src/providers/whatsapp.ts', 'r') as f:
    content = f.read()

# Replace the role setting part
search = """            // Seed owner role in DB (global scope) — uses the PN JID as the
            // canonical userId since that's what BOT_OWNER_JID is.
            // Also seed with LID if we have it, so both JIDs are covered.
            await RoleService.setRole(ownerJid, 'owner', 'global', 'whatsapp', 'system:startup');
            if (ownerLid && ownerLid !== ownerJid) {
              await RoleService.setRole(ownerLid, 'owner', 'global', 'whatsapp', 'system:startup');
            }"""

replace = """            // Seed owner role in DB (global scope) — prefer LID for consistency
            // if available, otherwise fallback to the PN JID.
            const primaryId = ownerLid && ownerLid !== ownerJid ? ownerLid : ownerJid;
            await RoleService.setRole(primaryId, 'owner', 'global', 'whatsapp', 'system:startup');"""

content = content.replace(search, replace)

with open('src/providers/whatsapp.ts', 'w') as f:
    f.write(content)

with open('src/tools/RoleTool.ts', 'r') as f:
    content = f.read()

# Replace grant logic
grant_search = """      const targetId = resolved.jid;

      const callerRoles = await ctx.resolveRoles();"""

grant_replace = """      const resolvedTarget = resolved.jid;

      const identity = await IdentityService.getIdentity(resolvedTarget);
      const targetId = identity?.lid ? identity.lid : resolvedTarget;

      const callerRoles = await ctx.resolveRoles();"""

content = content.replace(grant_search, grant_replace)

# Replace revoke logic
revoke_search = """      const targetId = resolved.jid;

      const revokeRole = role; // which specific role to revoke"""

revoke_replace = """      const resolvedTarget = resolved.jid;

      const identity = await IdentityService.getIdentity(resolvedTarget);
      const targetId = identity?.lid ? identity.lid : resolvedTarget;

      const revokeRole = role; // which specific role to revoke"""

content = content.replace(revoke_search, revoke_replace)

with open('src/tools/RoleTool.ts', 'w') as f:
    f.write(content)
