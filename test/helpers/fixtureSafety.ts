import { readFileSync } from 'node:fs';

export const FIXTURE_SAFETY_RULES = [
  'coordinates',
  'crypto-key-or-secret',
  'media-metadata',
  'message-text',
  'phone-shaped-id',
  'structure',
  'unsafe-identifier',
  'unsafe-jid',
  'unsafe-name',
  'url',
  'vcard',
] as const;

export type FixtureSafetyRule = typeof FIXTURE_SAFETY_RULES[number];

export interface FixtureSafetyViolation {
  path: string;
  rule: FixtureSafetyRule;
  reason: string;
}

type JsonObject = Record<string, unknown>;
type SanitizerState = { ordinal: number };
type PathSegment = string | number;

const MESSAGE_TEXT_KEYS = new Set([
  'body',
  'caption',
  'content_text',
  'conversation',
  'description',
  'display_text',
  'footer',
  'footer_text',
  'header',
  'header_text',
  'hydrated_content_text',
  'message_text',
  'name',
  'option_name',
  'selected_display_text',
  'text',
  'title',
]);

const NAME_KEYS = new Set(['display_name', 'file_name', 'notify_name', 'push_name', 'sender_name']);

const COORDINATE_KEYS = new Set(['lat', 'latitude', 'lng', 'lon', 'longitude']);

const OPAQUE_MEDIA_KEYS = new Set([
  'jpeg_thumbnail',
  'local_path',
  'scan_sidecar',
  'scans_sidecar',
  'sidecar',
  'streaming_sidecar',
  'thumbnail',
]);

const DEVICE_PRIVATE_KEYS = new Set(['recipient_timestamp', 'sender_timestamp']);

const STRUCTURAL_NUMBER_KEYS = new Set([
  'album_id',
  'count',
  'duration',
  'file_length',
  'forwarding_score',
  'height',
  'index',
  'page_count',
  'seconds',
  'sequence_number',
  'width',
]);

const WHATSAPP_JID_DOMAINS = new Set(['bot', 'g.us', 'lid', 's.whatsapp.net']);
const SKIP = Symbol('fixture-skip');

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[^a-z\d]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || value === false || value === 0) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

function formatPath(path: readonly PathSegment[]): string {
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') return `${result}[${segment}]`;
    return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${result}.${segment}` : `${result}[${JSON.stringify(segment)}]`;
  }, '$');
}

function isMessageTextKey(key: string): boolean {
  return MESSAGE_TEXT_KEYS.has(key) || key === 'text' || key.endsWith('_text');
}

function isNameKey(key: string): boolean {
  return NAME_KEYS.has(key) || key.endsWith('_name') || key.endsWith('_filename');
}

function isCoordinateKey(key: string): boolean {
  return COORDINATE_KEYS.has(key) || key.endsWith('_latitude') || key.endsWith('_longitude');
}

function isOpaqueMediaKey(key: string): boolean {
  return OPAQUE_MEDIA_KEYS.has(key) || key.endsWith('_thumbnail');
}

function isUrlKey(key: string): boolean {
  return key === 'uri' || key === 'url' || key.endsWith('_url') || key.endsWith('_uri') || key.endsWith('direct_path');
}

function isStructuralKeyContainer(key: string): boolean {
  return key === 'key' || key === 'message_key' || key.endsWith('_message_key');
}

function isCryptoKey(key: string, value: unknown): boolean {
  if (isStructuralKeyContainer(key) || key === 'reporting_token_info') return !isObject(value);
  if (key === 'iv' || key === 'reporting_tag') return true;
  if (/(?:checksum|cipher|credential|encrypted|encryption|passcode|password|salt|secret|sidecar|signature|token)/.test(key)) return true;
  if (/(?:^|_)(?:hash|sha\d*)(?:_|$)/.test(key)) return true;
  return key.split('_').includes('key');
}

function isIdentifierKey(key: string): boolean {
  return key === 'id' || key === 'stanza_id' || key.endsWith('_message_id') || key.endsWith('_stanza_id');
}

function isJidKey(key: string): boolean {
  return key === 'participant' || key === 'participant_pn' || key.endsWith('_jid') || key.endsWith('_lid');
}

function isPhoneKey(key: string): boolean {
  return key === 'msisdn'
    || key === 'phone'
    || key === 'phone_number'
    || key.endsWith('_phone')
    || key.endsWith('_phone_number')
    || key === 'wa_id';
}

function isTimestampKey(key: string): boolean {
  return key === 'ts' || key.includes('timestamp') || key.endsWith('_sent_ts');
}

function isStructuralNumberKey(key: string): boolean {
  return STRUCTURAL_NUMBER_KEYS.has(key)
    || isTimestampKey(key)
    || key.endsWith('_count')
    || key.endsWith('_height')
    || key.endsWith('_length')
    || key.endsWith('_lengths')
    || key.endsWith('_score')
    || key.endsWith('_width');
}

function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function isPhoneLike(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return false;
  const digits = phoneDigits(trimmed);
  return digits.length >= 7 && digits.length <= 15;
}

function isJidLike(value: string): boolean {
  const separator = value.lastIndexOf('@');
  if (separator <= 0) return false;
  const domain = value.slice(separator + 1).toLowerCase();
  return WHATSAPP_JID_DOMAINS.has(domain) && !/\s/.test(value);
}

function jidLocalPart(value: string): string {
  const separator = value.lastIndexOf('@');
  return (separator >= 0 ? value.slice(0, separator) : value).split(':', 1)[0];
}

function isSyntheticIdentifier(value: string): boolean {
  return /^synthetic-[a-z\d]+(?:-[a-z\d]+)*$/i.test(value);
}

function isSyntheticJid(value: string): boolean {
  const separator = value.lastIndexOf('@');
  if (separator <= 0) return false;
  const localWithDevice = value.slice(0, separator);
  const local = localWithDevice.split(':', 1)[0];
  const device = localWithDevice.slice(local.length);
  return isSyntheticIdentifier(local) && (device === '' || /^:\d+$/.test(device));
}

function isSyntheticName(value: string): boolean {
  return /^synthetic(?:[\s_-]|$)/i.test(value);
}

function looksLikeUrl(value: string, parentKey = ''): boolean {
  const trimmed = value.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || /^\/\//.test(trimmed) || /^www\./i.test(trimmed)) return true;
  if (parentKey === 'file_name' || parentKey.endsWith('_filename')) return false;
  return /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(trimmed)
    || /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/|$)/.test(trimmed);
}

function nextOrdinal(state: SanitizerState): number {
  state.ordinal += 1;
  return state.ordinal;
}

function emptyLike(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) return [];
  if (isObject(value)) return {};
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  return '';
}

function safeExtension(value: unknown): string {
  if (typeof value !== 'string') return '.bin';
  const extension = value.match(/\.([a-z\d]{1,8})$/i)?.[1];
  return extension ? `.${extension.toLowerCase()}` : '.bin';
}

function sanitizeName(key: string, value: unknown, state: SanitizerState): unknown {
  if (isEmptyValue(value)) return value;
  if (key === 'file_name') return `synthetic-document-${nextOrdinal(state)}${safeExtension(value)}`;
  if (key === 'display_name') return `Synthetic Contact ${nextOrdinal(state)}`;
  if (key === 'notify_name') return 'Synthetic Notification';
  return 'Synthetic User';
}

function sanitizeJid(key: string, value: unknown, state: SanitizerState): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  const separator = value.lastIndexOf('@');
  const rawDomain = separator >= 0 ? value.slice(separator + 1).toLowerCase() : '';
  const domain = rawDomain || (key.includes('lid') ? 'lid' : key.includes('bot') ? 'bot' : 's.whatsapp.net');
  const ordinal = nextOrdinal(state);
  let category = 'user';
  if (domain === 'g.us') category = 'group';
  else if (domain === 'lid') category = 'participant';
  else if (domain === 'bot' || key.includes('bot')) category = 'bot';
  else if (value === '0' || value === '0@s.whatsapp.net') category = 'system';
  let local = `synthetic-${category}-${ordinal}`;
  if (domain === 'g.us' && /-\d+@g\.us$/i.test(value)) local += '-1700000000';
  const deviceSeparator = separator >= 0 ? value.slice(0, separator).lastIndexOf(':') : -1;
  const device = deviceSeparator >= 0 ? ':0' : '';
  return `${local}${device}@${domain}`;
}

function sanitizeIdentifier(key: string, value: unknown, state: SanitizerState): unknown {
  if (isEmptyValue(value)) return value;
  const label = key.replace(/_/g, '-');
  return `synthetic-${label}-${nextOrdinal(state)}`;
}

function sanitizeTimestamp(key: string, value: unknown): unknown {
  const millisecondScale = typeof value === 'string' && (value.replace(/\D/g, '').length >= 13 || key.endsWith('_ts'));
  if (typeof value === 'number') return millisecondScale ? 1_700_000_000_000 : 1_700_000_000;
  if (typeof value === 'string') return millisecondScale ? '1700000000000' : '1700000000';
  return value;
}

function sanitizeValue(value: unknown, path: PathSegment[], state: SanitizerState): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const sanitized = sanitizeValue(item, [...path, index], state);
      return sanitized === SKIP ? null : sanitized;
    });
  }
  if (!isObject(value)) return value;

  const sanitized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const normalizedKey = normalizeKey(key);

    if (isCoordinateKey(normalizedKey)) continue;
    if (isMessageTextKey(normalizedKey)) {
      sanitized[key] = emptyLike(child);
      continue;
    }
    if (isPhoneKey(normalizedKey)) {
      sanitized[key] = emptyLike(child);
      continue;
    }
    if (normalizedKey === 'vcard') {
      sanitized[key] = emptyLike(child);
      continue;
    }
    if (isUrlKey(normalizedKey) || isOpaqueMediaKey(normalizedKey)) {
      sanitized[key] = emptyLike(child);
      continue;
    }
    if (isCryptoKey(normalizedKey, child) || DEVICE_PRIVATE_KEYS.has(normalizedKey)) {
      sanitized[key] = emptyLike(child);
      continue;
    }
    if (isNameKey(normalizedKey)) {
      sanitized[key] = sanitizeName(normalizedKey, child, state);
      continue;
    }
    if (isIdentifierKey(normalizedKey)) {
      sanitized[key] = sanitizeIdentifier(normalizedKey, child, state);
      continue;
    }
    if (isJidKey(normalizedKey) && Array.isArray(child)) {
      sanitized[key] = child.map(item => typeof item === 'string' ? sanitizeJid(normalizedKey, item, state) : sanitizeValue(item, childPath, state));
      continue;
    }
    if ((isJidKey(normalizedKey) && typeof child === 'string') || (typeof child === 'string' && isJidLike(child))) {
      sanitized[key] = sanitizeJid(normalizedKey, child, state);
      continue;
    }
    if (normalizedKey === 'sequence_number') {
      sanitized[key] = typeof child === 'number' ? 1 : '1';
      continue;
    }
    if (isTimestampKey(normalizedKey)) {
      sanitized[key] = sanitizeTimestamp(normalizedKey, child);
      continue;
    }

    const nested = sanitizeValue(child, childPath, state);
    if (nested !== SKIP) sanitized[key] = nested;
  }
  return sanitized;
}

export function sanitizeWhatsAppFixture<T>(fixture: T): T {
  return sanitizeValue(fixture, [], { ordinal: 0 }) as T;
}

function addViolation(
  violations: FixtureSafetyViolation[],
  path: readonly PathSegment[],
  rule: FixtureSafetyRule,
  reason: string,
): void {
  violations.push({ path: formatPath(path), rule, reason });
}

function validateValue(
  value: unknown,
  path: PathSegment[],
  violations: FixtureSafetyViolation[],
  parentKey = '',
): void {
  if (value === null) return;
  if (typeof value === 'string') {
    if (/BEGIN:VCARD/i.test(value)) addViolation(violations, path, 'vcard', 'vCard content is not allowed');
    if (looksLikeUrl(value, parentKey)) addViolation(violations, path, 'url', 'URLs are not allowed');
    if (!isStructuralNumberKey(parentKey) && isPhoneLike(value)) {
      addViolation(violations, path, 'phone-shaped-id', 'Phone-shaped values are not allowed');
    }
    if (isJidLike(value) && !isSyntheticJid(value)) {
      const rule = isPhoneLike(jidLocalPart(value)) ? 'phone-shaped-id' : 'unsafe-jid';
      addViolation(violations, path, rule, 'JIDs and LIDs must be explicitly synthetic');
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      addViolation(violations, path, 'structure', 'Fixture numbers must be finite');
    } else if (!isStructuralNumberKey(parentKey) && isPhoneLike(String(value))) {
      addViolation(violations, path, 'phone-shaped-id', 'Phone-shaped values are not allowed');
    }
    return;
  }
  if (typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateValue(item, [...path, index], violations, parentKey));
    return;
  }
  if (!isObject(value)) {
    addViolation(violations, path, 'structure', 'Fixture values must be JSON-compatible');
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const normalizedKey = normalizeKey(key);

    if (isCoordinateKey(normalizedKey)) {
      addViolation(violations, childPath, 'coordinates', 'Coordinate fields are not allowed');
      continue;
    }
    if (isMessageTextKey(normalizedKey) && !isEmptyValue(child)) {
      addViolation(violations, childPath, 'message-text', 'Message text must be empty');
      continue;
    }
    if (isPhoneKey(normalizedKey) && !isEmptyValue(child)) {
      addViolation(violations, childPath, 'phone-shaped-id', 'Phone number fields must be empty');
      continue;
    }
    if (normalizedKey === 'vcard' && !isEmptyValue(child)) {
      addViolation(violations, childPath, 'vcard', 'vCard values must be empty');
      continue;
    }
    if (isUrlKey(normalizedKey) && !isEmptyValue(child)) {
      addViolation(violations, childPath, 'url', 'URL and signed-path fields must be empty');
      continue;
    }
    if (isOpaqueMediaKey(normalizedKey) && !isEmptyValue(child)) {
      addViolation(violations, childPath, 'media-metadata', 'Opaque media metadata must be empty');
      continue;
    }
    if (isCryptoKey(normalizedKey, child) && !isEmptyValue(child)) {
      addViolation(violations, childPath, 'crypto-key-or-secret', 'Crypto, key, token, and secret fields must be empty');
      continue;
    }
    if (DEVICE_PRIVATE_KEYS.has(normalizedKey) && !isEmptyValue(child)) {
      addViolation(violations, childPath, 'media-metadata', 'Device metadata values must be empty');
      continue;
    }
    if (isNameKey(normalizedKey) && !isEmptyValue(child)) {
      const synthetic = typeof child === 'string' && isSyntheticName(child);
      if (!synthetic) addViolation(violations, childPath, 'unsafe-name', 'Names and filenames must be explicitly synthetic');
      if (typeof child === 'string' && looksLikeUrl(child, normalizedKey)) {
        addViolation(violations, childPath, 'url', 'URLs are not allowed');
      }
      continue;
    }
    if (isIdentifierKey(normalizedKey) && !isEmptyValue(child)) {
      if ((typeof child === 'string' || typeof child === 'number') && isPhoneLike(String(child))) {
        addViolation(violations, childPath, 'phone-shaped-id', 'Phone-shaped identifiers are not allowed');
      } else if (typeof child !== 'string' || !isSyntheticIdentifier(child)) {
        addViolation(violations, childPath, 'unsafe-identifier', 'Message identifiers must be explicitly synthetic');
      }
      continue;
    }
    if (isJidKey(normalizedKey) && !isEmptyValue(child) && !Array.isArray(child)) {
      if (typeof child === 'string' && (isPhoneLike(child) || isPhoneLike(jidLocalPart(child)))) {
        addViolation(violations, childPath, 'phone-shaped-id', 'Phone-shaped JIDs and LIDs are not allowed');
      } else if (typeof child !== 'string' || !isSyntheticJid(child)) {
        addViolation(violations, childPath, 'unsafe-jid', 'JIDs and LIDs must be explicitly synthetic');
      }
      continue;
    }

    validateValue(child, childPath, violations, normalizedKey);
  }
}

export function validateWhatsAppFixture(fixture: unknown): FixtureSafetyViolation[] {
  const violations: FixtureSafetyViolation[] = [];
  if (!isObject(fixture)) {
    addViolation(violations, [], 'structure', 'A WhatsApp fixture must be a JSON object');
    return violations;
  }
  validateValue(fixture, [], violations);
  return violations.sort((left, right) => left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule));
}

export function assertSafeWhatsAppFixture(fixture: unknown, source = 'WhatsApp fixture'): void {
  const violations = validateWhatsAppFixture(fixture);
  if (violations.length === 0) return;
  const summary = violations.map(({ path, rule }) => `${path} (${rule})`).join(', ');
  throw new Error(`Unsafe ${source}: ${summary}`);
}

export function validateWhatsAppFixtureJson(json: string, source = 'WhatsApp fixture'): FixtureSafetyViolation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [{ path: '$', rule: 'structure', reason: `${source} is not valid JSON` }];
  }
  return validateWhatsAppFixture(parsed);
}

export function assertSafeWhatsAppFixtureJson(json: string, source = 'WhatsApp fixture'): void {
  const violations = validateWhatsAppFixtureJson(json, source);
  if (violations.length === 0) return;
  const summary = violations.map(({ path, rule }) => `${path} (${rule})`).join(', ');
  throw new Error(`Unsafe ${source}: ${summary}`);
}

export function assertSafeWhatsAppFixtureFile(path: string): void {
  assertSafeWhatsAppFixtureJson(readFileSync(path, 'utf8'), path);
}
