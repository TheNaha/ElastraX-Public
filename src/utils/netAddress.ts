/**
 * @file src/utils/netAddress.ts
 * @description Host classification shared by the admin dashboard and the
 *              environment validators.
 *
 * `isLoopbackHost` existed twice — once in `src/admin/auth.ts` and once
 * (private) in `src/config/env.ts` — with slightly different rules: the admin
 * copy stripped a trailing dot and IPv6 brackets, the env copy did not. A fix to
 * one therefore did not reach the other.
 */

/** Whether a host (or hostname) names the local machine. */
export function isLoopbackHost(host: string): boolean {
  const name = String(host ?? '')
    .trim()
    .toLowerCase()
    // WHATWG `URL.hostname` keeps an IPv6 literal's brackets, and fully
    // qualified names may carry a trailing dot (`localhost.`).
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return name === 'localhost' || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name);
}
