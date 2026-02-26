/**
 * @file src/utils/SessionManager.ts
 * @description In-memory session store for multi-step interactive flows.
 *
 * When a tool needs to collect information across several user messages (a "wizard"),
 * it uses `SessionManager` to persist step data between message events.  The agent's
 * `FlowHandler` checks for an active session before routing messages to the LLM.
 *
 * Session keying:
 *  Sessions are keyed by `"${platform}:${userId}"` to prevent cross-platform
 *  collisions when the same user interacts via both WhatsApp and Discord.
 *
 * Expiry:
 *  Each flow has a configurable TTL (default 300 seconds / 5 minutes).  Expired
 *  flows are pruned lazily when `get()` is called — no background timer is needed.
 *
 * Limitations:
 *  - In-memory only; sessions do not survive a process restart.
 *  - Not shared across multiple bot instances.  A Redis-backed implementation
 *    would be needed for horizontal scaling.
 */

import { logger } from './logger';

/** State data for a single interactive flow step. */
export interface FlowSession {
  flow: string;
  step: string;
  data: Record<string, any>;
  expiresAt: number;
}

/** Top-level session container for a single user, holding all of their active flows. */
export interface UserSession {
  activeFlow: string | null;
  flows: Record<string, FlowSession>;
}

/** Static in-memory session store. One entry per platform+userId combination. */
export class SessionManager {
  // In-memory session store: composite key "platform:userId" → UserSession
  private static sessions = new Map<string, UserSession>();

  /**
   * Create or update a flow session for the given user.
   *
   * @param userId     - Unique user JID / Discord user ID.
   * @param flowId     - Logical name of the flow (e.g., `'my_wizard'`).
   * @param flowData   - Flow step, data payload (without `expiresAt` — added automatically).
   * @param platform   - Platform identifier (`'whatsapp'` | `'discord'`). Defaults to `'whatsapp'`.
   * @param ttlSeconds - How long the session remains valid. Defaults to 300 seconds.
   */
  static set(userId: string, flowId: string, flowData: Omit<FlowSession, 'expiresAt'>, platform: string = 'whatsapp', ttlSeconds: number = 300) {
    const key = `${platform}:${userId}`;
    
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { activeFlow: null, flows: {} });
    }

    const session = this.sessions.get(key)!;
    
    session.flows[flowId] = {
      ...flowData,
      expiresAt: Date.now() + (ttlSeconds * 1000)
    };
    session.activeFlow = flowId;
    
    logger.debug({ userId, flowId }, '[SessionManager] Flow updated');
  }

  /**
   * Retrieve the session for a user, pruning any expired flows in the process.
   *
   * @param userId   - Unique user JID / Discord user ID.
   * @param platform - Platform identifier. Defaults to `'whatsapp'`.
   * @returns        The `UserSession` if it exists and has non-expired flows, otherwise `null`.
   */
  static get(userId: string, platform: string = 'whatsapp'): UserSession | null {
    const key = `${platform}:${userId}`;
    const session = this.sessions.get(key);
    
    if (!session) return null;

    // Cleanup expired flows
    let hasExpired = false;
    for (const [flowId, flow] of Object.entries(session.flows)) {
      if (Date.now() > flow.expiresAt) {
        delete session.flows[flowId];
        if (session.activeFlow === flowId) {
          session.activeFlow = null;
        }
        hasExpired = true;
      }
    }

    if (hasExpired && Object.keys(session.flows).length === 0) {
      this.sessions.delete(key);
      return null;
    }

    return session;
  }

  /**
   * Remove a specific flow from the user's session.
   * If no flows remain the entire session entry is deleted.
   * The `activeFlow` pointer is updated to the most recently added remaining flow,
   * or set to `null` if no flows are left.
   *
   * @param userId   - Unique user JID / Discord user ID.
   * @param flowId   - The flow to remove.
   * @param platform - Platform identifier. Defaults to `'whatsapp'`.
   */
  static clear(userId: string, flowId: string, platform: string = 'whatsapp') {
    const key = `${platform}:${userId}`;
    const session = this.sessions.get(key);
    
    if (session && session.flows[flowId]) {
      delete session.flows[flowId];
      if (session.activeFlow === flowId) {
         const remainingFlows = Object.keys(session.flows);
         session.activeFlow = remainingFlows.length > 0 ? remainingFlows[remainingFlows.length - 1] : null;
      }
      
      if (Object.keys(session.flows).length === 0) {
        this.sessions.delete(key);
      }
      logger.debug({ userId, flowId }, '[SessionManager] Flow cleared');
    }
  }
}
