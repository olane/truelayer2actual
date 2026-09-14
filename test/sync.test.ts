import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSyncWindow,
  syncLookbackDays,
  resolveIntervalHours,
} from '../src/commands/sync.js';

describe('resolveSyncWindow', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');

  it('looks back the full window when there is no previous sync', () => {
    const { from, to } = resolveSyncWindow(undefined, 7, now);
    assert.equal(from, '2026-06-08');
    assert.equal(to, '2026-06-15');
  });

  it('extends further back than the window when the last sync is older', () => {
    const { from } = resolveSyncWindow('2026-06-01T00:00:00Z', 7, now);
    assert.equal(from, '2026-06-01');
  });

  it('clamps to the window when the last sync is more recent', () => {
    const { from } = resolveSyncWindow('2026-06-12T08:00:00Z', 7, now);
    assert.equal(from, '2026-06-08');
  });

  it('works entirely in UTC regardless of the time of day', () => {
    const lateUtc = Date.parse('2026-06-15T23:30:00Z');
    const { from, to } = resolveSyncWindow(undefined, 1, lateUtc);
    assert.equal(from, '2026-06-14');
    assert.equal(to, '2026-06-15');
  });
});

describe('syncLookbackDays', () => {
  function withEnv<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.SYNC_DAYS_LOOKBACK;
    if (value === undefined) delete process.env.SYNC_DAYS_LOOKBACK;
    else process.env.SYNC_DAYS_LOOKBACK = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.SYNC_DAYS_LOOKBACK;
      else process.env.SYNC_DAYS_LOOKBACK = prev;
    }
  }

  it('defaults to 7 when unset or blank', () => {
    assert.equal(withEnv(undefined, syncLookbackDays), 7);
    assert.equal(withEnv('', syncLookbackDays), 7);
  });

  it('falls back to 7 for invalid or negative values', () => {
    assert.equal(withEnv('abc', syncLookbackDays), 7);
    assert.equal(withEnv('-1', syncLookbackDays), 7);
  });

  it('parses a valid value and floors fractions', () => {
    assert.equal(withEnv('30', syncLookbackDays), 30);
    assert.equal(withEnv('3.7', syncLookbackDays), 3);
  });
});

describe('resolveIntervalHours', () => {
  function withEnv<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.SYNC_INTERVAL_HOURS;
    if (value === undefined) delete process.env.SYNC_INTERVAL_HOURS;
    else process.env.SYNC_INTERVAL_HOURS = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.SYNC_INTERVAL_HOURS;
      else process.env.SYNC_INTERVAL_HOURS = prev;
    }
  }

  it('treats unset, blank and zero as one-shot', () => {
    assert.equal(withEnv(undefined, resolveIntervalHours), 0);
    assert.equal(withEnv('', resolveIntervalHours), 0);
    assert.equal(withEnv('0', resolveIntervalHours), 0);
  });

  it('falls back to one-shot for invalid or negative values', () => {
    assert.equal(withEnv('abc', resolveIntervalHours), 0);
    assert.equal(withEnv('-2', resolveIntervalHours), 0);
  });

  it('parses a positive interval', () => {
    assert.equal(withEnv('6', resolveIntervalHours), 6);
    assert.equal(withEnv('2.5', resolveIntervalHours), 2.5);
  });
});
