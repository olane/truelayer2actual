import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../src/util/errors.js';

describe('describeError', () => {
  it('returns plain values as strings', () => {
    assert.equal(describeError('boom'), 'boom');
    assert.equal(describeError(42), '42');
    assert.equal(describeError(null), 'null');
  });

  it('includes the name when it is not a bare Error', () => {
    const err = new Error('nope');
    err.name = 'ActualCompatibilityError';
    assert.equal(describeError(err), 'ActualCompatibilityError: nope');
  });

  it('digs out Actual meta.reason and meta.error.message', () => {
    const err = {
      message: 'sync failed',
      meta: { reason: 'out-of-sync-migrations', error: { message: 'client too old' } },
    };
    const out = describeError(err);
    assert.match(out, /sync failed/);
    assert.match(out, /reason=out-of-sync-migrations/);
    assert.match(out, /client too old/);
  });

  it('includes an axios-style response body', () => {
    const out = describeError({ message: 'Request failed', response: { data: { error: 'invalid_grant' } } });
    assert.match(out, /invalid_grant/);
  });

  it('follows the cause chain', () => {
    const out = describeError(new Error('outer', { cause: new Error('inner') }));
    assert.match(out, /outer/);
    assert.match(out, /cause: inner/);
  });

  it('never throws on circular objects', () => {
    const circular: Record<string, unknown> = { message: 'loop' };
    circular.self = circular;
    assert.doesNotThrow(() => describeError(circular));
  });
});
