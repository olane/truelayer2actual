import http from 'http';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { loadAllConnections, getConnection, deleteConnection } from '../auth/tokens.js';
import { loadConfig, removeAccountsForConnection } from '../config.js';
import { withActual, getActualAccounts, getActualError } from '../clients/actual.js';
import { runSync } from '../commands/sync.js';
import { startNewAuth, startReauth, processCallback, savePairings } from './oauth.js';
import {
  dashboardPage,
  pairingPage,
  messagePage,
  type ConnectionStatus,
  type ConnectionView,
} from './pages.js';
import { logger } from '../logger.js';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reauthWarnDays(): number {
  const n = Number(process.env.REAUTH_WARN_DAYS ?? '14');
  return Number.isFinite(n) && n >= 0 ? n : 14;
}

async function buildConnectionViews(): Promise<ConnectionView[]> {
  const connections = loadAllConnections();

  let accounts: Awaited<ReturnType<typeof loadConfig>>['accounts'] = [];
  try {
    accounts = (await loadConfig()).accounts;
  } catch {
    accounts = [];
  }

  return Object.entries(connections).map(([id, tokens]) => {
    const mine = accounts.filter((a) => a.connectionId === id);
    const lastSyncedAt = mine
      .map((a) => a.lastSyncedAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop();

    let daysLeft: number | undefined;
    if (tokens.consentExpiresAt) {
      const ms = Date.parse(tokens.consentExpiresAt) - Date.now();
      if (Number.isFinite(ms)) daysLeft = Math.floor(ms / 86_400_000);
    }

    let status: ConnectionStatus = 'healthy';
    if (tokens.needsReauth) status = 'reauth_needed';
    else if (daysLeft !== undefined && daysLeft <= reauthWarnDays()) status = 'expiring';

    return {
      id,
      provider: tokens.providerDisplayName ?? tokens.providerId ?? id,
      accountCount: mine.length,
      lastSyncedAt,
      consentExpiresAt: tokens.consentExpiresAt,
      daysLeft,
      status,
      reason: tokens.reauthReason,
    };
  });
}

function bannerFromQuery(req: Request): { message?: string; error?: string } {
  return {
    message: asString(req.query.msg),
    error: asString(req.query.err),
  };
}

/**
 * CSRF hardening for the unauthenticated state-changing POST routes: reject
 * requests whose Origin is neither the request host nor DASHBOARD_URL. Requests
 * without an Origin (curl, older clients) are allowed; this is defence in depth
 * on top of the proxy's LAN/basic-auth control, not a substitute for it.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (originHost === req.headers.host) return true;
  const dashboard = process.env.DASHBOARD_URL;
  if (dashboard) {
    try {
      if (new URL(dashboard).host === originHost) return true;
    } catch {
      // ignore malformed DASHBOARD_URL
    }
  }
  return false;
}

export function createApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    if (req.method === 'POST' && !originAllowed(req)) {
      logger.warn('Rejected cross-origin POST:', req.headers.origin ?? '(none)', req.path);
      res
        .status(403)
        .send(messagePage('Forbidden', 'Cross-origin request rejected.', { error: true }));
      return;
    }
    next();
  });

  app.get(
    '/',
    asyncHandler(async (req, res) => {
      const connections = await buildConnectionViews();
      res.send(dashboardPage({ connections, ...bannerFromQuery(req) }));
    })
  );

  app.get(
    '/healthz',
    asyncHandler(async (_req, res) => {
      try {
        const connections = loadAllConnections();
        const view = Object.entries(connections).map(([id, tokens]) => ({
          id,
          provider: tokens.providerDisplayName ?? tokens.providerId ?? null,
          needsReauth: Boolean(tokens.needsReauth),
          consentExpiresAt: tokens.consentExpiresAt ?? null,
        }));
        const actualError = getActualError();
        const degraded = view.some((c) => c.needsReauth) || Boolean(actualError);
        res.status(200).json({
          status: degraded ? 'degraded' : 'ok',
          connections: view,
          ...(actualError ? { error: actualError } : {}),
        });
      } catch (err) {
        // Never let a corrupt/unreadable tokens.json make the container unhealthy.
        res.status(200).json({
          status: 'degraded',
          connections: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  app.get('/auth/new', (_req, res) => {
    const { url } = startNewAuth();
    res.redirect(url);
  });

  app.post(
    '/connections/:id/reauth',
    asyncHandler(async (req, res) => {
      const connectionId = req.params.id;
      if (!getConnection(connectionId)) {
        res.status(404).send(messagePage('Unknown connection', connectionId, { error: true }));
        return;
      }
      const { url } = await startReauth(connectionId);
      res.redirect(url);
    })
  );

  app.post(
    '/connections/:id/delete',
    asyncHandler(async (req, res) => {
      const connectionId = req.params.id;
      if (!getConnection(connectionId)) {
        res.status(404).send(messagePage('Unknown connection', connectionId, { error: true }));
        return;
      }
      await deleteConnection(connectionId);
      await removeAccountsForConnection(connectionId);
      res.redirect('/?msg=' + encodeURIComponent('Connection deleted.'));
    })
  );

  app.get(
    '/callback',
    asyncHandler(async (req, res) => {
      const outcome = await processCallback({
        code: asString(req.query.code),
        state: asString(req.query.state),
        error: asString(req.query.error),
        errorDescription: asString(req.query.error_description),
      });

      if (outcome.type === 'error') {
        res.status(400).send(messagePage('Authentication failed', outcome.message, { error: true }));
        return;
      }

      if (outcome.type === 'done') {
        res.redirect('/?msg=' + encodeURIComponent(outcome.message));
        return;
      }

      const actualAccounts = await withActual(() => getActualAccounts());
      res.send(
        pairingPage({
          pairingId: outcome.pairingId,
          provider: outcome.session.provider,
          items: outcome.session.items,
          actualAccounts,
          message:
            outcome.session.mode === 'reauth'
              ? 'Reconnected. Confirm any new accounts below.'
              : undefined,
        })
      );
    })
  );

  app.post(
    '/pair',
    asyncHandler(async (req, res) => {
      const pairingId = asString(req.body?.pairingId);
      if (!pairingId) {
        res.status(400).send(messagePage('Invalid request', 'Missing pairing session.', { error: true }));
        return;
      }
      const mapping: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
        if (key.startsWith('map_') && typeof value === 'string' && value) {
          mapping[key.slice('map_'.length)] = value;
        }
      }
      const { saved } = await savePairings(pairingId, mapping);
      res.redirect('/?msg=' + encodeURIComponent(`Saved ${saved} pairing(s).`));
    })
  );

  app.post(
    '/sync',
    asyncHandler(async (_req, res) => {
      try {
        const summary = await runSync();
        const message =
          `Sync finished: ${summary.synced.length} synced, ` +
          `${summary.skipped.length} need re-auth, ${summary.errors.length} error(s).`;
        res.redirect('/?msg=' + encodeURIComponent(message));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Manual sync failed:', message);
        res.redirect('/?err=' + encodeURIComponent(message));
      }
    })
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('HTTP request failed:', err.message);
    res.status(500).send(messagePage('Something went wrong', err.message, { error: true }));
  });

  return app;
}

export async function startServer(port: number): Promise<http.Server> {
  const app = createApp();
  return await new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info(`Dashboard listening on http://localhost:${port}`);
      resolve(server);
    });
    server.on('error', (err) => {
      reject(
        new Error(
          `Failed to start dashboard on port ${port}: ${err.message}. ` +
            'Try setting PORT (or SETUP_PORT) in your environment.'
        )
      );
    });
  });
}
