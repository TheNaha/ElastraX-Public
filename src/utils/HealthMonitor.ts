import { logger } from './logger';
import { healthMetrics } from './HealthMetrics';

const log = logger.child({ module: 'HealthMonitor' });

export class HealthMonitor {
  private timers: ReturnType<typeof setInterval>[] = [];

  start() {
    log.info('Starting HealthMonitor...');

    // Ping Jellyfin
    if (process.env.JELLYFIN_URL) {
      this.timers.push(setInterval(() => this.pingJellyfin(), 60000));
      this.pingJellyfin();
    }
    
    // Ping Seerr
    if (process.env.SEERR_URL) {
      this.timers.push(setInterval(() => this.pingSeerr(), 60000));
      this.pingSeerr();
    }
    
    // Ping LLM
    if (process.env.AI_API_BASE_URL) {
      this.timers.push(setInterval(() => this.pingLLM(), 60000));
      this.pingLLM();
    }
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    log.info('HealthMonitor stopped.');
  }

  private async pingJellyfin() {
    try {
      const res = await fetch(`${process.env.JELLYFIN_URL}/System/Info/Public`, {
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        healthMetrics.setServiceHealth('jellyfin', 'healthy');
      } else {
        healthMetrics.setServiceHealth('jellyfin', 'unhealthy', `HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      healthMetrics.setServiceHealth('jellyfin', 'unhealthy', msg);
    }
  }

  private async pingSeerr() {
    try {
      const res = await fetch(`${process.env.SEERR_URL}/api/v1/status`, {
        headers: { 'X-Api-Key': process.env.SEERR_API_KEY || '' },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        healthMetrics.setServiceHealth('seerr', 'healthy');
      } else {
        healthMetrics.setServiceHealth('seerr', 'unhealthy', `HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      healthMetrics.setServiceHealth('seerr', 'unhealthy', msg);
    }
  }

  private async pingLLM() {
    try {
      const url = new URL(process.env.AI_API_BASE_URL || '');
      // Try to hit the /models endpoint, assuming OpenAI compatibility
      const modelsUrl = `${url.origin}${url.pathname.replace(/\/chat\/completions\/?$/, '')}/models`;
      const res = await fetch(modelsUrl, {
         headers: { Authorization: `Bearer ${process.env.AI_API_KEY}` },
         signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        healthMetrics.setServiceHealth('llm', 'healthy');
      } else {
        healthMetrics.setServiceHealth('llm', 'unhealthy', `HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      healthMetrics.setServiceHealth('llm', 'unhealthy', msg);
    }
  }
}

export const healthMonitor = new HealthMonitor();
