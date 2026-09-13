import axios from 'axios';
import { getConnection, updateConnection } from './auth/tokens.js';
import { logger } from './logger.js';

export interface NotifyOptions {
  title: string;
  message: string;
  priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
  url?: string;
}

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Send a notification to every configured backend. Never throws: a failed
 * notification must not break sync.
 */
export async function notify(options: NotifyOptions): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  const ntfyUrl = process.env.NTFY_URL;
  if (ntfyUrl) {
    const body = new URLSearchParams({ title: options.title, message: options.message });
    if (options.priority) body.set('priority', options.priority);
    if (options.url) body.set('click', options.url);
    tasks.push(
      axios.post(ntfyUrl, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    );
  }

  const haWebhookUrl = process.env.HA_WEBHOOK_URL;
  if (haWebhookUrl) {
    tasks.push(
      axios.post(haWebhookUrl, {
        title: options.title,
        message: options.message,
        url: options.url,
      })
    );
  }

  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'rejected') {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.warn('Notification delivery failed:', reason);
    }
  }
}

/**
 * Send a notification for a connection at most once per 24h, recording the time
 * in tokens.json so restarts don't cause a notification storm.
 */
export async function notifyConnection(
  connectionId: string,
  reason: string,
  options: NotifyOptions
): Promise<void> {
  try {
    let connection;
    try {
      connection = getConnection(connectionId);
    } catch (err) {
      logger.debug(
        `[${connectionId}] Could not read connection for notification dedupe:`,
        err instanceof Error ? err.message : String(err)
      );
      return;
    }

    const last = connection?.lastNotifiedAt ? Date.parse(connection.lastNotifiedAt) : NaN;
    if (Number.isFinite(last) && Date.now() - last < DEDUPE_WINDOW_MS) {
      logger.debug(`[${connectionId}] Suppressing duplicate ${reason} notification`);
      return;
    }

    await notify(options);

    if (connection) {
      updateConnection(connectionId, { lastNotifiedAt: new Date().toISOString() });
    }
  } catch (err) {
    logger.warn(
      `[${connectionId}] Notification failed:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
