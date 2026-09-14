import { utils } from '@actual-app/api';
import type { TrueLayerTransaction } from './clients/truelayer.js';
import type { ActualTransaction } from './clients/actual.js';

export type { ActualTransaction };

export function mapTransaction(t: TrueLayerTransaction, isCard = false): ActualTransaction {
  // Extract date portion from ISO 8601 timestamp
  const date = t.timestamp.split('T')[0];

  // TrueLayer returns card purchases as positive amounts (charges to the card),
  // but Actual expects negative amounts for a credit card account (increasing liability).
  const rawAmount = isCard ? -t.amount : t.amount;
  const amount = utils.amountToInteger(rawAmount);

  // Prefer merchant_name, fall back to description
  const payee_name = t.merchant_name ?? t.description;

  // Status is 'booked' | 'pending' when present; anything else counts as cleared.
  const cleared = t.status === undefined ? true : t.status === 'booked';

  return {
    date,
    amount,
    payee_name,
    notes: t.description,
    imported_id: t.transaction_id,
    cleared,
  };
}
