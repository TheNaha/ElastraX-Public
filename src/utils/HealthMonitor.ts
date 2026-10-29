import { logger } from './logger';
import { healthMetrics } from './HealthMetrics';
import { getErrorMessage } from './errorUtils';
import { resolveLLMTargets } from '../config/llm';
import { spawn } from 'node:child_process';

const log = logger.child({ module: 'HealthMonitor' });
const PING_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 5000;

// Protocol validation for health-check URLs. We intentionally allow
// localhost and RFC1918 addresses: these are user-configured service
// endpoints (Jellyfin, Seerr, Ollama, local LLMs), not user-controllable
// redirect targets, so the classic SSRF threat model does not apply.
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

function validateUrl(url: string): void {
  try {
    const parsedUrl = new URL(url);
    if (!ALLOWED_PROTOCOLS.includes(parsedUrl.protocol)) {
      throw new Error(`Invalid protocol: ${parsedUrl.protocol}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Invalid protocol')) {
      throw error;
    }
    throw new Error(`Invalid URL for health check: ${url}`, { cause: error });
  }
}

type HealthCheck = () => Promise<void>;

function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Health-check URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Health-check URL must not contain credentials');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function openAiModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('LLM health-check URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('LLM health-check URL must not contain credentials');
  }
  url.pathname = url.pathname
    .replace(/\/chat\/completions\/?$/i, '')
    .replace(/\/+$/, '');
  url.pathname = `${url.pathname}/models`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class HealthMonitor {
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly controllers = new Set<AbortController>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    log.info('Starting HealthMonitor');

    this.schedule('jellyfin', () => {
      const baseUrl = process.env.JELLYFIN_API_URL || process.env.JELLYFIN_URL;
      return baseUrl ? this.pingJellyfin(baseUrl) : Promise.resolve();
    });

    this.schedule('seerr', () => {
      const baseUrl = process.env.SEERR_API_URL || process.env.SEERR_URL;
      return baseUrl ? this.pingSeerr(baseUrl) : Promise.resolve();
    });

    for (const target of resolveLLMTargets()) {
      this.schedule(target.key, () => this.pingLLM(target));
    }

    this.schedule('yt-dlp', () => this.pingYtDlp());
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.started = false;
    log.info('HealthMonitor stopped');
  }

  isStarted(): boolean {
    return this.started;
  }

  pendingChecks(): number {
    return this.inFlight.size;
  }

  private schedule(name: string, check: HealthCheck): void {
    const run = () => {
      if (this.inFlight.has(name)) return;
      const promise = check()
        .catch((error: unknown) => {
          log.warn({ check: name, err: getErrorMessage(error) }, 'Health check failed');
        })
        .finally(() => {
          this.inFlight.delete(name);
        });
      this.inFlight.set(name, promise);
    };

    run();
    const timer = setInterval(run, PING_INTERVAL_MS);
    timer.unref?.();
    this.timers.push(timer);
  }

  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    validateUrl(url);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  private async pingJellyfin(baseUrl: string): Promise<void> {
    try {
      const response = await this.fetchWithTimeout(endpoint(baseUrl, 'System/Info/Public'));
      healthMetrics.setServiceHealth(
        'jellyfin',
        response.ok ? 'healthy' : 'unhealthy',
        response.ok ? undefined : `HTTP ${response.status}`,
      );
    } catch (error) {
      healthMetrics.setServiceHealth('jellyfin', 'unhealthy', getErrorMessage(error));
    }
  }

  private async pingSeerr(baseUrl: string): Promise<void> {
    const apiKey = process.env.SEERR_API_KEY?.trim();
    if (!apiKey) {
      healthMetrics.setServiceHealth('seerr', 'unhealthy', 'SEERR_API_KEY is not configured');
      return;
    }
    try {
      const response = await this.fetchWithTimeout(endpoint(baseUrl, 'status'), {
        headers: { 'X-Api-Key': apiKey },
      });
      healthMetrics.setServiceHealth(
        'seerr',
        response.ok ? 'healthy' : 'unhealthy',
        response.ok ? undefined : `HTTP ${response.status}`,
      );
    } catch (error) {
      healthMetrics.setServiceHealth('seerr', 'unhealthy', getErrorMessage(error));
    }
  }

  private async pingLLM(target: { key: string; baseUrl: string; apiKey: string }): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
      const response = await this.fetchWithTimeout(openAiModelsUrl(target.baseUrl), { headers });
      healthMetrics.setServiceHealth(
        target.key,
        response.ok ? 'healthy' : 'unhealthy',
        response.ok ? undefined : `HTTP ${response.status}`,
      );
    } catch (error) {
      healthMetrics.setServiceHealth(target.key, 'unhealthy', getErrorMessage(error));
    }
  }

  private async pingYtDlp(): Promise<void> {
    const ytDlpPath = process.env.YTDLP_PATH || 'yt-dlp';
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ytDlpPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer | string) => {
          stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`exit code ${code}: ${stderr.trim() || stdout.trim()}`));
        });
        child.on('error', (error) => {
          reject(new Error(`spawn failed: ${error.message}`));
        });
        setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('timed out'));
        }, 10_000).unref?.();
      });
      healthMetrics.setServiceHealth('yt-dlp', 'healthy');
    } catch (error) {
      healthMetrics.setServiceHealth('yt-dlp', 'unhealthy', getErrorMessage(error));
    }
  }
}

export const healthMonitor = new HealthMonitor();
