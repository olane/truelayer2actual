# truelayer2actual

Syncs UK bank transactions from [TrueLayer](https://truelayer.com) into a self-hosted [Actual Budget](https://actualbudget.org) instance.

Runs as a Docker container. Supports one-shot mode (triggered by external cron) or a built-in loop for continuous syncing.

## How it works

1. **One-time setup** (`npm run setup`) — OAuth flow with TrueLayer, interactive pairing of bank accounts to Actual accounts, saves `data/config.json` and `data/tokens.json`.
2. **Sync** (`npm run sync`) — reads config, refreshes the TrueLayer token, fetches new transactions per account, imports them into Actual, logs any balance drift. Runs once and exits, or loops on an interval if `SYNC_INTERVAL_HOURS` is set.

```
┌─────────────────────────────────┐
│  npm run setup  (run once)      │
│  - TrueLayer OAuth via browser  │
│  - List bank accounts + cards   │
│  - Interactive CLI pairing      │
│  - Save config.json + tokens    │
└────────────────┬────────────────┘
                 │ data/config.json
                 │ data/tokens.json
     ┌───────────▼──────────────────┐
     │  npm run sync                │
     │  1. Load config + tokens     │
     │  2. Refresh TrueLayer token  │
     │  3. For each account:        │
     │     a. Fetch transactions    │
     │     b. Map to Actual format  │
     │     c. importTransactions()  │
     │     d. Log balance drift     │
     │  4. Save updated config      │
     │  5. api.shutdown()           │
     │  6. exit 0                   │
     └──────────────────────────────┘
```

## Prerequisites

- A [TrueLayer](https://console.truelayer.com) account with a registered application
- A self-hosted [Actual Budget](https://actualbudget.org) server
- Node.js 20+ (or Docker)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jasmucrai/truelayer2actual.git
cd truelayer2actual
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# TrueLayer — from console.truelayer.com
# Use a sandbox- prefix client ID for testing
TRUELAYER_CLIENT_ID=
TRUELAYER_CLIENT_SECRET=
TRUELAYER_REDIRECT_URI=http://localhost:3000/callback

# Actual Budget
ACTUAL_SERVER_URL=http://your-nas:5006
ACTUAL_PASSWORD=
ACTUAL_SYNC_ID=                     # default budget sync id (optional if you add budgets during setup)
ACTUAL_ENCRYPTION_PASSWORD=         # optional — only if E2E encryption is enabled

# If Actual is served over HTTPS with a self-signed certificate, trust just
# that CA. Never use NODE_TLS_REJECT_UNAUTHORIZED=0 — it disables certificate
# validation for every outbound request, including TrueLayer auth and data.
# NODE_EXTRA_CA_CERTS=/path/to/actual-ca.pem

# Sync behaviour
SYNC_DAYS_LOOKBACK=7      # how many days back to fetch on first run
SYNC_INTERVAL_HOURS=0     # 0 = one-shot (use external cron); >0 = built-in loop
SETUP_PORT=3000

# Dashboard / notifications (npm run serve)
PORT=3000                 # falls back to SETUP_PORT, then 3000
DASHBOARD_URL=https://truelayer.example.com
REAUTH_WARN_DAYS=14       # warn/notify when consent expires within this many days
NTFY_URL=                 # optional: full ntfy topic URL
HA_WEBHOOK_URL=           # optional: Home Assistant webhook URL
```

> **Important:** `@actual-app/api` must match your Actual server version. If you get an `out-of-sync-migrations` error, run:
> ```bash
> npm install @actual-app/api@<your-server-version>
> ```

### 3. Pair accounts

```bash
npm run setup
```

This opens a browser for TrueLayer OAuth, then prompts you to map each bank account/card to an Actual account. Supports multiple banks — you'll be asked after each one if you want to add another.

### Multiple budgets

You can sync into more than one Actual budget (e.g. a personal and a joint budget on the
same server). All budgets share `ACTUAL_SERVER_URL` and `ACTUAL_PASSWORD`; the sync id (and,
optionally, an E2E encryption password) differs per budget.

- **CLI setup** (`npm run setup`): you are prompted to add budgets (name + sync id + optional
  encryption password), then for each bank account/card you choose *which budget* before pairing
  *which account* — so a single bank connection can span multiple budgets.
- **Dashboard** (`npm run serve`): after authorising a bank, each account row has its own budget
  selector next to the account selector. You can also add budgets directly from the pairing page
  (including an optional encryption password).

`ACTUAL_SYNC_ID` remains as a convenience: it defines the "Default" budget used when no other
budgets have been configured yet (and for backwards compatibility with older configs).

Every budget needs its own sync id (Actual → Settings → Advanced, with that budget open). Two
budgets with the same sync id are the same Actual file and list identical accounts, so setup and
the dashboard refuse to add one, and the pairing page flags any existing clash in `config.json`.

### 4. Sync

```bash
npm run sync
```

On first run it fetches the last `SYNC_DAYS_LOOKBACK` days. Subsequent runs use the last sync timestamp as the start date.

## Docker

### Build and run (always-on, recommended)

```bash
docker build -t truelayer2actual .
docker run -d --restart unless-stopped \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  --env-file .env \
  truelayer2actual
```

Open the dashboard at `http://localhost:3000` (or your reverse-proxied host): add banks,
pair accounts, trigger a sync, and reconnect banks from a browser — no TTY and no
container restarts. Existing pairings can be viewed and changed at any time via
**Edit pairings** on a connection, without reconnecting the bank. The process runs the
Express dashboard and the sync scheduler in a
single Node process, so there is no race on `data/tokens.json`/`config.json`.

When a bank's refresh token dies or its consent is about to expire, the connection is
flagged `needsReauth` (visible at `/healthz` and on the dashboard), other banks keep
syncing, and a notification is sent if `NTFY_URL`/`HA_WEBHOOK_URL` is configured.

### One-off sync

```bash
docker run --rm \
  -v /path/to/data:/app/data \
  --env-file .env \
  truelayer2actual node dist/commands/sync.js
```

### CLI setup (disaster recovery)

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  --env-file .env \
  truelayer2actual node dist/commands/setup.js
```

### docker-compose.yml

```yaml
services:
  truelayer2actual:
    image: truelayer2actual:latest
    container_name: truelayer2actual
    ports:
      - "3000:3000"
    volumes:
      - /path/to/data:/app/data
    env_file: .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 60s
      timeout: 5s
      retries: 3
```

## Scheduling

The sync command supports two modes, controlled by `SYNC_INTERVAL_HOURS` in `.env`:

### Option A: External cron (default, `SYNC_INTERVAL_HOURS=0`)

The container starts, syncs once, and exits. Scheduling is handled externally — ideal for Synology Task Scheduler or any cron.

**Synology Task Scheduler:**

1. **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**
2. Run as: `root` (or a docker-capable user)
3. Schedule: daily at 06:00 (or your preferred time)
4. Script:
   ```bash
   docker compose -f /volume1/docker/truelayer2actual/docker-compose.yml \
     run --rm truelayer2actual
   ```
5. Enable **"Send run details by email"** and **"Send only when script terminates abnormally"**

### Option B: Built-in loop (`SYNC_INTERVAL_HOURS=6`)

Set `SYNC_INTERVAL_HOURS` to a positive number and the container runs continuously, syncing on that interval. Change `restart: "no"` to `restart: unless-stopped` in `docker-compose.yml`:

```yaml
services:
  truelayer2actual:
    image: truelayer2actual:latest
    container_name: truelayer2actual
    volumes:
      - /volume1/docker/truelayer2actual/data:/app/data
    env_file: .env
    restart: unless-stopped
```

## Sandbox / testing

TrueLayer provides a sandbox environment with a mock bank that returns predictable test data — no real bank credentials needed.

1. Create a sandbox app at [console.truelayer.com](https://console.truelayer.com)
2. Set `TRUELAYER_CLIENT_ID=sandbox-<your-id>` in `.env` — the `sandbox-` prefix is detected automatically and switches all API calls to sandbox endpoints
3. Run `npm run setup` and authenticate with **Mock Bank**

## npm scripts

| Script | Description |
|---|---|
| `npm run serve` | Always-on dashboard + sync scheduler (recommended) |
| `npm run setup` | One-time OAuth + account pairing (CLI) |
| `npm run sync` | Sync transactions (one-shot or loop) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:serve` | Run compiled serve |
| `npm run start:setup` | Run compiled setup |
| `npm run start:sync` | Run compiled sync |
| `npm test` | Run unit tests |

## Project structure

```
src/
├── commands/
│   ├── serve.ts        # Express dashboard + sync scheduler (always-on)
│   ├── setup.ts        # CLI OAuth flow + interactive account pairing
│   └── sync.ts         # Sync core (runSync) + one-shot/loop entry point
├── web/
│   ├── server.ts       # Routes: dashboard, reauth, callback, pair, edit pairings, sync, healthz
│   ├── oauth.ts        # Pending-state store, callback handling, pairing sessions
│   └── pages.ts        # Server-rendered HTML (no frontend build step)
├── auth/
│   ├── server.ts       # Temporary Express OAuth callback server (CLI setup only)
│   ├── oauth.ts        # Shared auth URL / code exchange / account fetch helpers
│   └── tokens.ts       # Token storage, refresh, metadata, expiry check
├── clients/
│   ├── truelayer.ts    # TrueLayer Data API (accounts, transactions, balance, /me, reauthuri)
│   └── actual.ts       # Actual Budget API wrapper + withActual() mutex
├── mapper.ts           # TrueLayer transaction → Actual transaction
├── notify.ts           # ntfy / Home Assistant notifications with dedupe
├── config.ts           # config.json read/write with zod validation
├── util/fs.ts          # Atomic file writes
└── logger.ts           # Structured logging
data/                   # Gitignored — mount as a volume to persist state
├── tokens.json         # TrueLayer OAuth tokens + connection metadata
├── config.json         # Account mappings + sync state
└── actual-cache/       # @actual-app/api local budget cache
```

## License

MIT
