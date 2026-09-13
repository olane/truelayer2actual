import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshConnectionIfNeeded,
  ReauthRequiredError,
  type Tokens,
  type RefreshDeps,
} from '../src/auth/tokens.js';
import { resolveConnectionTokens } from '../src/commands/sync.js';

function expiredTokens(overrides: Partial<Tokens> = {}): Tokens {
  return {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function rejectingPost(payload: unknown): RefreshDeps['post'] {
  return (async () => {
    throw Object.assign(new Error('request failed'), {
      isAxiosError: true,
      response: payload,
    });
  }) as unknown as RefreshDeps['post'];
}

describe('refreshConnectionIfNeeded', () => {
  before(() => {
    process.env.TRUELAYER_CLIENT_ID = 'sandbox-test';
    process.env.TRUELAYER_CLIENT_SECRET = 'secret';
  });

  it('marks needsReauth and throws ReauthRequiredError instead of exiting', async () => {
    let saved: Tokens | undefined;
    const post = rejectingPost({ status: 401, data: { error: 'invalid_grant' } });

    await assert.rejects(
      () =>
        refreshConnectionIfNeeded('conn_test', expiredTokens(), {
          post,
          save: (_id, tokens) => {
            saved = tokens;
          },
        }),
      (err: unknown) => err instanceof ReauthRequiredError
    );

    assert.equal(saved?.needsReauth, true);
    assert.equal(saved?.reauthReason, 'refresh_token_invalid');
    assert.equal(saved?.accessToken, 'old-access');
  });

  it('does not flip needsReauth on a retryable 5xx', async () => {
    let saved: Tokens | undefined;
    const post = rejectingPost({ status: 503, data: { error: 'server_error' } });

    await assert.rejects(
      () =>
        refreshConnectionIfNeeded('conn_test', expiredTokens(), {
          post,
          save: (_id, tokens) => {
            saved = tokens;
          },
        }),
      (err: unknown) => !(err instanceof ReauthRequiredError)
    );

    assert.equal(saved, undefined);
  });

  it('persists refreshed tokens and preserves metadata', async () => {
    let saved: Tokens | undefined;
    const post = (async () => ({
      data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    })) as unknown as RefreshDeps['post'];

    const accessToken = await refreshConnectionIfNeeded(
      'conn_test',
      expiredTokens({ providerDisplayName: 'Monzo' }),
      {
        post,
        save: (_id, tokens) => {
          saved = tokens;
        },
      }
    );

    assert.equal(accessToken, 'new-access');
    assert.equal(saved?.refreshToken, 'new-refresh');
    assert.equal(saved?.providerDisplayName, 'Monzo');
    assert.equal(saved?.needsReauth, false);
  });
});

describe('resolveConnectionTokens', () => {
  it('continues past a connection requiring re-auth', async () => {
    const deps = {
      loadConnection: (id: string): Tokens => expiredTokens({ refreshToken: `r-${id}` }),
      refreshConnectionIfNeeded: async (id: string): Promise<string> => {
        if (id === 'conn_b') throw new ReauthRequiredError(id, 'dead refresh token');
        return `access-${id}`;
      },
    };

    const result = await resolveConnectionTokens(['conn_a', 'conn_b', 'conn_c'], deps);

    assert.deepEqual([...result.accessTokens.keys()], ['conn_a', 'conn_c']);
    assert.deepEqual(
      result.skipped.map((s) => s.connectionId),
      ['conn_b']
    );
    assert.equal(result.errors.length, 0);
  });

  it('records non-reauth failures as errors without aborting', async () => {
    const deps = {
      loadConnection: (id: string): Tokens => expiredTokens({ refreshToken: `r-${id}` }),
      refreshConnectionIfNeeded: async (id: string): Promise<string> => {
        if (id === 'conn_b') throw new Error('network down');
        return `access-${id}`;
      },
    };

    const result = await resolveConnectionTokens(['conn_a', 'conn_b'], deps);

    assert.deepEqual([...result.accessTokens.keys()], ['conn_a']);
    assert.equal(result.skipped.length, 0);
    assert.deepEqual(
      result.errors.map((e) => e.connectionId),
      ['conn_b']
    );
  });
});
