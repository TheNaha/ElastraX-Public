/**
 * Sanitize an error message by replacing control characters with spaces.
 * Prevents terminal control-sequence injection and log-injection via
 * error strings that may contain raw newlines, escape codes, or other
 * non-printable bytes from provider APIs.
 */
export function sanitizeErrorMessage(text: string, maxLength = 500): string {
  const sanitized = Array.from(text, character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
  return sanitized.slice(0, maxLength);
}

/**
 * Extract a safe, sanitized error message from an unknown value.
 * Used by providers and DB utilities that surface errors to users or logs.
 */
export function safeErrorMessage(error: unknown, maxLength = 500): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeErrorMessage(raw, maxLength);
}

export function getErrorMessage(error: unknown, fallback: string = 'Unknown error'): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}
