/**
 * Fake WhatsApp/Discord staging harness.
 *
 * The harness reproduces the provider contract implemented by
 * `src/providers/whatsapp.ts` and `src/providers/discord.ts` — lifecycle status
 * transitions, reconnect backoff, duplicate-event suppression, permission
 * resolution, lazy media descriptors, chunked long replies, and shutdown
 * semantics — using in-memory fakes only.
 *
 * Guarantees:
 *   - no credentials: no token, JID, session file, or secret is read, and no
 *     environment variable is consulted;
 *   - no network: nothing is fetched, no socket is opened, no subprocess runs;
 *   - no repository or database mutation: state lives inside this module.
 *
 * The limits mirrored here are asserted against the real provider constants by
 * `test/ProviderStagingHarness.test.ts`, so drift between this harness and the
 * shipping adapters fails the suite.
 *
 * Usage:
 *   bun run scripts/providerStagingHarness.ts
 *   bun run scripts/providerStagingHarness.ts --json
 *   bun run scripts/providerStagingHarness.ts --only long_reply,shutdown
 */

export type Platform = 'whatsapp' | 'discord';

export type ProviderStatus = 'stopped' | 'starting' | 'running' | 'backoff' | 'not_configured' | 'error';

export type MediaState = 'pending' | 'ready' | 'skipped' | 'error';

export type ProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'START_FAILED'
  | 'NOT_CONNECTED'
  | 'INVALID_TARGET'
  | 'UNSUPPORTED'
  | 'OPERATION_FAILED'
  | 'STALE_LIFECYCLE'
  | 'PERMISSION_DENIED';

export const WHATSAPP_TEXT_LIMIT = 65_536;
export const DISCORD_TEXT_LIMIT = 2_000;
export const WHATSAPP_RESTART_REQUIRED = 515;
export const WHATSAPP_LOGGED_OUT = 401;
export const RECONNECT_BASE_DELAY_MS = 1_500;
export const RECONNECT_MAX_DELAY_MS = 300_000;
export const HARD_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

export class ProviderError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;

  constructor(provider: string, operation: string, code: ProviderErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.operation = operation;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface MediaDescriptor {
  id: string;
  index: number;
  origin: 'current' | 'quoted';
  providerId: string;
  mimeType: string;
  sizeBytes: number;
  state: MediaState;
  mediaPath?: string;
  error?: string;
}

export interface SentEnvelope {
  chatId: string;
  text: string;
  kind: 'reply' | 'message' | 'media' | 'typing';
  mentions?: string[];
}

export interface HarnessMessageContext {
  platform: Platform;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  isGroup: boolean;
  hasMedia: boolean;
  mediaReady: Promise<void>;
  mediaAttachments: MediaDescriptor[];
  reply(text: string, options?: { mentions?: string[]; signal?: AbortSignal }): Promise<void>;
  sendTyping(): Promise<void>;
  downloadMedia(attachmentId?: string): Promise<Buffer | null>;
  checkPermissions(required: string): Promise<boolean>;
  resolveRoles(): Promise<string[]>;
}

export interface FakePeer {
  senderId: string;
  senderName: string;
  roles: string[];
  nativeAdmin?: boolean;
}

export interface FakeMediaInput {
  providerId: string;
  mimeType: string;
  sizeBytes: number;
  failDownload?: boolean;
}

export interface FakeMessageInput {
  messageId: string;
  chatId: string;
  peer: FakePeer;
  text: string;
  isGroup?: boolean;
  media?: FakeMediaInput;
  mediaDownloadDelayMs?: number;
}

export interface TransportOptions {
  platform: Platform;
  sendLimit: number;
  hardMediaMaxBytes?: number;
}

export interface StagingOptions extends TransportOptions {
  chatId?: string;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ScenarioResult {
  scenario: string;
  platform: Platform;
  passed: boolean;
  checks: CheckResult[];
}

export interface StagingReport {
  generatedAt: string;
  scenarios: ScenarioResult[];
  passed: number;
  failed: number;
  ok: boolean;
}

function units(text: string): string[] {
  return Array.from(text);
}

export function chunkFixedText(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('chunk limit must be a positive integer');
  const parts = units(text);
  if (parts.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < parts.length; offset += limit) chunks.push(parts.slice(offset, offset + limit).join(''));
  return chunks;
}

export function chunkBoundaryText(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('chunk limit must be a positive integer');
  const parts = units(text);
  if (parts.length === 0) return [''];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < parts.length) {
    let end = Math.min(offset + limit, parts.length);
    if (end < parts.length) {
      const searchStart = Math.max(offset + Math.floor(limit / 2), offset + 1);
      const boundary = parts.slice(searchStart, end);
      const lastBreak = boundary.lastIndexOf('\n');
      const lastSpace = boundary.lastIndexOf(' ');
      const breakAt = Math.max(lastBreak, lastSpace);
      if (breakAt >= 0) end = searchStart + breakAt + 1;
    }
    chunks.push(parts.slice(offset, end).join(''));
    offset = end;
  }
  return chunks;
}

export function chunkText(platform: Platform, text: string, limit: number): string[] {
  return platform === 'whatsapp' ? chunkFixedText(text, limit) : chunkBoundaryText(text, limit);
}

export function reconnectDelayMs(attempt: number, base = RECONNECT_BASE_DELAY_MS, max = RECONNECT_MAX_DELAY_MS): number {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  return Math.min(base * 2 ** (safeAttempt - 1), max);
}

export function createLazyPromise<T>(operation: () => Promise<T>): Promise<T> {
  let started: Promise<T> | undefined;
  const start = (): Promise<T> => {
    if (!started) started = Promise.resolve().then(operation);
    return started;
  };
  const base = new Promise<T>(() => undefined) as Promise<T>;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'then') {
        return (onfulfilled?: ((value: T) => unknown) | null, onrejected?: ((reason: unknown) => unknown) | null) => start().then(onfulfilled, onrejected);
      }
      if (property === 'catch') {
        return (onrejected?: ((reason: unknown) => unknown) | null) => start().catch(onrejected);
      }
      if (property === 'finally') {
        return (onfinally?: (() => void) | null) => start().finally(onfinally);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function sanitize(text: string): string {
  return units(text)
    .map(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .slice(0, 500);
}

function errorMessage(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}

function codeOf(error: unknown): string {
  return error instanceof ProviderError ? error.code : 'UNKNOWN';
}

export class FakeStagingProvider {
  readonly platform: Platform;
  readonly sendLimit: number;
  readonly hardMediaMaxBytes: number;

  private currentStatus: ProviderStatus = 'stopped';
  private currentError: Error | null = null;
  private lifecycleGeneration = 0;
  private desiredRunning = false;
  private connected = false;
  private reconnectAttempts = 0;
  private suppressedDuplicates = 0;
  private handler: ((ctx: HarnessMessageContext) => Promise<void>) | null = null;
  private readonly handledEvents = new Set<string>();
  private readonly outgoingEnvelopes: SentEnvelope[] = [];
  private readonly abortedMedia = new Set<string>();

  constructor(options: StagingOptions) {
    this.platform = options.platform;
    this.sendLimit = options.sendLimit;
    this.hardMediaMaxBytes = options.hardMediaMaxBytes ?? HARD_MEDIA_MAX_BYTES;
  }

  get status(): ProviderStatus {
    return this.currentStatus;
  }

  get lastError(): Error | null {
    return this.currentError;
  }

  get isOperational(): boolean {
    return this.currentStatus === 'running';
  }

  get connectionGeneration(): number {
    return this.lifecycleGeneration;
  }

  get outgoing(): readonly SentEnvelope[] {
    return this.outgoingEnvelopes;
  }

  get duplicateEventsSuppressed(): number {
    return this.suppressedDuplicates;
  }

  onMessage(handler: (ctx: HarnessMessageContext) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.desiredRunning = true;
    if (this.connected && (this.currentStatus === 'running' || this.currentStatus === 'starting')) return;
    this.lifecycleGeneration++;
    this.currentStatus = 'starting';
    this.currentError = null;
    this.connected = true;
    this.reconnectAttempts = 0;
    this.currentStatus = 'running';
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.lifecycleGeneration++;
    this.currentStatus = 'stopped';
    this.currentError = null;
    this.connected = false;
  }

  private requireRunning(operation: string): void {
    if (!this.desiredRunning || !this.connected || this.currentStatus !== 'running') {
      throw new ProviderError(
        this.platform,
        operation,
        'STALE_LIFECYCLE',
        `${this.platform} connection changed before ${operation} completed.`,
        true,
      );
    }
  }

  simulateDisconnect(statusCode: number): { reconnectScheduled: boolean; delayMs: number | null; error: ProviderError } {
    const loggedOut = statusCode === WHATSAPP_LOGGED_OUT;
    const error = new ProviderError(
      this.platform,
      'connection.update',
      loggedOut ? 'PERMISSION_DENIED' : 'OPERATION_FAILED',
      `connection closed with status ${statusCode}`,
      !loggedOut,
    );
    this.connected = false;
    this.currentError = error;
    if (!this.desiredRunning) {
      this.currentStatus = 'stopped';
      return { reconnectScheduled: false, delayMs: null, error };
    }
    if (loggedOut) {
      this.currentStatus = 'error';
      return { reconnectScheduled: false, delayMs: null, error };
    }
    this.currentStatus = 'backoff';
    const delayMs = reconnectDelayMs(this.reconnectAttempts + 1);
    this.reconnectAttempts++;
    return { reconnectScheduled: true, delayMs, error };
  }

  abortMedia(messageId: string): void {
    this.abortedMedia.add(messageId);
  }

  private buildMedia(input: FakeMessageInput): MediaDescriptor | null {
    if (!input.media) return null;
    const oversize = input.media.sizeBytes > this.hardMediaMaxBytes;
    return {
      id: `current:${input.messageId}`,
      index: 0,
      origin: 'current',
      providerId: input.media.providerId,
      mimeType: input.media.mimeType,
      sizeBytes: input.media.sizeBytes,
      state: oversize ? 'skipped' : 'pending',
      error: oversize ? `${this.platform} media exceeds ${this.hardMediaMaxBytes} bytes.` : undefined,
    };
  }

  private buildContext(input: FakeMessageInput): HarnessMessageContext {
    const generation = this.lifecycleGeneration;
    const descriptor = this.buildMedia(input);
    const attachments = descriptor ? [descriptor] : [];

    const acquire = async (): Promise<void> => {
      if (!descriptor || descriptor.state === 'skipped' || descriptor.state === 'ready') return;
      if (input.mediaDownloadDelayMs && input.mediaDownloadDelayMs > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.floor(input.mediaDownloadDelayMs!))));
      }
      if (this.abortedMedia.has(input.messageId)) {
        descriptor.state = 'error';
        descriptor.error = sanitize('media download aborted by shutdown');
        return;
      }
      if (input.media?.failDownload) {
        descriptor.state = 'error';
        descriptor.error = sanitize(`media download rejected for ${input.media.providerId}`);
        return;
      }
      descriptor.state = 'ready';
      descriptor.mediaPath = `/virtual/media/${input.media?.providerId ?? 'unknown'}`;
    };

    const mediaReady = createLazyPromise(async () => {
      await acquire();
    });

    const ensureCurrent = (operation: string): void => {
      if (generation !== this.lifecycleGeneration || !this.desiredRunning) {
        throw new ProviderError(
          this.platform,
          operation,
          'STALE_LIFECYCLE',
          `${this.platform} connection changed before ${operation} completed.`,
          true,
        );
      }
    };

    const resolveRoles = async (): Promise<string[]> => {
      ensureCurrent('resolveRoles');
      const roles = new Set<string>(['user', ...input.peer.roles]);
      if (input.isGroup === true && input.peer.nativeAdmin) roles.add('admin');
      return [...roles];
    };

    return {
      platform: this.platform,
      chatId: input.chatId,
      messageId: input.messageId,
      senderId: input.peer.senderId,
      senderName: input.peer.senderName,
      text: input.text,
      isGroup: input.isGroup === true,
      hasMedia: descriptor != null,
      mediaReady,
      mediaAttachments: attachments,
      reply: async (replyText: string, replyOptions?: { mentions?: string[]; signal?: AbortSignal }) => {
        const chunks = chunkText(this.platform, replyText, this.sendLimit);
        for (let index = 0; index < chunks.length; index++) {
          replyOptions?.signal?.throwIfAborted();
          ensureCurrent('reply');
          const mentions = index === 0 ? replyOptions?.mentions : undefined;
          this.outgoingEnvelopes.push({
            chatId: input.chatId,
            text: chunks[index]!,
            kind: 'reply',
            ...(mentions && mentions.length > 0 ? { mentions } : {}),
          });
        }
      },
      sendTyping: async (): Promise<void> => {
        ensureCurrent('sendTyping');
        this.outgoingEnvelopes.push({ chatId: input.chatId, text: '', kind: 'typing' });
      },
      downloadMedia: async (attachmentId?: string): Promise<Buffer | null> => {        const target = attachmentId ? attachments.find(candidate => candidate.id === attachmentId) : descriptor;
        if (!target) {
          throw new ProviderError(
            this.platform,
            'selectMediaAttachment',
            'INVALID_TARGET',
            `Unknown ${this.platform} attachment: ${String(attachmentId)}.`,
          );
        }
        if (target.state === 'skipped') {
          throw new ProviderError(this.platform, 'downloadMedia', 'OPERATION_FAILED', target.error ?? 'Media is unavailable.');
        }
        await acquire();
        if (target.state !== 'ready' || !target.mediaPath) {
          throw new ProviderError(this.platform, 'downloadMedia', 'OPERATION_FAILED', target.error ?? 'Media is unavailable.');
        }
        return Buffer.from(target.mediaPath);
      },
      checkPermissions: async (required: string): Promise<boolean> => {
        ensureCurrent('checkPermissions');
        if (required === 'user') return true;
        const roles = await resolveRoles();
        return roles.includes(required) || roles.includes('owner');
      },
      resolveRoles,
    };
  }

  async deliver(input: FakeMessageInput): Promise<{ accepted: boolean; reason: string }> {
    this.requireRunning('deliver');
    const eventKey = `${input.peer.senderId}:${input.messageId}`;
    if (this.handledEvents.has(eventKey)) {
      this.suppressedDuplicates++;
      return { accepted: false, reason: 'duplicate provider event suppressed' };
    }
    if (!this.handler) return { accepted: false, reason: 'no message handler registered' };
    const ctx = this.buildContext(input);
    this.handledEvents.add(eventKey);
    await this.handler(ctx);
    return { accepted: true, reason: 'handled' };
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    this.requireRunning('sendMessage');
    for (const chunk of chunkText(this.platform, text, this.sendLimit)) {
      signal?.throwIfAborted();
      this.outgoingEnvelopes.push({ chatId, text: chunk, kind: 'message' });
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    this.requireRunning('sendTyping');
    this.outgoingEnvelopes.push({ chatId, text: '', kind: 'typing' });
  }
}

function check(name: string, passed: boolean, detail: string): CheckResult {
  return { name, passed, detail };
}

function buildScenario(name: string, platform: Platform, checks: CheckResult[]): ScenarioResult {
  return { scenario: name, platform, passed: checks.every(entry => entry.passed), checks };
}

export function defaultChatId(platform: Platform): string {
  return platform === 'whatsapp' ? '120363000000000000@g.us' : '1203630000000000000';
}

const REGULAR_PEER: FakePeer = { senderId: '6281234567890@s.whatsapp.net', senderName: 'Regular User', roles: [] };
const ADMIN_PEER: FakePeer = { senderId: '6289999999999@s.whatsapp.net', senderName: 'Group Admin', roles: [], nativeAdmin: true };
const OWNER_PEER: FakePeer = { senderId: '6280000000000@s.whatsapp.net', senderName: 'Owner', roles: ['owner'] };

async function connectScenario(options: StagingOptions): Promise<ScenarioResult> {
  const provider = new FakeStagingProvider(options);
  const chatId = options.chatId ?? defaultChatId(options.platform);
  const checks: CheckResult[] = [];

  checks.push(check('starts stopped', provider.status === 'stopped', `status=${provider.status}`));
  await provider.start();
  checks.push(check('start reaches running', provider.status === 'running' && provider.isOperational, `status=${provider.status}`));
  checks.push(check('start clears lastError', provider.lastError === null, `lastError=${errorMessage(provider.lastError)}`));

  const contexts: HarnessMessageContext[] = [];
  provider.onMessage(async ctx => {
    contexts.push(ctx);
    await ctx.sendTyping();
    await ctx.reply('acknowledged');
  });

  const delivery = await provider.deliver({ messageId: 'connect-1', chatId, peer: REGULAR_PEER, text: 'hello', isGroup: true });
  const replies = provider.outgoing.filter(entry => entry.kind === 'reply');
  checks.push(check('first delivery is accepted', delivery.accepted, `reason=${delivery.reason}`));
  checks.push(check('handler receives exactly one context', contexts.length === 1, `contexts=${contexts.length}`));
  checks.push(check('context carries the provider contract fields', contexts[0]?.platform === options.platform && contexts[0]?.isGroup === true, `platform=${contexts[0]?.platform}`));
  checks.push(check('typing presence is emitted before the reply', provider.outgoing[0]?.kind === 'typing', `first=${provider.outgoing[0]?.kind}`));
  checks.push(check('reply produces one envelope', replies.length === 1, `replies=${replies.length}`));
  checks.push(check('reply respects the platform limit', replies.every(entry => entry.text.length <= options.sendLimit), `limit=${options.sendLimit}`));
  return buildScenario('connect', options.platform, checks);
}

async function reconnectScenario(options: StagingOptions): Promise<ScenarioResult> {
  const provider = new FakeStagingProvider(options);
  const chatId = options.chatId ?? defaultChatId(options.platform);
  const checks: CheckResult[] = [];
  await provider.start();
  const firstGeneration = provider.connectionGeneration;

  const restart = provider.simulateDisconnect(WHATSAPP_RESTART_REQUIRED);
  checks.push(check('restart-required (515) schedules a reconnect', restart.reconnectScheduled, `scheduled=${restart.reconnectScheduled}`));
  checks.push(check('restart-required (515) enters backoff', provider.status === 'backoff', `status=${provider.status}`));
  checks.push(check('first backoff delay is 1500ms', restart.delayMs === RECONNECT_BASE_DELAY_MS, `delayMs=${String(restart.delayMs)}`));
  checks.push(check('restart-required (515) is retryable', restart.error.retryable, `retryable=${restart.error.retryable}`));
  checks.push(check('readiness is false during backoff', !provider.isOperational, `isOperational=${provider.isOperational}`));

  const second = provider.simulateDisconnect(WHATSAPP_RESTART_REQUIRED);
  checks.push(check('second backoff delay doubles', second.delayMs === RECONNECT_BASE_DELAY_MS * 2, `delayMs=${String(second.delayMs)}`));
  checks.push(check('backoff is capped at 300000ms', reconnectDelayMs(30) === RECONNECT_MAX_DELAY_MS, `delayMs=${reconnectDelayMs(30)}`));

  const loggedOut = provider.simulateDisconnect(WHATSAPP_LOGGED_OUT);
  checks.push(check('logged-out (401) never reconnects', !loggedOut.reconnectScheduled, `scheduled=${loggedOut.reconnectScheduled}`));
  checks.push(check('logged-out (401) is a terminal error state', provider.status === 'error', `status=${provider.status}`));
  checks.push(check('logged-out (401) is not retryable', !loggedOut.error.retryable, `retryable=${loggedOut.error.retryable}`));

  await provider.start();
  checks.push(check('reconnect advances the lifecycle generation', provider.connectionGeneration > firstGeneration, `generation=${provider.connectionGeneration}`));
  checks.push(check('reconnect clears backoff', provider.status === 'running', `status=${provider.status}`));

  const seen: string[] = [];
  provider.onMessage(async ctx => {
    seen.push(ctx.messageId);
  });
  const afterReconnect = await provider.deliver({ messageId: 'after-reconnect', chatId, peer: REGULAR_PEER, text: 'ping', isGroup: true });
  checks.push(check('events flow again after reconnect', afterReconnect.accepted && seen.length === 1, `accepted=${afterReconnect.accepted} events=${seen.length}`));
  return buildScenario('reconnect', options.platform, checks);
}

async function duplicateEventScenario(options: StagingOptions): Promise<ScenarioResult> {
  const provider = new FakeStagingProvider(options);
  const chatId = options.chatId ?? defaultChatId(options.platform);
  const checks: CheckResult[] = [];
  await provider.start();

  const handled: string[] = [];
  provider.onMessage(async ctx => {
    handled.push(ctx.messageId);
    await ctx.reply('answered once');
  });

  const first = await provider.deliver({ messageId: 'dup-1', chatId, peer: REGULAR_PEER, text: 'same text', isGroup: true });
  const replay = await provider.deliver({ messageId: 'dup-1', chatId, peer: REGULAR_PEER, text: 'same text', isGroup: true });
  const distinct = await provider.deliver({ messageId: 'dup-2', chatId, peer: REGULAR_PEER, text: 'same text', isGroup: true });

  const replies = provider.outgoing.filter(entry => entry.kind === 'reply');
  checks.push(check('first delivery is accepted', first.accepted, `reason=${first.reason}`));
  checks.push(check('replayed provider event is rejected', !replay.accepted, `reason=${replay.reason}`));
  checks.push(check('a distinct message id is still accepted', distinct.accepted, `reason=${distinct.reason}`));
  checks.push(check('handler runs once per distinct event', handled.length === 2, `handled=${handled.length}`));
  checks.push(check('suppression is counted', provider.duplicateEventsSuppressed === 1, `suppressed=${provider.duplicateEventsSuppressed}`));
  checks.push(check('no duplicate reply escapes', replies.length === 2, `replies=${replies.length}`));
  return buildScenario('duplicate_event', options.platform, checks);
}

async function permissionScenario(options: StagingOptions): Promise<ScenarioResult> {
  const provider = new FakeStagingProvider(options);
  const chatId = options.chatId ?? defaultChatId(options.platform);
  const checks: CheckResult[] = [];
  await provider.start();

  const observed = new Map<string, { admin: boolean; premium: boolean; owner: boolean; roles: string[] }>();
  provider.onMessage(async ctx => {
    const [admin, premium, owner, roles] = await Promise.all([
      ctx.checkPermissions('admin'),
      ctx.checkPermissions('premium'),
      ctx.checkPermissions('owner'),
      ctx.resolveRoles(),
    ]);
    observed.set(ctx.messageId, { admin, premium, owner, roles });
  });

  await provider.deliver({ messageId: 'perm-group-user', chatId, peer: REGULAR_PEER, text: 'hi', isGroup: true });
  await provider.deliver({ messageId: 'perm-group-admin', chatId, peer: ADMIN_PEER, text: 'hi', isGroup: true });
  await provider.deliver({ messageId: 'perm-owner', chatId, peer: OWNER_PEER, text: 'hi', isGroup: true });
  await provider.deliver({ messageId: 'perm-dm-user', chatId, peer: REGULAR_PEER, text: 'hi', isGroup: false });

  const groupUser = observed.get('perm-group-user');
  const groupAdmin = observed.get('perm-group-admin');
  const owner = observed.get('perm-owner');
  const dmUser = observed.get('perm-dm-user');
  checks.push(check('group member is denied admin', groupUser?.admin === false, `admin=${String(groupUser?.admin)}`));
  checks.push(check('group member is denied premium', groupUser?.premium === false, `premium=${String(groupUser?.premium)}`));
  checks.push(check('every peer holds the user role', (groupUser?.roles ?? []).includes('user') && (dmUser?.roles ?? []).includes('user'), `roles=${(groupUser?.roles ?? []).join(',')}`));
  checks.push(check('native group admin is granted admin', groupAdmin?.admin === true, `admin=${String(groupAdmin?.admin)}`));
  checks.push(check('native admin does not gain owner', groupAdmin?.owner === false, `owner=${String(groupAdmin?.owner)}`));
  checks.push(check('owner satisfies every permission check', owner?.admin === true && owner?.premium === true && owner?.owner === true, `roles=${(owner?.roles ?? []).join(',')}`));
  checks.push(check('direct messages never grant native admin', dmUser?.admin === false, `admin=${String(dmUser?.admin)}`));
  return buildScenario('permission', options.platform, checks);
}

async function mediaFailureScenario(options: StagingOptions): Promise<ScenarioResult> {
  const provider = new FakeStagingProvider(options);
  const chatId = options.chatId ?? defaultChatId(options.platform);
  const hardCap = options.hardMediaMaxBytes ?? HARD_MEDIA_MAX_BYTES;
  const checks: CheckResult[] = [];
  await provider.start();

  const observed = new Map<string, { descriptor: MediaDescriptor | null; downloadCode: string | null; lazyError: string | null }>();
  provider.onMessage(async ctx => {
    let downloadCode: string | null = null;
    const requested = ctx.messageId === 'media-unknown' ? 'current:missing-attachment' : undefined;
    try {
      await ctx.downloadMedia(requested);
    } catch (error) {
      downloadCode = codeOf(error);
    }
    let lazyError: string | null = null;
    try {
      await ctx.mediaReady;
    } catch (error) {
      lazyError = errorMessage(error);
    }
    observed.set(ctx.messageId, { descriptor: ctx.mediaAttachments[0] ?? null, downloadCode, lazyError });
  });

  await provider.deliver({
    messageId: 'media-fail',
    chatId,
    peer: REGULAR_PEER,
    text: 'photo',
    isGroup: true,
    media: { providerId: 'media-1', mimeType: 'image/jpeg', sizeBytes: 4_096, failDownload: true },
  });
  const failed = observed.get('media-fail');
  checks.push(check('a rejected download marks the descriptor as error', failed?.descriptor?.state === 'error', `state=${String(failed?.descriptor?.state)}`));
  checks.push(check('the descriptor error text is bounded', typeof failed?.descriptor?.error === 'string' && (failed?.descriptor?.error ?? '').length <= 500, `error=${String(failed?.descriptor?.error)}`));
  checks.push(check('downloadMedia throws OPERATION_FAILED', failed?.downloadCode === 'OPERATION_FAILED', `code=${String(failed?.downloadCode)}`));
  checks.push(check('lazy mediaReady never rejects the turn', failed?.lazyError === null, `error=${String(failed?.lazyError)}`));

  await provider.deliver({
    messageId: 'media-oversize',
    chatId,
    peer: REGULAR_PEER,
    text: 'huge',
    isGroup: true,
    media: { providerId: 'media-2', mimeType: 'video/mp4', sizeBytes: hardCap + 1 },
  });
  const oversize = observed.get('media-oversize');
  checks.push(check('oversize media is skipped before download', oversize?.descriptor?.state === 'skipped', `state=${String(oversize?.descriptor?.state)}`));
  checks.push(check('the skip reason names the byte cap', typeof oversize?.descriptor?.error === 'string' && (oversize?.descriptor?.error ?? '').includes('bytes'), `error=${String(oversize?.descriptor?.error)}`));
  checks.push(check('skipped media still throws on explicit request', oversize?.downloadCode === 'OPERATION_FAILED', `code=${String(oversize?.downloadCode)}`));

  await provider.deliver({
    messageId: 'media-ok',
    chatId,
    peer: REGULAR_PEER,
    text: 'fine',
    isGroup: true,
    media: { providerId: 'media-3', mimeType: 'image/png', sizeBytes: 2_048 },
  });
  const healthy = observed.get('media-ok');
  checks.push(check('healthy media becomes ready', healthy?.descriptor?.state === 'ready', `state=${String(healthy?.descriptor?.state)}`));
  checks.push(check('healthy media downloads without error', healthy?.downloadCode === null, `code=${String(healthy?.downloadCode)}`));

  await provider.deliver({
    messageId: 'media-unknown',
    chatId,
    peer: REGULAR_PEER,
    text: 'bad target',
    isGroup: true,
    media: { providerId: 'media-4', mimeType: 'image/png', sizeBytes: 1_024 },
  });
  const unknown = observed.get('media-unknown');
  checks.push(check('an unknown attachment id is an invalid target', unknown?.downloadCode === 'INVALID_TARGET', `code=${String(unknown?.downloadCode)}`));

  const lazyProvider = new FakeStagingProvider(options);
  await lazyProvider.start();
  let descriptorBeforeAwait: MediaState | null = null;
  let descriptorAfterAwait: MediaState | null = null;
  lazyProvider.onMessage(async ctx => {
    descriptorBeforeAwait = ctx.mediaAttachments[0]?.state ?? null;
    await ctx.mediaReady;
    descriptorAfterAwait = ctx.mediaAttachments[0]?.state ?? null;
  });
  await lazyProvider.deliver({
    messageId: 'media-lazy',
    chatId,
    peer: REGULAR_PEER,
    text: 'lazy',
    isGroup: true,
    media: { providerId: 'media-5', mimeType: 'image/png', sizeBytes: 3_072 },
  });
  checks.push(check('media acquisition stays lazy until awaited', descriptorBeforeAwait === 'pending' && descriptorAfterAwait === 'ready', `before=${String(descriptorBeforeAwait)} after=${String(descriptorAfterAwait)}`));
  return buildScenario('media_failure', options.platform, checks);
}

async function longReplyScenario(options: StagingOptions): Promise<ScenarioResult> {
  const provider = new FakeStagingProvider(options);
  const chatId = options.chatId ?? defaultChatId(options.platform);
  const checks: CheckResult[] = [];
  await provider.start();

  const sentence = 'ElastraX chunking contract line. ';
  const long = sentence.repeat(Math.ceil((options.sendLimit * 2 + 137) / sentence.length));
  const expectedChunks = chunkText(options.platform, long, options.sendLimit);

  provider.onMessage(async ctx => {
    await ctx.reply(long, { mentions: options.platform === 'whatsapp' ? ['6281234567890@s.whatsapp.net'] : ['123456789012345678'] });
  });
  await provider.deliver({ messageId: 'long-1', chatId, peer: REGULAR_PEER, text: 'long please', isGroup: true });

  const replies = provider.outgoing.filter(entry => entry.kind === 'reply');
  const mentioned = replies.filter(entry => entry.mentions && entry.mentions.length > 0);
  checks.push(check('a long reply is split into multiple chunks', replies.length >= 2, `chunks=${replies.length}`));
  checks.push(check('chunk count matches the platform chunker', replies.length === expectedChunks.length, `emitted=${replies.length} expected=${expectedChunks.length}`));
  checks.push(check('no chunk exceeds the platform limit', replies.every(entry => entry.text.length <= options.sendLimit), `limit=${options.sendLimit}`));
  checks.push(check('chunking is lossless', replies.map(entry => entry.text).join('') === long, `joined=${replies.map(entry => entry.text).join('').length} original=${long.length}`));
  checks.push(check('mentions are attached to the first chunk only', mentioned.length === 1, `mentioned=${mentioned.length}`));

  const controller = new AbortController();
  const aborting = new FakeStagingProvider(options);
  await aborting.start();
  let abortError = '';
  aborting.onMessage(async ctx => {
    controller.abort();
    try {
      await ctx.reply(long, { signal: controller.signal });
    } catch (error) {
      abortError = error instanceof Error ? error.name : String(error);
    }
  });
  await aborting.deliver({ messageId: 'long-abort', chatId, peer: REGULAR_PEER, text: 'abort', isGroup: true });
  checks.push(check('an abort signal stops the reply before the first chunk', abortError === 'AbortError', `error=${abortError}`));
  checks.push(check('an aborted reply emits nothing', aborting.outgoing.length === 0, `envelopes=${aborting.outgoing.length}`));
  return buildScenario('long_reply', options.platform, checks);
}

async function shutdownScenario(options: StagingOptions): Promise<ScenarioResult> {
  const provider = new FakeStagingProvider(options);
  const chatId = options.chatId ?? defaultChatId(options.platform);
  const checks: CheckResult[] = [];
  await provider.start();

  let descriptorState: MediaState | null = null;
  let mediaReadyError: string | null = null;
  let replyCode = '';
  provider.onMessage(async ctx => {
    provider.abortMedia(ctx.messageId);
    await provider.stop();
    try {
      await ctx.mediaReady;
    } catch (error) {
      mediaReadyError = errorMessage(error);
    }
    descriptorState = ctx.mediaAttachments[0]?.state ?? null;
    try {
      await ctx.reply('late reply');
    } catch (error) {
      replyCode = codeOf(error);
    }
  });

  await provider.deliver({
    messageId: 'shutdown-1',
    chatId,
    peer: REGULAR_PEER,
    text: 'shutdown',
    isGroup: true,
    media: { providerId: 'media-shutdown', mimeType: 'image/png', sizeBytes: 8_192 },
    mediaDownloadDelayMs: 5,
  });

  checks.push(check('stop moves the provider to stopped', provider.status === 'stopped', `status=${provider.status}`));
  checks.push(check('stop clears operational readiness', !provider.isOperational, `isOperational=${provider.isOperational}`));
  checks.push(check('in-flight media resolution does not reject the turn', mediaReadyError === null, `error=${String(mediaReadyError)}`));
  checks.push(check('in-flight media is recorded as aborted', descriptorState === 'error', `state=${String(descriptorState)}`));
  checks.push(check('a reply after stop is rejected as stale', replyCode === 'STALE_LIFECYCLE', `code=${replyCode}`));

  let sendCode = '';
  try {
    await provider.sendMessage(chatId, 'after stop');
  } catch (error) {
    sendCode = codeOf(error);
  }
  checks.push(check('sendMessage after stop is rejected as stale', sendCode === 'STALE_LIFECYCLE', `code=${sendCode}`));

  let typingCode = '';
  try {
    await provider.sendTyping(chatId);
  } catch (error) {
    typingCode = codeOf(error);
  }
  checks.push(check('sendTyping after stop is rejected as stale', typingCode === 'STALE_LIFECYCLE', `code=${typingCode}`));

  const afterStop = provider.simulateDisconnect(WHATSAPP_RESTART_REQUIRED);
  checks.push(check('a disconnect after stop schedules no reconnect', !afterStop.reconnectScheduled, `scheduled=${afterStop.reconnectScheduled}`));
  checks.push(check('a disconnect after stop keeps the stopped state', provider.status === 'stopped', `status=${provider.status}`));
  checks.push(check('no envelope escapes after shutdown', provider.outgoing.length === 0, `envelopes=${provider.outgoing.length}`));

  await provider.start();
  checks.push(check('the provider restarts cleanly after shutdown', provider.status === 'running', `status=${provider.status}`));
  return buildScenario('shutdown', options.platform, checks);
}

export const STAGING_SCENARIOS = [
  'connect',
  'reconnect',
  'duplicate_event',
  'permission',
  'media_failure',
  'long_reply',
  'shutdown',
] as const;

export type StagingScenarioName = (typeof STAGING_SCENARIOS)[number];

const SCENARIO_RUNNERS: Record<StagingScenarioName, (options: StagingOptions) => Promise<ScenarioResult>> = {
  connect: connectScenario,
  reconnect: reconnectScenario,
  duplicate_event: duplicateEventScenario,
  permission: permissionScenario,
  media_failure: mediaFailureScenario,
  long_reply: longReplyScenario,
  shutdown: shutdownScenario,
};

export interface RunStagingOptions {
  platforms?: readonly Platform[];
  scenarios?: readonly StagingScenarioName[];
  hardMediaMaxBytes?: number;
}

function stagingOptionsFor(platform: Platform, options: RunStagingOptions): StagingOptions {
  return {
    platform,
    sendLimit: platform === 'whatsapp' ? WHATSAPP_TEXT_LIMIT : DISCORD_TEXT_LIMIT,
    hardMediaMaxBytes: options.hardMediaMaxBytes ?? HARD_MEDIA_MAX_BYTES,
    chatId: defaultChatId(platform),
  };
}

export async function runStagingHarness(options: RunStagingOptions = {}): Promise<StagingReport> {
  const platforms = options.platforms ?? (['whatsapp', 'discord'] as const);
  const selected = options.scenarios ?? STAGING_SCENARIOS;
  const scenarios: ScenarioResult[] = [];
  for (const platform of platforms) {
    for (const name of selected) {
      const runner = SCENARIO_RUNNERS[name];
      if (!runner) throw new Error(`Unknown staging scenario: ${String(name)}`);
      scenarios.push(await runner(stagingOptionsFor(platform, options)));
    }
  }
  const passed = scenarios.filter(entry => entry.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    scenarios,
    passed,
    failed: scenarios.length - passed,
    ok: passed === scenarios.length,
  };
}

export function formatStagingReport(report: StagingReport): string {
  const lines: string[] = [];
  lines.push(`ElastraX provider staging harness (fakes only, no credentials) at ${report.generatedAt}`);
  for (const entry of report.scenarios) {
    lines.push('');
    lines.push(`${entry.passed ? 'PASS' : 'FAIL'} ${entry.scenario} [${entry.platform}]`);
    for (const item of entry.checks) {
      lines.push(`  ${item.passed ? 'ok  ' : 'FAIL'} ${item.name} - ${item.detail}`);
    }
  }
  lines.push('');
  lines.push(`Scenarios: ${report.passed} passed, ${report.failed} failed (${report.scenarios.length} total).`);
  return lines.join('\n');
}

const HELP = [
  'Usage: bun run scripts/providerStagingHarness.ts [options]',
  '',
  'Options:',
  '  --platform <name>   run only whatsapp or discord',
  '  --only <a,b>        run only the named scenarios',
  '  --json              emit the machine-readable report',
  '  --help              show this message',
  '',
  'The harness uses in-memory fakes only: no credentials, no network, no',
  'database, and no repository mutation. Verification against real provider',
  'accounts is a separate manual procedure documented in',
  'docs/provider-staging-matrix.md.',
  '',
  'Scenarios: connect, reconnect, duplicate_event, permission, media_failure,',
  'long_reply, shutdown.',
  '',
  'Exit codes: 0 every scenario passed, 1 at least one scenario failed,',
  '2 usage error.',
].join('\n');

export function parseStagingArgs(argv: readonly string[]): {
  options: RunStagingOptions;
  json: boolean;
  help: boolean;
  error: string | null;
} {
  const options: RunStagingOptions = {};
  let json = false;
  let help = false;

  const readValue = (index: number, inline: string | null): { value: string | null; next: number } => {
    if (inline != null) return { value: inline, next: index };
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) return { value: null, next: index };
    return { value: next, next: index + 1 };
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const inline = argument.includes('=') ? argument.split('=').slice(1).join('=') : null;
    const name = argument.split('=')[0]!;
    if (name === '--json') {
      json = true;
      continue;
    }
    if (name === '--help' || name === '-h') {
      help = true;
      continue;
    }
    if (name === '--platform') {
      const taken = readValue(index, inline);
      if (taken.value !== 'whatsapp' && taken.value !== 'discord') {
        return { options, json, help, error: '--platform must be whatsapp or discord' };
      }
      options.platforms = [taken.value];
      index = taken.next;
      continue;
    }
    if (name === '--only') {
      const taken = readValue(index, inline);
      if (taken.value == null) return { options, json, help, error: '--only requires a scenario list' };
      const names = taken.value.split(',').map(entry => entry.trim()).filter(Boolean);
      const unknown = names.filter(entry => !STAGING_SCENARIOS.includes(entry as StagingScenarioName));
      if (unknown.length > 0) return { options, json, help, error: `unknown scenario(s): ${unknown.join(', ')}` };
      options.scenarios = names as StagingScenarioName[];
      index = taken.next;
      continue;
    }
    return { options, json, help, error: `unknown argument: ${argument}` };
  }
  return { options, json, help, error: null };
}

async function main(): Promise<void> {
  const parsed = parseStagingArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    return;
  }
  if (parsed.error) {
    console.error(parsed.error);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  const report = await runStagingHarness(parsed.options);
  if (parsed.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatStagingReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.main) await main();
