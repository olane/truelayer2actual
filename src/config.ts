import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { logger } from './logger.js';
import { atomicWriteFile } from './util/fs.js';
import { withStateLock } from './util/lock.js';

/** Identifier used for the single legacy budget defined by env vars. */
export const DEFAULT_BUDGET_ID = 'default';

const BudgetSchema = z.object({
  id: z.string(),
  name: z.string(),
  syncId: z.string(),
  encryptionPassword: z.string().optional(),
});

const AccountSchema = z.object({
  name: z.string(),
  connectionId: z.string(),
  budgetId: z.string().default(DEFAULT_BUDGET_ID),
  accountKind: z.enum(['account', 'card']).default('account'),
  truelayerAccountId: z.string(),
  actualAccountId: z.string(),
  currency: z.string().default('GBP'),
  lastSyncedAt: z.string().optional(),
});

const ConfigSchema = z.object({
  budgets: z.array(BudgetSchema).default([]),
  accounts: z.array(AccountSchema),
  createdAt: z.string(),
});

export type Budget = z.infer<typeof BudgetSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_PATH = path.join(process.cwd(), 'data', 'config.json');

/**
 * Build the single "default" budget from the legacy environment variables.
 * Returns `null` when no legacy sync id is configured.
 */
export function budgetFromEnv(): Budget | null {
  const syncId = process.env.ACTUAL_SYNC_ID;
  if (!syncId) return null;
  return {
    id: DEFAULT_BUDGET_ID,
    name: 'Default',
    syncId,
    encryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD || undefined,
  };
}

export function generateBudgetId(): string {
  return `budget_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Normalise a parsed config so legacy files keep working: seed a "default"
 * budget from env vars when none are defined, and make sure any account that
 * still references the default budget id has a matching budget to point at.
 *
 * The Actual sync id identifies a budget, so two entries with the same sync id
 * are collapsed to one. Without this the pairing page lists a single Actual
 * budget twice and every account appears under both names.
 */
export function normalizeBudgets(data: Config): Config {
  let budgets = data.budgets;
  let accounts = data.accounts;

  if (budgets.length === 0) {
    const envBudget = budgetFromEnv();
    if (envBudget) budgets = [envBudget];
  }

  const referencesDefault = accounts.some((a) => a.budgetId === DEFAULT_BUDGET_ID);
  if (referencesDefault && !budgets.some((b) => b.id === DEFAULT_BUDGET_ID)) {
    const envBudget = budgetFromEnv();
    if (envBudget) {
      // A configured budget may already point at the same Actual budget as
      // ACTUAL_SYNC_ID. Reuse it instead of seeding a second "Default" entry,
      // and repoint any legacy default-budget accounts at it.
      const existing = budgets.find((b) => b.syncId === envBudget.syncId);
      if (existing) {
        accounts = accounts.map((a) =>
          a.budgetId === DEFAULT_BUDGET_ID ? { ...a, budgetId: existing.id } : a
        );
      } else {
        budgets = [envBudget, ...budgets];
      }
    }
  }

  // Collapse any remaining budgets that resolve to the same Actual budget,
  // keeping the most recently configured entry and repointing accounts that
  // referenced a dropped one.
  const keptBySyncId = new Map<string, Budget>();
  const droppedSyncIdById = new Map<string, string>();
  for (const budget of budgets) {
    if (keptBySyncId.has(budget.syncId)) {
      const previous = keptBySyncId.get(budget.syncId);
      if (previous) droppedSyncIdById.set(previous.id, budget.syncId);
    }
    keptBySyncId.set(budget.syncId, budget);
  }

  if (droppedSyncIdById.size > 0) {
    budgets = [...keptBySyncId.values()];
    accounts = accounts.map((account) => {
      const syncId = droppedSyncIdById.get(account.budgetId);
      const survivor = syncId ? keptBySyncId.get(syncId) : undefined;
      return survivor ? { ...account, budgetId: survivor.id } : account;
    });
  }

  if (budgets === data.budgets && accounts === data.accounts) return data;
  return { ...data, budgets, accounts };
}

export async function loadConfig(): Promise<Config> {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Config file not found at ${CONFIG_PATH}. ` +
        'Please run "npm run setup" first to create an account mapping.'
    );
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to read or parse config file at ${CONFIG_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid config file at ${CONFIG_PATH}: ${result.error.message}`
    );
  }

  const config = normalizeBudgets(result.data);
  logger.debug(
    `Loaded config with ${config.accounts.length} account(s) across ${config.budgets.length} budget(s)`
  );
  return config;
}

export async function saveConfig(config: Config): Promise<void> {
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Cannot save invalid config: ${result.error.message}`);
  }

  atomicWriteFile(CONFIG_PATH, JSON.stringify(result.data, null, 2) + '\n', { mode: 0o600 });
  logger.debug(`Saved config to ${CONFIG_PATH}`);
}

/**
 * Merge incoming account pairings into an existing list, keyed by
 * `truelayerAccountId`. Existing entries keep any fields not overwritten
 * (notably `lastSyncedAt`) so re-auth never resets sync history.
 */
export function mergeAccounts(existing: Account[], incoming: Account[]): Account[] {
  const merged: Account[] = [...existing];
  for (const account of incoming) {
    const idx = merged.findIndex(
      (a) => a.truelayerAccountId === account.truelayerAccountId
    );
    if (idx !== -1) {
      merged[idx] = { ...merged[idx], ...account };
    } else {
      merged.push(account);
    }
  }
  return merged;
}

/**
 * Read-modify-write `config.json` under the state lock, re-reading the file
 * inside the critical section. Use this for partial updates (e.g. recording
 * `lastSyncedAt`) so a concurrent writer's changes are not clobbered.
 */
export function updateConfig(mutator: (config: Config) => void): Promise<Config> {
  return withStateLock(async () => {
    const config = await loadConfig();
    mutator(config);
    await saveConfig(config);
    return config;
  });
}

/**
 * Remove every account mapping that belongs to a connection (used when a
 * connection is deleted). Returns the remaining accounts. Does not throw when
 * no config exists yet.
 */
export async function removeAccountsForConnection(connectionId: string): Promise<Account[]> {
  return withStateLock(async () => {
    let config: Config;
    try {
      config = await loadConfig();
    } catch {
      return [];
    }

    const remaining = config.accounts.filter((a) => a.connectionId !== connectionId);
    if (remaining.length !== config.accounts.length) {
      config.accounts = remaining;
      await saveConfig(config);
      logger.debug(`Removed accounts for connection ${connectionId} from config.json`);
    }
    return remaining;
  });
}

/**
 * Return the configured budgets, falling back to the env-defined default
 * budget when no config exists yet. Used by the web dashboard pairing flow.
 */
export async function listBudgets(): Promise<Budget[]> {
  try {
    const config = await loadConfig();
    if (config.budgets.length > 0) return config.budgets;
  } catch {
    // No config yet — fall through to the env fallback.
  }
  const envBudget = budgetFromEnv();
  return envBudget ? [envBudget] : [];
}

/** Add or update a budget, creating the config file on first use. */
export async function addBudget(budget: Budget): Promise<Budget[]> {
  return withStateLock(async () => {
    let config: Config;
    try {
      config = await loadConfig();
    } catch {
      config = { budgets: [], accounts: [], createdAt: new Date().toISOString() };
    }

    const byId = config.budgets.findIndex((b) => b.id === budget.id);
    if (byId !== -1) {
      config.budgets[byId] = budget;
    } else {
      const bySyncId = config.budgets.findIndex((b) => b.syncId === budget.syncId);
      if (bySyncId === -1) {
        config.budgets.push(budget);
      } else {
        // The sync id identifies the Actual budget, so adding one that is
        // already configured renames it instead of creating a second entry
        // that resolves to the same accounts. Keep the existing id so account
        // references stay valid.
        config.budgets[bySyncId] = {
          ...config.budgets[bySyncId],
          name: budget.name,
          encryptionPassword: budget.encryptionPassword,
        };
      }
    }

    await saveConfig(config);
    return config.budgets;
  });
}

export interface ReconcileOptions {
  /** The connection id the fetched accounts now belong to. */
  newConnectionId: string;
  /** The previous connection id whose accounts should be repointed. */
  remapFrom?: string;
  /** TrueLayer account ids returned by the latest consent. */
  fetchedIds: Set<string>;
}

export interface ReconcileResult {
  accounts: Account[];
  changed: boolean;
  /** Previously mapped accounts that the consent did not return. */
  missing: Account[];
}

/**
 * Repoint existing mappings at a (possibly new) connection id after re-auth,
 * without touching pairings or `lastSyncedAt`. Pure helper so the risky part
 * of the callback is unit-testable.
 */
export function reconcileConfigAccounts(
  accounts: Account[],
  options: ReconcileOptions
): ReconcileResult {
  const { newConnectionId, remapFrom, fetchedIds } = options;
  const missing: Account[] = [];
  let changed = false;

  const next = accounts.map((account) => {
    const wasOnRemap = remapFrom !== undefined && account.connectionId === remapFrom;
    const isFetched = fetchedIds.has(account.truelayerAccountId);

    if (wasOnRemap && !isFetched) missing.push(account);

    if ((wasOnRemap || isFetched) && account.connectionId !== newConnectionId) {
      changed = true;
      return { ...account, connectionId: newConnectionId };
    }
    return account;
  });

  return { accounts: next, changed, missing };
}
