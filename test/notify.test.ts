import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicateNotification, notify } from '../src/notify.js';

describe('isDuplicateNotification', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');

  it('suppresses the same reason within the 24h window', () => {
    const recent = new Date(now - 60 * 60 * 1000).toISOString();
    assert.equal(isDuplicateNotification(recent, 'consent_expiring', 'consent_expiring', now), true);
  });

  it('does not suppress a different reason inside the window', () => {
    const recent = new Date(now - 60 * 60 * 1000).toISOString();
    assert.equal(isDuplicateNotification(recent, 'consent_expiring', 'consent_expired', now), false);
  });

  it('does not suppress once the window has passed', () => {
    const old = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    assert.equal(isDuplicateNotification(old, 'consent_expiring', 'consent_expiring', now), false);
  });

  it('does not suppress when there is no previous notification', () => {
    assert.equal(isDuplicateNotification(undefined, undefined, 'consent_expiring', now), false);
  });

  it('does not suppress an unparseable timestamp', () => {
    assert.equal(isDuplicateNotification('not-a-date', 'consent_expiring', 'consent_expiring', now), false);
  });
});

describe('notify', () => {
  it('reports handled when no backend is configured', async () => {
    const prevNtfy = process.env.NTFY_URL;
    const prevHa = process.env.HA_WEBHOOK_URL;
    delete process.env.NTFY_URL;
    delete process.env.HA_WEBHOOK_URL;
    try {
      assert.equal(await notify({ title: 't', message: 'm' }), true);
    } finally {
      if (prevNtfy !== undefined) process.env.NTFY_URL = prevNtfy;
      if (prevHa !== undefined) process.env.HA_WEBHOOK_URL = prevHa;
    }
  });
});
