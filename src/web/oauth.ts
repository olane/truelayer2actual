import crypto from 'crypto';
import axios from 'axios';
import {
  generateConnectionId,
  saveConnection,
  loadConnection,
  removeStaleConnections,
  type Tokens,
} from '../auth/tokens.js';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchTrueLayerAccounts,
  isSandbox,
  requireEnv,
} from '../auth/oauth.js';
import { generateReauthLink, getMe } from '../clients/truelayer.js';
import { loadConfig, saveConfig, mergeAccounts, type Account } from '../config.js';
import { withStateLock } from '../util/lock.js';
import { logger } from '../logger.js';

const PENDING_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-memory OAuth state + pairing sessions (15 minute TTL)
// ---------------------------------------------------------------------------

export interface PendingAuth {
  mode: 'new' | 'reauth';
  connectionId?: string;
  previousConnectionId?: string;
  createdAt: number;
}

const pendingAuth = new Map<string, PendingAuth>();

export function createState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function setPending(state: string, entry: Omit<PendingAuth, 'createdAt'>): void {
  pendingAuth.set(state, { ...entry, createdAt: Date.now() });
}

function getPending(state: string): PendingAuth | undefined {
  const entry = pendingAuth.get(state);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingAuth.delete(state);
    return undefined;
  }
  return entry;
}

function consumePending(state: string): PendingAuth | undefined {
  const entry = getPending(state);
  if (entry) pendingAuth.delete(state);
  return entry;
}

export interface PairingItem {
  truelayerAccountId: string;
  name: string;
  accountKind: 'account' | 'card';
  currency: string;
}

export interface PairingSession {
  connectionId: string;
  previousConnectionId?: string;
  mode: 'new' | 'reauth';
  provider: string;
  items: PairingItem[];
  createdAt: number;
}

const pairingSessions = new Map<string, PairingSession>();

function setPairing(session: Omit<PairingSession, 'createdAt'>): string {
  const id = crypto.randomBytes(12).toString('hex');
  pairingSessions.set(id, { ...session, createdAt: Date.now() });
  return id;
}

function consumePairing(id: string): PairingSession | undefined {
  const session = pairingSessions.get(id);
  if (!session) return undefined;
  pairingSessions.delete(id);
  if (Date.now() - session.createdAt > PENDING_TTL_MS) return undefined;
  return session;
}

// ---------------------------------------------------------------------------
// Starting auth flows
// ---------------------------------------------------------------------------

export function startNewAuth(): { state: string; url: string } {
  const clientId = requireEnv('TRUELAYER_CLIENT_ID');
  const redirectUri = requireEnv('TRUELAYER_REDIRECT_URI');
  const sandbox = isSandbox(clientId);
  const state = createState();
  setPending(state, { mode: 'new' });
  return { state, url: buildAuthUrl(clientId, redirectUri, sandbox, state) };
}

export interface ReauthStart {
  url: string;
  usedReauthUri: boolean;
}

/**
 * Start a re-auth for an existing connection. Prefers the ungated
 * `/v1/reauthuri` link; if TrueLayer rejects it (grace window lapsed or the
 * endpoint is unavailable) fall back to a full authorization flow that still
 * preserves existing account mappings by `truelayerAccountId`.
 */
export async function startReauth(connectionId: string): Promise<ReauthStart> {
  const clientId = requireEnv('TRUELAYER_CLIENT_ID');
  const redirectUri = requireEnv('TRUELAYER_REDIRECT_URI');
  const sandbox = isSandbox(clientId);
  const connection = loadConnection(connectionId);

  const state = createState();
  try {
    const url = await generateReauthLink(connection.refreshToken, redirectUri, state);
    setPending(state, { mode: 'reauth', connectionId });
    return { url, usedReauthUri: true };
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status !== 401 && status !== 400 && status !== 404) {
      throw err;
    }
    logger.warn(
      `[${connectionId}] reauthuri rejected${status ? ` (HTTP ${status})` : ''} — ` +
        'falling back to full authorization (mappings will be preserved).'
    );
    const fallbackState = createState();
    setPending(fallbackState, { mode: 'new', previousConnectionId: connectionId });
    return {
      url: buildAuthUrl(clientId, redirectUri, sandbox, fallbackState),
      usedReauthUri: false,
    };
  }
}

// ---------------------------------------------------------------------------
// OAuth callback
// ---------------------------------------------------------------------------

export type CallbackOutcome =
  | { type: 'error'; message: string }
  | { type: 'done'; message: string }
  | { type: 'pair'; pairingId: string; session: PairingSession };

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export async function processCallback(params: CallbackParams): Promise<CallbackOutcome> {
  if (params.error) {
    return { type: 'error', message: params.errorDescription ?? params.error };
  }
  if (!params.code) {
    return { type: 'error', message: 'No authorization code received from TrueLayer.' };
  }
  if (!params.state) {
    return { type: 'error', message: 'Missing state parameter on callback.' };
  }

  const pending = consumePending(params.state);
  if (!pending) {
    return {
      type: 'error',
      message: 'Unknown or expired authorization state. Start the flow again from the dashboard.',
    };
  }

  const clientId = requireEnv('TRUELAYER_CLIENT_ID');
  const clientSecret = requireEnv('TRUELAYER_CLIENT_SECRET');
  const redirectUri = requireEnv('TRUELAYER_REDIRECT_URI');
  const sandbox = isSandbox(clientId);

  const remapFrom =
    pending.previousConnectionId ?? (pending.mode === 'reauth' ? pending.connectionId : undefined);

  let previousTokens: Tokens | undefined;
  if (remapFrom) {
    try {
      previousTokens = loadConnection(remapFrom);
    } catch {
      // Connection vanished — treat as a fresh auth.
    }
  }

  let tokens: Tokens;
  try {
    tokens = await exchangeCodeForTokens({
      clientId,
      clientSecret,
      redirectUri,
      code: params.code,
      sandbox,
      fallbackRefreshToken: previousTokens?.refreshToken,
    });
  } catch (err) {
    return { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  const { accounts, cards } = await fetchTrueLayerAccounts(tokens.accessToken);
  const provider =
    accounts[0]?.provider.display_name ?? cards[0]?.provider.display_name ?? 'Bank';

  // Best-effort connection metadata.
  try {
    const me = await getMe(tokens.accessToken);
    tokens.providerId = me.provider?.provider_id;
    tokens.providerDisplayName = me.provider?.display_name ?? provider;
    tokens.consentExpiresAt = me.consent_expires_at;
    tokens.consentStatus = me.consent_status;
  } catch (err) {
    logger.debug(
      'Could not fetch connection metadata during callback:',
      err instanceof Error ? err.message : String(err)
    );
  }
  tokens.providerDisplayName = tokens.providerDisplayName ?? provider;
  tokens.needsReauth = false;
  tokens.reauthReason = undefined;

  const connectionId =
    pending.mode === 'reauth' && pending.connectionId
      ? pending.connectionId
      : generateConnectionId();
  saveConnection(connectionId, tokens);

  const items: PairingItem[] = [
    ...accounts.map((a) => ({
      truelayerAccountId: a.account_id,
      name: a.display_name,
      accountKind: 'account' as const,
      currency: a.currency,
    })),
    ...cards.map((c) => ({
      truelayerAccountId: c.account_id,
      name: c.display_name,
      accountKind: 'card' as const,
      currency: c.currency,
    })),
  ];

  let existingConfig: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    existingConfig = await loadConfig();
  } catch {
    existingConfig = null;
  }

  if (existingConfig) {
    const fetchedIds = new Set(items.map((i) => i.truelayerAccountId));
    let changed = false;

    for (const account of existingConfig.accounts) {
      const wasOnRemap = remapFrom !== undefined && account.connectionId === remapFrom;
      const isFetched = fetchedIds.has(account.truelayerAccountId);

      if (wasOnRemap && !isFetched) {
        logger.warn(
          `Previously mapped account "${account.name}" was not returned by TrueLayer. ` +
            'Keeping the mapping.'
        );
      }
      if ((wasOnRemap || isFetched) && account.connectionId !== connectionId) {
        account.connectionId = connectionId;
        changed = true;
      }
    }

    if (changed) await saveConfig(existingConfig);
  }

  const mappedIds = new Set((existingConfig?.accounts ?? []).map((a) => a.truelayerAccountId));
  const unmapped = items.filter((i) => !mappedIds.has(i.truelayerAccountId));

  const activeConnectionIds = new Set((existingConfig?.accounts ?? []).map((a) => a.connectionId));
  activeConnectionIds.add(connectionId);
  removeStaleConnections(activeConnectionIds);

  if (unmapped.length === 0) {
    return { type: 'done', message: `${provider} is connected.` };
  }

  const sessionBase = {
    connectionId,
    previousConnectionId: remapFrom,
    mode: pending.mode,
    provider,
    items: unmapped,
  };
  const pairingId = setPairing(sessionBase);
  return {
    type: 'pair',
    pairingId,
    session: { ...sessionBase, createdAt: Date.now() },
  };
}

// ---------------------------------------------------------------------------
// Pairing submission
// ---------------------------------------------------------------------------

export interface SavePairingsResult {
  saved: number;
}

export async function savePairings(
  pairingId: string,
  mapping: Record<string, string>
): Promise<SavePairingsResult> {
  return withStateLock(async () => {
    const session = consumePairing(pairingId);
    if (!session) {
      throw new Error('Pairing session expired. Start again from the dashboard.');
    }

    const incoming: Account[] = [];
    for (const item of session.items) {
      const actualAccountId = mapping[item.truelayerAccountId];
      if (!actualAccountId) continue;
      incoming.push({
        name: item.name,
        connectionId: session.connectionId,
        accountKind: item.accountKind,
        truelayerAccountId: item.truelayerAccountId,
        actualAccountId,
        currency: item.currency,
      });
    }

    let existingConfig: Awaited<ReturnType<typeof loadConfig>> | null = null;
    try {
      existingConfig = await loadConfig();
    } catch {
      existingConfig = null;
    }

    const merged = mergeAccounts(existingConfig?.accounts ?? [], incoming);
    await saveConfig({
      accounts: merged,
      createdAt: existingConfig?.createdAt ?? new Date().toISOString(),
    });

    removeStaleConnections(new Set(merged.map((a) => a.connectionId)));

    return { saved: incoming.length };
  });
}
