/**
 * A provider message id is only usable as an identity when the platform actually
 * supplied one. Providers substitute a placeholder (`'unknown'`) when the id is
 * missing, and the `messages_platform_provider_message_id_unique` index
 * deliberately excludes those placeholders — so comparing them would make every
 * placeholder row look like the current message.
 *
 * Kept in its own module so both the agent and the tests use one definition of
 * "real id" rather than re-deriving the placeholder list.
 */
export function isUsableProviderMessageId(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'unknown' && normalized !== 'null';
}
