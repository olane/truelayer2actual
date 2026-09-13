import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { editPairingsPage } from '../src/web/pages.js';
import type { BudgetAccounts } from '../src/web/pages.js';

const budgetAccounts: BudgetAccounts[] = [
  {
    budget: { id: 'b1', name: 'Personal', syncId: 's1' },
    accounts: [{ id: 'a1', name: 'Current', offbudget: false, closed: false }],
  },
  {
    budget: { id: 'b2', name: 'Joint', syncId: 's2' },
    accounts: [{ id: 'a2', name: 'Joint Current', offbudget: false, closed: false }],
  },
];

describe('editPairingsPage', () => {
  it('pre-selects the saved budget and account', () => {
    const html = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      rows: [
        {
          truelayerAccountId: 'tl1',
          name: 'Bank',
          accountKind: 'account',
          currency: 'GBP',
          mapped: true,
          budgetId: 'b2',
          actualAccountId: 'a2',
        },
      ],
      budgetAccounts,
    });

    assert.match(html, /value="b2" selected/);
    assert.match(html, /value="a2" data-budget="b2" selected/);
    assert.match(html, /— remove mapping —/);
  });

  it('offers "do not sync" for an unmapped account', () => {
    const html = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      rows: [
        {
          truelayerAccountId: 'tl2',
          name: 'Savings',
          accountKind: 'account',
          currency: 'GBP',
          mapped: false,
        },
      ],
      budgetAccounts,
    });

    assert.match(html, /— do not sync —/);
    assert.doesNotMatch(html, /— remove mapping —/);
  });

  it('keeps an unavailable mapping selected instead of silently dropping it', () => {
    const html = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      rows: [
        {
          truelayerAccountId: 'tl1',
          name: 'Bank',
          accountKind: 'account',
          currency: 'GBP',
          mapped: true,
          budgetId: 'b9',
          actualAccountId: 'a9',
        },
      ],
      budgetAccounts,
    });

    assert.match(html, /value="b9" selected/);
    assert.match(html, /value="a9" data-budget="b9" selected/);
    assert.match(html, /unavailable/);
  });

  it('carries the TrueLayer name/kind/currency so a new pairing can be saved', () => {
    const html = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      rows: [
        {
          truelayerAccountId: 'tl3',
          name: 'Credit Card',
          accountKind: 'card',
          currency: 'GBP',
          mapped: false,
        },
      ],
      budgetAccounts,
    });

    assert.match(html, /name="name_tl3" value="Credit Card"/);
    assert.match(html, /name="kind_tl3" value="card"/);
    assert.match(html, /name="currency_tl3" value="GBP"/);
  });
});
