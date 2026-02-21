import { logger } from './logger';

export interface FlowSession {
  flow: string;
  step: string;
  data: Record<string, any>;
  expiresAt: number;
}

export interface UserSession {
  activeFlow: string | null;
  flows: Record<string, FlowSession>;
}

export class SessionManager {
  // In-memory session store (PlatformId -> UserSession)
  private static sessions = new Map<string, UserSession>();

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
