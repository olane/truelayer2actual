import 'dotenv/config';
import { pathToFileURL } from 'url';
import { loadConfig, updateConfig } from '../config.js';
import {
  loadConnection,
  refreshConnectionIfNeeded,
  getConnection,
  markConnectionHealthy,
  markConnectionNeedsReauth,
  ReauthRequiredError,
} from '../auth/tokens.js';
import {
  fetchTransactions,
  fetchCardTransactions,
  fetchBalance,
  fetchCardBalance,
  getMe,
  ConsentExpiredError,
  type TrueLayerBalance,
  type TrueLayerMe,
} from '../clients/truelayer.js';
import {
  withBudget,
  shutdownActual,
  importToActual,
  getActualAccountBalance,
} from '../clients/actual.js';
import { mapTransaction } from '../mapper.js';
import { notifyConnection } from '../notify.js';
import { createMutex } from '../util/lock.js';
import { logger } from '../logger.js';
import type { Account, Budget } from '../config.js';

/** Prevents two full syncs from overlapping (token rotation, double import). */
const withSyncLock = createMutex();

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function toDateString(ms: number): string {
  return new Date(ms).toISOString().split('T')[0];
}

export interface SyncWindow {
  from: string;
  to: string;
}

/**
 * Work out the inclusive date range to fetch for an account. Always looks back
 * at least `lookbackDays` so transactions that were pending last time but have
 * since settled are re-fetched, extending further when the last sync is older
 * than that. All arithmetic is in UTC milliseconds, so it is unaffected by the
 * host timezone or DST.
 */
export function resolveSyncWindow(
  lastSyncedAt: string | undefined,
  lookbackDays: number,
  nowMs = Date.now()
): SyncWindow {
  const floor = toDateString(nowMs - lookbackDays * MS_PER_DAY);
  const lastSyncDate = lastSyncedAt ? lastSyncedAt.split('T')[0] : floor;
  const from = lastSyncDate < floor ? lastSyncDate : floor;
  return { from, to: toDateString(nowMs) };
}

/** Parse SYNC_DAYS_LOOKBACK, defaulting to 7 days when missing or invalid. */
export function syncLookbackDays(): number {
  const raw = process.env.SYNC_DAYS_LOOKBACK;
  if (raw === undefined || raw.trim() === '') return 7;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(`Ignoring invalid SYNC_DAYS_LOOKBACK "${raw}" — using 7 days.`);
    return 7;
  }
  return Math.floor(n);
}

export function dashboardUrl(): string {
  const port = process.env.PORT ?? process.env.SETUP_PORT ?? '3000';
  return process.env.DASHBOARD_URL ?? `http://localhost:${port}`;
}

function reauthWarnDays(): number {
  const n = Number(process.env.REAUTH_WARN_DAYS ?? '14');
  return Number.isFinite(n) && n >= 0 ? n : 14;
}

/**
 * Parse SYNC_INTERVAL_HOURS. Missing/blank means one-shot mode (0). An invalid
 * value also falls back to one-shot with a warning, so a typo can never spin
 * the scheduler on a NaN delay.
 */
export function resolveIntervalHours(): number {
  const raw = process.env.SYNC_INTERVAL_HOURS;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(`Ignoring invalid SYNC_INTERVAL_HOURS "${raw}" — running one-shot.`);
    return 0;
  }
  return n;
}

function connectionLabel(connectionId: string): string {
  return getConnection(connectionId)?.providerDisplayName ?? connectionId;
}

// ---------------------------------------------------------------------------
// Balance validation
// ---------------------------------------------------------------------------

const DRIFT_THRESHOLD_PENCE = 100;

async function validateBalance(accessToken: string, account: Account): Promise<void> {
  let tlBalance: TrueLayerBalance;
  try {
    tlBalance = account.accountKind === 'card'
      ? await fetchCardBalance(accessToken, account.truelayerAccountId)
      : await fetchBalance(accessToken, account.truelayerAccountId);
  } catch (err) {
    logger.warn(
      `[${account.name}] Could not fetch balance for validation:`,
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  let actualBalancePence: number;
  try {
    actualBalancePence = await getActualAccountBalance(account.actualAccountId);
  } catch (err) {
    logger.warn(
      `[${account.name}] Could not fetch Actual balance for validation:`,
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  // TrueLayer reports card balances as positive (amount owed), but Actual stores
  // credit card accounts as negative — negate so both are on the same scale.
  const tlCurrentPence = Math.round(tlBalance.current * 100) * (account.accountKind === 'card' ? -1 : 1);
  const drift = Math.abs(tlCurrentPence - actualBalancePence);

  if (drift > DRIFT_THRESHOLD_PENCE) {
    logger.warn(
      `[${account.name}] Balance drift! ` +
        `TrueLayer: £${tlBalance.current.toFixed(2)}, ` +
        `Actual: £${(actualBalancePence / 100).toFixed(2)}, ` +
        `Drift: £${(drift / 100).toFixed(2)}`
    );
  } else {
    logger.debug(`[${account.name}] Balance consistent (drift: ${drift}p)`);
  }
}

// ---------------------------------------------------------------------------
// Per-connection token resolution (isolated so one dead bank can't abort sync)
// ---------------------------------------------------------------------------

export interface ConnectionTokenResolution {
  accessTokens: Map<string, string>;
  skipped: { connectionId: string; reason: string }[];
  errors: { connectionId: string; reason: string }[];
}

export interface ResolveConnectionTokensDeps {
  loadConnection?: typeof loadConnection;
  refreshConnectionIfNeeded?: typeof refreshConnectionIfNeeded;
}

export async function resolveConnectionTokens(
  connectionIds: string[],
  deps: ResolveConnectionTokensDeps = {}
): Promise<ConnectionTokenResolution> {
  const load = deps.loadConnection ?? loadConnection;
  const refresh = deps.refreshConnectionIfNeeded ?? refreshConnectionIfNeeded;

  const accessTokens = new Map<string, string>();
  const skipped: ConnectionTokenResolution['skipped'] = [];
  const errors: ConnectionTokenResolution['errors'] = [];

  for (const connectionId of connectionIds) {
    try {
      const tokens = load(connectionId);
      const accessToken = await refresh(connectionId, tokens);
      accessTokens.set(connectionId, accessToken);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof ReauthRequiredError) {
        logger.warn(`[${connectionId}] ${reason} — skipping its accounts this run.`);
        skipped.push({ connectionId, reason });
        await notifyConnection(connectionId, 'refresh_token_invalid', {
          title: `Reconnect ${connectionLabel(connectionId)}`,
          message: 'TrueLayer access for this bank has expired. Open the dashboard to reconnect.',
          url: dashboardUrl(),
          priority: 'high',
        });
      } else {
        logger.error(`[${connectionId}] Failed to prepare connection:`, reason);
        errors.push({ connectionId, reason });
      }
    }
  }

  return { accessTokens, skipped, errors };
}

// ---------------------------------------------------------------------------
// Connection metadata (/me) + consent expiry visibility
// ---------------------------------------------------------------------------

async function refreshConnectionMetadata(
  connectionId: string,
  accessToken: string
): Promise<void> {
  let me: TrueLayerMe;
  try {
    me = await getMe(accessToken);
  } catch (err) {
    if (err instanceof ConsentExpiredError) {
      logger.warn(`[${connectionId}] TrueLayer consent has expired — re-auth required.`);
      await markConnectionNeedsReauth(connectionId, 'consent_expired');
      await notifyConnection(connectionId, 'consent_expired', {
        title: `Reconnect ${connectionLabel(connectionId)}`,
        message: 'TrueLayer consent has expired. Open the dashboard to reconnect.',
        url: dashboardUrl(),
        priority: 'high',
      });
    } else {
      logger.debug(
        `[${connectionId}] Could not refresh connection metadata:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    return;
  }

  await markConnectionHealthy(connectionId, {
    providerId: me.provider?.provider_id,
    providerDisplayName: me.provider?.display_name,
    consentExpiresAt: me.consent_expires_at,
    consentStatus: me.consent_status,
  });

  if (me.consent_expires_at) {
    const msLeft = Date.parse(me.consent_expires_at) - Date.now();
    const daysLeft = Math.floor(msLeft / 86_400_000);
    if (msLeft <= reauthWarnDays() * 86_400_000) {
      const label = connectionLabel(connectionId);
      logger.warn(
        `[${connectionId}] Consent expires in ${daysLeft} day(s) (${me.consent_expires_at}).`
      );
      await notifyConnection(connectionId, 'consent_expiring', {
        title: `TrueLayer consent expiring for ${label}`,
        message: `Reconnect ${label} within ${daysLeft} day(s) to avoid a sync outage.`,
        url: dashboardUrl(),
        priority: 'default',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main sync flow
// ---------------------------------------------------------------------------

export interface SyncSummary {
  synced: string[];
  skipped: { connectionId: string; reason: string }[];
  errors: { connectionId?: string; account?: string; reason: string }[];
}

export async function runSync(): Promise<SyncSummary> {
  return withSyncLock(() => runSyncInternal());
}

async function syncAccount(
  account: Account,
  accessToken: string,
  lastSyncedAt: Map<string, string>,
  summary: SyncSummary
): Promise<void> {
  try {
    const { from, to } = resolveSyncWindow(account.lastSyncedAt, syncLookbackDays());

    logger.info(`[${account.name}] Syncing from ${from} to ${to}...`);

    const txns = account.accountKind === 'card'
      ? await fetchCardTransactions(accessToken, account.truelayerAccountId, from, to)
      : await fetchTransactions(accessToken, account.truelayerAccountId, from, to);
    logger.info(`[${account.name}] Fetched ${txns.length} transaction(s)`);

    const isCard = account.accountKind === 'card';
    const mapped = txns.map((t) => mapTransaction(t, isCard));
    const result = await importToActual(account.actualAccountId, mapped);

    logger.info(`[${account.name}] +${result.added.length} added, ${result.updated.length} updated`);

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Import errors: ${JSON.stringify(result.errors)}`);
    }

    await validateBalance(accessToken, account);
    lastSyncedAt.set(account.truelayerAccountId, new Date().toISOString());
    summary.synced.push(account.name);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`[${account.name}] Sync failed:`, reason);
    summary.errors.push({
      connectionId: account.connectionId,
      account: account.name,
      reason,
    });
  }
}

async function runSyncInternal(): Promise<SyncSummary> {
  logger.info('Starting truelayer2actual sync...');

  const summary: SyncSummary = { synced: [], skipped: [], errors: [] };
  const config = await loadConfig();

  if (config.accounts.length === 0) {
    logger.warn('No accounts configured. Run "npm run setup" to pair accounts.');
    return summary;
  }

  const connectionIds = [...new Set(config.accounts.map((a) => a.connectionId))];
  const { accessTokens, skipped, errors } = await resolveConnectionTokens(connectionIds);
  summary.skipped.push(...skipped);
  summary.errors.push(...errors);

  // Record sync timestamps by TrueLayer account id and persist them with a
  // locked read-merge-write afterwards, so a concurrent reauth/pairing that
  // changed connection ids isn't clobbered by a stale in-memory snapshot.
  const lastSyncedAt = new Map<string, string>();

  // Group accounts by Actual budget and sync each budget in turn, switching the
  // Active Budget client to the right budget before touching its accounts.
  const budgetById = new Map<string, Budget>(config.budgets.map((b) => [b.id, b]));
  const accountsByBudget = new Map<string, Account[]>();
  for (const account of config.accounts) {
    const list = accountsByBudget.get(account.budgetId) ?? [];
    list.push(account);
    accountsByBudget.set(account.budgetId, list);
  }

  for (const [budgetId, accounts] of accountsByBudget) {
    const budget = budgetById.get(budgetId);
    if (!budget) {
      for (const account of accounts) {
        summary.errors.push({
          connectionId: account.connectionId,
          account: account.name,
          reason: `Unknown budget "${budgetId}" — run "npm run setup" to reconfigure.`,
        });
      }
      continue;
    }

    try {
      await withBudget(budget, async () => {
        for (const account of accounts) {
          const accessToken = accessTokens.get(account.connectionId);
          if (!accessToken) continue;
          await syncAccount(account, accessToken, lastSyncedAt, summary);
        }
      });
    } catch (err) {
      // A budget that can't be downloaded shouldn't abort the other budgets.
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`[budget ${budget.name}] Failed to switch budget:`, reason);
      for (const account of accounts) {
        summary.errors.push({
          connectionId: account.connectionId,
          account: account.name,
          reason,
        });
      }
    }
  }

  if (lastSyncedAt.size > 0) {
    await updateConfig((cfg) => {
      for (const account of cfg.accounts) {
        const ts = lastSyncedAt.get(account.truelayerAccountId);
        if (ts) account.lastSyncedAt = ts;
      }
    });
  }

  // Best-effort metadata refresh — never fail the run over this.
  for (const [connectionId, accessToken] of accessTokens) {
    await refreshConnectionMetadata(connectionId, accessToken);
  }

  logger.info(
    `Sync complete — ${summary.synced.length} account(s) synced, ` +
      `${summary.skipped.length} connection(s) need re-auth, ${summary.errors.length} error(s)`
  );
  return summary;
}

/** One-shot run: sync, then release the Actual Budget client. */
async function runOnce(): Promise<void> {
  try {
    await runSync();
  } finally {
    await shutdownActual();
  }
}

async function loop(): Promise<void> {
  const intervalHours = resolveIntervalHours();

  if (intervalHours <= 0) {
    // One-shot mode (for external schedulers like Synology Task Scheduler)
    await runOnce();
    return;
  }

  const intervalMs = intervalHours * 60 * 60 * 1000;
  logger.info(`Running in loop mode — syncing every ${intervalHours} hour(s)`);

  // Keep the Actual client initialised between iterations and release it only
  // on shutdown. Shutting it down and re-initialising every cycle would rely on
  // undocumented re-init behaviour in @actual-app/api.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down`);
    await shutdownActual();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runSync().catch((err) => {
      logger.error('Sync failed:', err instanceof Error ? err.message : String(err));
    });
    logger.info(`Next sync in ${intervalHours} hour(s)...`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  loop().catch((err) => {
    logger.error('Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
