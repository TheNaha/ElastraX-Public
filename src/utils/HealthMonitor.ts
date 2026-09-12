import { logger } from './logger';
import { healthMetrics } from './HealthMetrics';
import { getErrorMessage } from './errorUtils';
import { resolveLLMTargets } from '../config/llm';

const log = logger.child({ module: 'HealthMonitor' });

const PING_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;

export class HealthMonitor {
  private timers: ReturnType<typeof setInterval>[] = [];

  start() {
    log.info('Starting HealthMonitor...');

    // Ping Jellyfin
    const jellyfinUrl = process.env.JELLYFIN_API_URL || process.env.JELLYFIN_URL;
    if (jellyfinUrl) {
      this.timers.push(setInterval(() => void this.pingJellyfin(jellyfinUrl), PING_INTERVAL_MS));
      void this.pingJellyfin(jellyfinUrl);
    }

    // Ping Seerr
    const seerrUrl = process.env.SEERR_API_URL || process.env.SEERR_URL;
    if (seerrUrl) {
      this.timers.push(setInterval(() => void this.pingSeerr(seerrUrl), PING_INTERVAL_MS));
      void this.pingSeerr(seerrUrl);
    }

    // Ping every configured LLM provider
    for (const target of resolveLLMTargets()) {
      this.timers.push(setInterval(() => void this.pingLLM(target), PING_INTERVAL_MS));
      void this.pingLLM(target);
    }
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    log.info('HealthMonitor stopped.');
  }

  private async pingJellyfin(baseUrl: string) {
    try {
      const res = await fetch(`${baseUrl}/System/Info/Public`, {
        signal: AbortSignal.timeout(PING_TIMEOUT_MS)
      });
      if (res.ok) {
        healthMetrics.setServiceHealth('jellyfin', 'healthy');
      } else {
        healthMetrics.setServiceHealth('jellyfin', 'unhealthy', `HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      healthMetrics.setServiceHealth('jellyfin', 'unhealthy', getErrorMessage(err));
    }
  }

  private async pingSeerr(baseUrl: string) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/status`, {
        headers: { 'X-Api-Key': process.env.SEERR_API_KEY || '' },
        signal: AbortSignal.timeout(PING_TIMEOUT_MS)
      });
      if (res.ok) {
        healthMetrics.setServiceHealth('seerr', 'healthy');
      } else {
        healthMetrics.setServiceHealth('seerr', 'unhealthy', `HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      healthMetrics.setServiceHealth('seerr', 'unhealthy', getErrorMessage(err));
    }
  }

  /** Hits the OpenAI-compatible /models endpoint of the given base URL. */
  private async pingLLM(target: { key: string; baseUrl: string; apiKey: string }) {
    try {
      let modelsBase = target.baseUrl;
      if (!modelsBase.endsWith('/v1')) {
        modelsBase = modelsBase.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
        if (!modelsBase.endsWith('/v1')) modelsBase += '/v1';
      }
      const res = await fetch(`${modelsBase}/models`, {
         headers: { Authorization: `Bearer ${target.apiKey}` },
         signal: AbortSignal.timeout(PING_TIMEOUT_MS)
      });
      if (res.ok) {
        healthMetrics.setServiceHealth(target.key, 'healthy');
      } else {
        healthMetrics.setServiceHealth(target.key, 'unhealthy', `HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      healthMetrics.setServiceHealth(target.key, 'unhealthy', getErrorMessage(err));
    }
  }
}

export const healthMonitor = new HealthMonitor();
