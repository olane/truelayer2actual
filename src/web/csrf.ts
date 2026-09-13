import crypto from 'crypto';

/**
 * CSRF + request-origin hardening for the dashboard's state-changing routes.
 *
 * The dashboard has no session/auth of its own, so the CSRF token is a single
 * per-process HMAC derived from a random secret: unguessable across restarts
 * and unreadable cross-origin, which is what matters for a self-hosted
 * single-user service. Origin checks compare against a fixed allowlist rather
 * than the request `Host` header, which a DNS-rebinding attacker controls.
 */

export function generateCsrfSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createCsrfToken(secret: string): string {
  return crypto.createHmac('sha256', secret).update('truelayer2actual:csrf').digest('hex');
}

export function isCsrfTokenValid(secret: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const expected = createCsrfToken(secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Loopback hosts are always allowed: DNS rebinding never presents as these. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function parseOriginHostname(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * Accept an Origin only when it is a loopback host or one of the explicitly
 * configured hostnames. Missing, malformed, and `null` origins are rejected so
 * state-changing POSTs can never be driven cross-origin (including via DNS
 * rebinding, where the browser's Origin reflects the attacker's hostname).
 */
export function originAllowed(
  origin: string | undefined,
  allowedHostnames: ReadonlySet<string>
): boolean {
  if (!origin) return false;
  const hostname = parseOriginHostname(origin);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  return allowedHostnames.has(hostname.toLowerCase());
}
