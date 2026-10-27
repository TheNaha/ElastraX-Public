import { logger } from '../utils/logger';
import { AuthService } from '../utils/AuthService';
import { IdentityService } from '../utils/IdentityService';

export async function seedOwnerRole(platform: string): Promise<void> {
  const ownerId = AuthService.resolveOwnerId(platform);
  if (!ownerId) return;
  try {
    await IdentityService.upsertIdentity(ownerId, ownerId, undefined, platform);
    await AuthService.setRole(ownerId, 'owner', 'global', platform, 'system:startup');
    logger.info({ ownerId, platform }, `[${platform}] Owner role seeded`);
  } catch (error) {
    logger.error({ err: error, ownerId, platform }, `[${platform}] Failed to seed owner role`);
  }
}