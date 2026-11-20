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

/**
 * Whether a host is a *literal* address on a private network.
 *
 * Only literals are classified, never DNS names: a name can resolve anywhere, so
 * treating it as private at validation time would be a guess. The ranges are the
 * ones a self-hosted service actually sits on — RFC 1918, IPv6 ULA, link-local,
 * and the 100.64.0.0/10 shared/CGNAT block that Tailscale and carrier NATs use.
 *
 * This exists so `http://192.168.1.10:8080/v1` does not need an operator opt-out
 * to start, while `http://api.example.com/v1` still does.
 */
export function isPrivateHost(host: string): boolean {
  const name = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!name) return false;
  if (isLoopbackHost(name)) return true;

  // IPv4-mapped IPv6 (`::ffff:192.168.1.5`) keeps the v4 rules.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(name);
  if (mapped?.[1] && isPrivateIpv4(mapped[1])) return true;

  if (name.includes(':')) {
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{0,2}:/.test(name)) return true;
    return /^fe[89ab][0-9a-f]?:/.test(name);
  }
  return isPrivateIpv4(name);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10: shared address space (CGNAT, Tailscale). Note this ends at
  // 100.127.255.255 — 100.150.x.x is a *public* address and is not covered.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
