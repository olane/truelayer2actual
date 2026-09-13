import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCsrfSecret,
  createCsrfToken,
  isCsrfTokenValid,
  isLoopbackHostname,
  parseOriginHostname,
  originAllowed,
} from '../src/web/csrf.js';

describe('createCsrfToken', () => {
  it('is stable per secret and differs across secrets', () => {
    const a = createCsrfToken('secret-a');
    const b = createCsrfToken('secret-a');
    const c = createCsrfToken('secret-b');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('produces a random-looking hex token', () => {
    const token = createCsrfToken(generateCsrfSecret());
    assert.match(token, /^[0-9a-f]{64}$/);
  });
});

describe('isCsrfTokenValid', () => {
  const secret = generateCsrfSecret();

  it('accepts the token produced for the secret', () => {
    assert.equal(isCsrfTokenValid(secret, createCsrfToken(secret)), true);
  });

  it('rejects missing, empty, and wrong tokens', () => {
    assert.equal(isCsrfTokenValid(secret, undefined), false);
    assert.equal(isCsrfTokenValid(secret, ''), false);
    assert.equal(isCsrfTokenValid(secret, 'not-a-token'), false);
    assert.equal(isCsrfTokenValid(secret, 12345), false);
  });
});

describe('isLoopbackHostname', () => {
  it('recognises loopback hosts regardless of case or brackets', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1']) {
      assert.equal(isLoopbackHostname(host), true, host);
    }
  });

  it('rejects non-loopback hosts', () => {
    for (const host of ['example.com', 'attacker.com', '192.168.1.10']) {
      assert.equal(isLoopbackHostname(host), false, host);
    }
  });
});

describe('parseOriginHostname', () => {
  it('extracts the hostname from a valid origin', () => {
    assert.equal(parseOriginHostname('https://truelayer.example.com'), 'truelayer.example.com');
    assert.equal(parseOriginHostname('http://localhost:3000'), 'localhost');
  });

  it('returns null for malformed or null origins', () => {
    assert.equal(parseOriginHostname('null'), null);
    assert.equal(parseOriginHostname('not a url'), null);
  });
});

describe('originAllowed', () => {
  const allowed = new Set(['truelayer.example.com']);

  it('rejects missing, null, and malformed origins', () => {
    assert.equal(originAllowed(undefined, allowed), false);
    assert.equal(originAllowed('null', allowed), false);
    assert.equal(originAllowed('::::', allowed), false);
  });

  it('allows loopback origins without configuration', () => {
    assert.equal(originAllowed('http://localhost:3000', new Set()), true);
    assert.equal(originAllowed('http://127.0.0.1:3000', new Set()), true);
  });

  it('allows configured hostnames and rejects everything else', () => {
    assert.equal(originAllowed('https://truelayer.example.com', allowed), true);
    assert.equal(originAllowed('HTTPS://TRUELAYER.EXAMPLE.COM', allowed), true);
    assert.equal(originAllowed('https://attacker.com', allowed), false);
  });
});
