import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeAccounts,
  normalizeBudgets,
  reconcileConfigAccounts,
  type Account,
  type Config,
} from '../src/config.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    budgets: [],
    accounts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    name: 'Acct',
    connectionId: 'old',
    budgetId: 'default',
    accountKind: 'account',
    truelayerAccountId: 'tl-1',
    actualAccountId: 'actual-1',
    currency: 'GBP',
    ...overrides,
  };
}

describe('mergeAccounts', () => {
  it('updates the pairing but preserves lastSyncedAt', () => {
    const existing = [account({ lastSyncedAt: '2026-01-01T00:00:00.000Z' })];
    const incoming = [account({ actualAccountId: 'actual-2' })];

    const merged = mergeAccounts(existing, incoming);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].actualAccountId, 'actual-2');
    assert.equal(merged[0].lastSyncedAt, '2026-01-01T00:00:00.000Z');
  });

  it('carries the incoming budgetId into a merged account', () => {
    const existing = [account({ budgetId: 'default' })];
    const incoming = [account({ budgetId: 'budget_123' })];

    const merged = mergeAccounts(existing, incoming);

    assert.equal(merged[0].budgetId, 'budget_123');
  });

  it('appends accounts that are not already mapped', () => {
    const existing = [account()];
    const incoming = [account({ truelayerAccountId: 'tl-2', actualAccountId: 'actual-2' })];

    const merged = mergeAccounts(existing, incoming);

    assert.equal(merged.length, 2);
    assert.equal(merged[1].truelayerAccountId, 'tl-2');
  });
});

describe('reconcileConfigAccounts', () => {
  it('repoints accounts from the previous connection, preserving everything else', () => {
    const accounts = [
      account({ connectionId: 'old', lastSyncedAt: '2026-01-01T00:00:00.000Z' }),
    ];

    const result = reconcileConfigAccounts(accounts, {
      newConnectionId: 'new',
      remapFrom: 'old',
      fetchedIds: new Set(['tl-1']),
    });

    assert.equal(result.changed, true);
    assert.equal(result.accounts[0].connectionId, 'new');
    assert.equal(result.accounts[0].lastSyncedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(result.accounts[0].actualAccountId, 'actual-1');
    assert.deepEqual(result.missing, []);
  });

  it('reports accounts not returned by consent but keeps and repoints them', () => {
    const accounts = [
      account({ connectionId: 'old', truelayerAccountId: 'tl-gone' }),
    ];

    const result = reconcileConfigAccounts(accounts, {
      newConnectionId: 'new',
      remapFrom: 'old',
      fetchedIds: new Set(),
    });

    assert.equal(result.missing.length, 1);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].connectionId, 'new');
  });

  it('leaves other banks untouched when adding a brand-new connection', () => {
    const accounts = [
      account({ connectionId: 'other', truelayerAccountId: 'tl-other' }),
    ];

    const result = reconcileConfigAccounts(accounts, {
      newConnectionId: 'new',
      fetchedIds: new Set(['tl-new']),
    });

    assert.equal(result.changed, false);
    assert.equal(result.accounts[0].connectionId, 'other');
    assert.deepEqual(result.missing, []);
  });
});

describe('normalizeBudgets', () => {
  it('seeds the env default when no budgets are configured', () => {
    const previous = process.env.ACTUAL_SYNC_ID;
    process.env.ACTUAL_SYNC_ID = 'sync-default';
    try {
      const data = config({ accounts: [account()] });
      const result = normalizeBudgets(data);
      assert.deepEqual(
        result.budgets.map((b) => [b.id, b.syncId]),
        [['default', 'sync-default']]
      );
    } finally {
      if (previous === undefined) delete process.env.ACTUAL_SYNC_ID;
      else process.env.ACTUAL_SYNC_ID = previous;
    }
  });

  it('reuses a configured budget that already has the env sync id', () => {
    const previous = process.env.ACTUAL_SYNC_ID;
    process.env.ACTUAL_SYNC_ID = 'sync-shared';
    try {
      const data = config({
        budgets: [{ id: 'budget_joint', name: 'Joint', syncId: 'sync-shared' }],
        accounts: [account({ budgetId: 'default' })],
      });

      const result = normalizeBudgets(data);

      // No synthesized "Default" duplicate; the account follows the budget.
      assert.equal(result.budgets.length, 1);
      assert.equal(result.budgets[0].id, 'budget_joint');
      assert.equal(result.accounts[0].budgetId, 'budget_joint');
    } finally {
      if (previous === undefined) delete process.env.ACTUAL_SYNC_ID;
      else process.env.ACTUAL_SYNC_ID = previous;
    }
  });

  it('collapses budgets that resolve to the same Actual budget', () => {
    const data = config({
      budgets: [
        { id: 'budget_a', name: 'Default', syncId: 'sync-shared' },
        { id: 'budget_b', name: 'Joint', syncId: 'sync-shared' },
        { id: 'budget_c', name: 'Other', syncId: 'sync-other' },
      ],
      accounts: [account({ budgetId: 'budget_a' })],
    });

    const result = normalizeBudgets(data);

    assert.deepEqual(
      result.budgets.map((b) => b.id),
      ['budget_b', 'budget_c']
    );
    assert.equal(result.accounts[0].budgetId, 'budget_b');
  });
});
