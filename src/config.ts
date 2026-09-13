import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from './logger.js';
import { atomicWriteFile } from './util/fs.js';
import { withStateLock } from './util/lock.js';

const AccountSchema = z.object({
  name: z.string(),
  connectionId: z.string(),
  accountKind: z.enum(['account', 'card']).default('account'),
  truelayerAccountId: z.string(),
  actualAccountId: z.string(),
  currency: z.string().default('GBP'),
  lastSyncedAt: z.string().optional(),
});

const ConfigSchema = z.object({
  accounts: z.array(AccountSchema),
  createdAt: z.string(),
});

export type Account = z.infer<typeof AccountSchema>;
export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_PATH = path.join(process.cwd(), 'data', 'config.json');

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

  logger.debug(`Loaded config with ${result.data.accounts.length} account(s)`);
  return result.data;
}

export async function saveConfig(config: Config): Promise<void> {
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Cannot save invalid config: ${result.error.message}`);
  }

  atomicWriteFile(CONFIG_PATH, JSON.stringify(result.data, null, 2) + '\n');
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
