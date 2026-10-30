# admin-dashboard Specification

## Purpose
Token-gated, read-mostly admin dashboard sharing the webhook server port, with session cookies that never carry the secret and CSRF tokens bound to the session.

## Requirements

### Requirement: Dashboard gated by 24-byte secret
The admin dashboard SHALL be disabled entirely unless `METRICS_AUTH_TOKEN` is a secret of at least 24 bytes; a shorter secret SHALL disable the surface and the bot SHALL keep running.

#### Scenario: Short secret disables dashboard
- **GIVEN** `METRICS_AUTH_TOKEN` is set but under 24 bytes
- **WHEN** the app boots
- **THEN** the dashboard stays disabled and no secret is ever sent

### Requirement: Secret never in cookie
The session cookie SHALL contain a random 24-byte session id and an HMAC of that id under the secret; the cookie value SHALL NEVER be the raw `METRICS_AUTH_TOKEN`.

#### Scenario: Cookie is not the secret
- **WHEN** an admin logs in
- **THEN** the `elastrax_admin` cookie value is `<id>.<hmac(id)>` and contains no raw secret

### Requirement: Cookie hardening
The session cookie SHALL be `HttpOnly` + `SameSite=Strict`, and `Secure` by default, downgradable to non-secure only for loopback HTTP requests.

#### Scenario: Secure cookie on local HTTP
- **GIVEN** the app is reached over plain HTTP on loopback
- **WHEN** login completes
- **THEN** the cookie's `Secure` attribute is omitted so a browser stores it

### Requirement: CSRF on mutable requests
Every mutating admin request SHALL require same-origin (Host/Origin match), a valid session cookie, AND an `x-admin-csrf` header matching the session's CSRF token.

#### Scenario: Cross-site mutation blocked
- **WHEN** a POST to /admin arrives without a matching CSRF header
- **THEN** it is rejected with 403

### Requirement: Login rate limiting
Login attempts SHALL be rate limited per IP to resist brute force.

#### Scenario: Brute force throttled
- **GIVEN** repeated failed logins from one IP
- **WHEN** the per-IP throttle trips
- **THEN** further login attempts are rejected until the window resets

### Requirement: Session TTL and cap
Sessions SHALL expire after 8 hours, and the live session set SHALL be capped at 32 entries, evicting the oldest when exceeded.

#### Scenario: Session cap evicts oldest
- **WHEN** 33 logins occur while 32 sessions are live
- **THEN** the oldest session is evicted

### Requirement: Config filtered by allowlist
Admin configuration endpoints SHALL return only allowlisted fields and SHALL NEVER return the shared secret or per-provider API keys.

#### Scenario: Secret not in config response
- **WHEN** an authenticated admin reads /admin/config
- **THEN** the response contains no `METRICS_AUTH_TOKEN` or provider keys

### Requirement: Strict CSP on UI
Admin UI HTML SHALL be served with a strict Content-Security-Policy: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.

#### Scenario: Inline script blocked
- **WHEN** the dashboard HTML contains an inline script
- **THEN** the browser's CSP blocks it
