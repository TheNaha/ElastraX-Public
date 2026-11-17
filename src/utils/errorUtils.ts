/**
 * Replace control characters (and DEL) in `text` with `replacement`.
 * Prevents terminal control-sequence injection and log-injection via strings
 * that may contain raw newlines, escape codes, or other non-printable bytes
 * from provider APIs. Both `sanitizeErrorMessage` and filename sanitizers
 * share this idiom so the control-character policy lives in one place.
 */
export function stripControlChars(text: string, replacement = ' '): string {
  return Array.from(text, character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? replacement : character;
  }).join('');
}

/**
 * Sanitize an error message by replacing control characters with spaces.
 * Prevents terminal control-sequence injection and log-injection via
 * error strings that may contain raw newlines, escape codes, or other
 * non-printable bytes from provider APIs.
 */
export function sanitizeErrorMessage(text: string, maxLength = 500): string {
  return stripControlChars(text, ' ').slice(0, maxLength);
}

/**
 * Extract a safe, sanitized error message from an unknown value.
 * Used by providers and DB utilities that surface errors to users or logs.
 */
export function safeErrorMessage(error: unknown, maxLength = 500): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeErrorMessage(raw, maxLength);
}

/** Coerce an unknown value to an Error, preserving real Errors as-is. */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

/**
 * True when a SQLite error is a UNIQUE / PRIMARY KEY constraint violation.
 *
 * Callers use it to recover from a lost read-then-insert race: the row now
 * exists, so the insert can be retried as an update instead of surfacing a 500.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  // Deliberately narrow: a bare /constraint failed/i also matched NOT NULL and
  // CHECK violations, which no amount of "someone else created it" recovery can
  // fix - the caller's update then matched zero rows and logged a false success.
  return /unique constraint failed|primary key|already exists|duplicate key/i.test(getErrorMessage(error));
}
