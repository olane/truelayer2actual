import axios from 'axios';
import { getConnection, saveConnection, updateConnection } from './auth/tokens.js';
import { withStateLock } from './util/lock.js';
import { HTTP_TIMEOUT_MS } from './util/http.js';
import { logger } from './logger.js';

export interface NotifyOptions {
  title: string;
  message: string;
  priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
  url?: string;
}

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Send a notification to every configured backend and report whether it was
 * handled — `true` when no backend is configured or at least one delivery
 * succeeded, `false` when every configured backend failed. Never throws: a
 * failed notification must not break sync.
 */
export async function notify(options: NotifyOptions): Promise<boolean> {
  const tasks: Promise<unknown>[] = [];

  const ntfyUrl = process.env.NTFY_URL;
  if (ntfyUrl) {
    const body = new URLSearchParams({ title: options.title, message: options.message });
    if (options.priority) body.set('priority', options.priority);
    if (options.url) body.set('click', options.url);
    tasks.push(
      axios.post(ntfyUrl, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: HTTP_TIMEOUT_MS,
      })
    );
  }

  const haWebhookUrl = process.env.HA_WEBHOOK_URL;
  if (haWebhookUrl) {
    tasks.push(
      axios.post(
        haWebhookUrl,
        {
          title: options.title,
          message: options.message,
          url: options.url,
        },
        { timeout: HTTP_TIMEOUT_MS }
      )
    );
  }

  if (tasks.length === 0) return true;

  const results = await Promise.allSettled(tasks);
  let delivered = false;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      delivered = true;
    } else {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.warn('Notification delivery failed:', reason);
    }
  }
  return delivered;
}

/** Whether a notification for `reason` was already sent within the dedupe window. */
export function isDuplicateNotification(
  lastNotifiedAt: string | undefined,
  lastNotifiedReason: string | undefined,
  reason: string,
  nowMs = Date.now()
): boolean {
  const last = lastNotifiedAt ? Date.parse(lastNotifiedAt) : NaN;
  return (
    Number.isFinite(last) && nowMs - last < DEDUPE_WINDOW_MS && lastNotifiedReason === reason
  );
}

/**
 * Send a notification for a connection at most once per 24h *per reason*,
 * recording the time/reason in tokens.json so restarts don't cause a
 * notification storm and a more urgent reason isn't suppressed by a milder one.
 *
 * The dedupe marker is written under the state lock before delivery so
 * concurrent callers can't both send. If every delivery fails the marker is
 * cleared again, so a transient outage retries on the next sync instead of
 * suppressing the alert for 24h.
 */
export async function notifyConnection(
  connectionId: string,
  reason: string,
  options: NotifyOptions
): Promise<void> {
  try {
    let shouldSend = false;
    await withStateLock(async () => {
      const current = getConnection(connectionId);
      if (!current) return;
      if (isDuplicateNotification(current.lastNotifiedAt, current.lastNotifiedReason, reason)) {
        logger.debug(`[${connectionId}] Suppressing duplicate ${reason} notification`);
        return;
      }
      saveConnection(connectionId, {
        ...current,
        lastNotifiedAt: new Date().toISOString(),
        lastNotifiedReason: reason,
      });
      shouldSend = true;
    });

    if (!shouldSend) return;

    const delivered = await notify(options);
    if (!delivered) {
      await updateConnection(connectionId, {
        lastNotifiedAt: undefined,
        lastNotifiedReason: undefined,
      });
      logger.warn(
        `[${connectionId}] Notification was not delivered; it will be retried on the next run.`
      );
    }
  } catch (err) {
    logger.warn(
      `[${connectionId}] Notification failed:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
