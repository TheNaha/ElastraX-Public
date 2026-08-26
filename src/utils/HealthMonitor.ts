import { logger } from './logger';
import { healthMetrics } from './HealthMetrics';
import { getErrorMessage } from './errorUtils';

const log = logger.child({ module: 'HealthMonitor' });

const PING_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;

function buildCloudflareBaseUrl(accountId?: string): string {
  return accountId ? `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/ai/v1` : '';
}

/** Mirrors ModelRouter's provider resolution so health checks cover exactly what is configured. */
function resolveLLMTargets(): { key: string; baseUrl: string; apiKey: string }[] {
  const providerList = process.env.AI_PROVIDERS;
  if (!providerList || providerList.trim() === '') {
    const baseUrl = process.env.AI_API_BASE_URL || buildCloudflareBaseUrl(process.env.AI_CF_ACCOUNT_ID);
    if (!baseUrl) return [];
    return [{ key: 'llm', baseUrl, apiKey: process.env.AI_API_KEY || process.env.AI_CF_API_TOKEN || '' }];
  }
  return providerList.split(',').map(p => p.trim().toLowerCase()).filter(Boolean).map(name => {
    const upper = name.toUpperCase();
    return {
      key: `llm:${name}`,
      baseUrl: process.env[`AI_${upper}_BASE_URL`] || buildCloudflareBaseUrl(process.env[`AI_${upper}_CF_ACCOUNT_ID`]),
      apiKey: process.env[`AI_${upper}_API_KEY`] || process.env[`AI_${upper}_CF_API_TOKEN`] || '',
    };
  }).filter(t => t.baseUrl !== '');
}

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
