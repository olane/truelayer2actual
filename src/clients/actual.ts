import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as api from '@actual-app/api';
import { logger } from '../logger.js';

const CACHE_DIR = path.join(process.cwd(), 'data', 'actual-cache');

// ---------------------------------------------------------------------------
// Serialised access to the Actual Budget API.
//
// @actual-app/api keeps a single in-process cache and a single "current"
// budget, so the sync scheduler and the web pairing UI must never touch it
// concurrently, and switching budgets means re-downloading the target budget.
// Every call goes through `withBudget`, which chains onto a promise queue.
// ---------------------------------------------------------------------------

/** The subset of a configured budget that the Actual client cares about. */
export interface ActualBudgetRef {
  syncId: string;
  encryptionPassword?: string;
}

let serverReady = false;
let activeSyncId: string | null = null;
let actualQueue: Promise<unknown> = Promise.resolve();
let lastActualError: string | null = null;

export class ActualCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActualCompatibilityError';
  }
}

/** Last error from initialising Actual, surfaced via /healthz. */
export function getActualError(): string | null {
  return lastActualError;
}

async function initServer(): Promise<void> {
  const serverUrl = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;

  if (!serverUrl || !password) {
    throw new Error('ACTUAL_SERVER_URL and ACTUAL_PASSWORD must both be set.');
  }

  logger.info(`Initialising Actual Budget at ${serverUrl}...`);

  try {
    await (api as unknown as { init: (opts: Record<string, unknown>) => Promise<void> }).init({
      dataDir: CACHE_DIR,
      serverURL: serverUrl,
      password,
    });
    serverReady = true;
  } catch (err) {
    logger.error(
      'Actual init error (full):',
      JSON.stringify(err, Object.getOwnPropertyNames(err as object))
    );
    throw new Error(
      `Failed to initialise Actual Budget: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function downloadBudget(syncId: string, encryptionPassword?: string): Promise<void> {
  try {
    if (encryptionPassword) {
      await (api as unknown as {
        downloadBudget: (id: string, opts: { password: string }) => Promise<void>;
      }).downloadBudget(syncId, { password: encryptionPassword });
    } else {
      await (api as unknown as {
        downloadBudget: (id: string) => Promise<void>;
      }).downloadBudget(syncId);
    }
    logger.debug(`Actual Budget budget ${syncId} downloaded successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('out-of-sync-migrations') || message.includes('migration')) {
      throw new ActualCompatibilityError(
        'Actual Budget schema is out of sync. ' +
          'Open Actual Budget in your browser, let it migrate, then retry.'
      );
    }
    throw new Error(`Failed to download Actual Budget budget ${syncId}: ${message}`);
  }
}

async function ensureServer(): Promise<void> {
  if (serverReady) return;

  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logger.debug(`Created Actual cache directory: ${CACHE_DIR}`);
  }

  await initServer();
}

/** Make `budget` the current budget, initialising the server on first use. */
export async function switchBudget(budget: ActualBudgetRef): Promise<void> {
  try {
    await ensureServer();
    if (activeSyncId !== budget.syncId) {
      await downloadBudget(budget.syncId, budget.encryptionPassword);
      activeSyncId = budget.syncId;
    }
    lastActualError = null;
  } catch (err) {
    // `downloadBudget` mutates the process-global "current budget" before it
    // can reject: it closes whatever is loaded, and when the target is already
    // in the local cache it loads that budget before the remote sync that may
    // fail. `activeSyncId` no longer describes what Actual actually has loaded,
    // so forget it and force the next switch to re-establish the budget.
    activeSyncId = null;
    lastActualError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/**
 * Run `fn` with exclusive access after switching to `budget`. Errors do not
 * poison the queue.
 */
export function withBudget<T>(budget: ActualBudgetRef, fn: () => Promise<T>): Promise<T> {
  const run = actualQueue.then(async () => {
    await switchBudget(budget);
    return fn();
  });
  // Keep the chain alive regardless of outcome.
  actualQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export interface ActualAccount {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
}

export interface ActualTransaction {
  date: string;
  amount: number;
  payee_name?: string;
  notes?: string;
  imported_id: string;
  cleared: boolean;
}

export interface ImportResult {
  added: string[];
  updated: string[];
  errors?: string[];
}

export async function shutdownActual(): Promise<void> {
  const wasReady = serverReady;
  serverReady = false;
  activeSyncId = null;
  if (!wasReady) return;
  try {
    await (api as unknown as { shutdown: () => Promise<void> }).shutdown();
    logger.debug('Actual Budget shut down cleanly');
  } catch (err) {
    logger.warn(
      'Error during Actual Budget shutdown:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function getActualAccounts(): Promise<ActualAccount[]> {
  const accounts = await (api as unknown as {
    getAccounts: () => Promise<ActualAccount[]>;
  }).getAccounts();
  return accounts.filter((a) => !a.closed);
}

export async function importToActual(
  accountId: string,
  transactions: ActualTransaction[]
): Promise<ImportResult> {
  if (transactions.length === 0) {
    logger.debug(`No transactions to import for account ${accountId}`);
    return { added: [], updated: [] };
  }

  logger.debug(
    `Importing ${transactions.length} transaction(s) into Actual account ${accountId}`
  );

  const result = await (api as unknown as {
    importTransactions: (
      accountId: string,
      transactions: ActualTransaction[]
    ) => Promise<ImportResult>;
  }).importTransactions(accountId, transactions);

  return result;
}

export async function getActualAccountBalance(accountId: string): Promise<number> {
  return (api as unknown as {
    getAccountBalance: (accountId: string) => Promise<number>;
  }).getAccountBalance(accountId);
}

export async function getActualTransactions(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<ActualTransaction[]> {
  const transactions = await (api as unknown as {
    getTransactions: (
      accountId: string,
      startDate: string,
      endDate: string
    ) => Promise<ActualTransaction[]>;
  }).getTransactions(accountId, startDate, endDate);

  return transactions;
}
