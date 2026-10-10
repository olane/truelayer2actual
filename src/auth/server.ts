import http from 'http';
import crypto from 'crypto';
import express, { type Express } from 'express';
import { logger } from '../logger.js';
import { escapeHtml } from '../util/html.js';

export interface AuthServer {
  app: Express;
  server: http.Server;
  waitForCode: () => Promise<string>;
  /** State value that must be appended to the authorization URL. */
  authState: string;
}

function failPage(title: string, message: string): string {
  return `
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
      <body>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <p>Please close this tab and check the terminal for details.</p>
      </body>
    </html>
  `;
}

export async function startAuthServer(port: number): Promise<AuthServer> {
  const app = express();

  // State parameter binds the callback to this flow: a crafted callback URL
  // from another host cannot inject its own authorization code. Only the exact
  // state issued by startAuthServer is accepted.
  const authState = crypto.randomBytes(16).toString('hex');

  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  app.get('/callback', (req, res) => {
    const code = req.query['code'];
    const error = req.query['error'];

    if (req.query['state'] !== authState) {
      const msg = 'Invalid or missing OAuth state on callback';
      logger.error(msg);
      res.status(400).type('html').send(failPage('Authentication Failed', msg));
      rejectCode(new Error(msg));
      return;
    }

    if (error) {
      const errorDescription =
        (req.query['error_description'] as string | undefined) ?? String(error);
      logger.error(`OAuth error from TrueLayer: ${errorDescription}`);
      res.status(400).type('html').send(
        failPage('Authentication Failed', `Error: ${String(error)} — ${errorDescription}`)
      );
      rejectCode(new Error(`OAuth error: ${errorDescription}`));
      return;
    }

    if (typeof code !== 'string' || !code) {
      const msg = 'No authorization code received from TrueLayer';
      logger.error(msg);
      res.status(400).type('html').send(failPage('Authentication Failed', msg));
      rejectCode(new Error(msg));
      return;
    }

    logger.info('Authorization code received successfully');

    res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><title>Authentication Successful</title></head>
        <body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center;">
          <h2 style="color: #22c55e;">Authentication successful!</h2>
          <p>You can close this tab and return to the terminal to finish setup.</p>
        </body>
      </html>
    `);

    resolveCode(code);
  });

  // Loopback only: the OAuth redirect targets localhost, so there is no
  // reason to accept callbacks (or crafted ones) from other machines.
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => {
      logger.info(`Auth server listening on http://localhost:${port}`);
      resolve(s);
    });
    s.on('error', (err) => {
      reject(
        new Error(
          `Failed to start auth server on port ${port}: ${err.message}. ` +
            'Try setting a different SETUP_PORT in your .env file.'
        )
      );
    });
  });

  return {
    app,
    server,
    waitForCode: () => codePromise,
    authState,
  };
}
