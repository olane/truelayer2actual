import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { createApp, hostAllowed } from '../src/web/server.js';

describe('hostAllowed (DNS-rebinding defence)', () => {
  it('allows IP literals, localhost, LAN and Tailscale names', () => {
    for (const host of [
      '127.0.0.1:3000',
      '192.168.1.73:3000',
      '[::1]:3000',
      'localhost:3000',
      'nas:3000',
      'diskstation.local:3000',
      'nas.home.arpa',
      'nas.tail1234.ts.net',
      'NAS.LOCAL.',
    ]) {
      assert.equal(hostAllowed(host), true, host);
    }
  });

  it('rejects public domain names that are not configured', () => {
    for (const host of ['evil.example.com', 'evil.example.com:3000', 'localhost.evil.com', 'local.evil.com']) {
      assert.equal(hostAllowed(host), false, host);
    }
  });

  it('allows the DASHBOARD_URL host and ALLOWED_HOSTS entries', () => {
    process.env.DASHBOARD_URL = 'https://dash.example.com';
    process.env.ALLOWED_HOSTS = ' budget.example.org , other.example.net:8443 ';
    try {
      assert.equal(hostAllowed('dash.example.com'), true);
      assert.equal(hostAllowed('budget.example.org:3000'), true);
      assert.equal(hostAllowed('other.example.net'), true);
      assert.equal(hostAllowed('evil.example.com'), false);
    } finally {
      delete process.env.DASHBOARD_URL;
      delete process.env.ALLOWED_HOSTS;
    }
  });

  it('treats a missing Host as allowed (non-browser client)', () => {
    assert.equal(hostAllowed(undefined), true);
  });
});

describe('dashboard security headers', () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    const app = createApp();
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = (server.address() as AddressInfo).port;
  });

  after(() => server.close());

  interface Res {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }

  function request(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<Res> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        }
      );
      req.on('error', reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  it('sets hardening headers and a nonce-based CSP', async () => {
    const res = await request('/');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'same-origin');
    assert.equal(res.headers['cache-control'], 'no-store');
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  });

  it('rejects a GET with a foreign Host (rebinding)', async () => {
    const res = await request('/', { headers: { Host: 'rebind.attacker.example:3000' } });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /Add bank/);
  });

  it('rejects a rebinding POST even when Origin matches its Host', async () => {
    const res = await request('/sync', {
      method: 'POST',
      headers: {
        Host: 'rebind.attacker.example:3000',
        Origin: 'http://rebind.attacker.example:3000',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '',
    });
    assert.equal(res.status, 403);
  });

  it('rejects a POST whose Origin is a different site', async () => {
    const res = await request('/sync', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: '',
    });
    assert.equal(res.status, 403);
  });

  it('rejects a POST marked cross-site by Sec-Fetch-Site', async () => {
    const res = await request('/sync', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      body: '',
    });
    assert.equal(res.status, 403);
  });

  it('rejects a same-site sibling Origin instead of trusting same-site', async () => {
    process.env.DASHBOARD_URL = 'https://dash.olane.dev/dashboard/';
    try {
      const res = await request('/sync', {
        method: 'POST',
        headers: {
          Host: 'dash.olane.dev',
          Origin: 'https://evil.olane.dev',
          'Sec-Fetch-Site': 'same-site',
        },
        body: '',
      });
      assert.equal(res.status, 403);
    } finally {
      delete process.env.DASHBOARD_URL;
    }
  });

  it('rejects same-site even when the Origin matches the request host', async () => {
    process.env.DASHBOARD_URL = 'https://dash.olane.dev';
    try {
      const res = await request('/sync', {
        method: 'POST',
        headers: {
          Host: 'dash.olane.dev',
          Origin: 'https://dash.olane.dev',
          'Sec-Fetch-Site': 'same-site',
        },
        body: '',
      });
      assert.equal(res.status, 403);
    } finally {
      delete process.env.DASHBOARD_URL;
    }
  });

  it('matches Origin against Host case-insensitively', async () => {
    const res = await request('/pair', {
      method: 'POST',
      headers: {
        Host: 'NAS.LOCAL',
        Origin: 'http://nas.local',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '',
    });
    // Reaches the route and rejects the empty body rather than blocking at the gate.
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 400);
  });

  it('matches Host with a default port or trailing dot', async () => {
    const res = await request('/pair', {
      method: 'POST',
      headers: {
        Host: 'NAS.LOCAL.:443',
        Origin: 'https://nas.local',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '',
    });
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 400);
  });

  it('allows an Origin matching DASHBOARD_URL when the request Host differs', async () => {
    process.env.DASHBOARD_URL = 'https://DASH.OLANE.DEV/dashboard/';
    try {
      const res = await request('/pair', {
        method: 'POST',
        headers: {
          Origin: 'https://dash.olane.dev',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: '',
      });
      assert.notEqual(res.status, 403);
      assert.equal(res.status, 400);
    } finally {
      delete process.env.DASHBOARD_URL;
    }
  });

  it('rejects an opaque Origin (null)', async () => {
    const res = await request('/sync', {
      method: 'POST',
      headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
      body: '',
    });
    assert.equal(res.status, 403);
  });

  it('still serves GET requests with cross-site headers', async () => {
    const res = await request('/', {
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(res.status, 200);
  });

  it('allows a POST with no Origin (curl/non-browser)', async () => {
    const res = await request('/pair', { method: 'POST', body: '' });
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 400);
  });

  it('keeps /healthz reachable whatever the Host, without leaking ids', async () => {
    const res = await request('/healthz', { headers: { Host: 'anything.example.com' } });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body) as { connections: unknown[] };
    assert.ok(Array.isArray(json.connections));
    assert.doesNotMatch(res.body, /provider/i);
  });
});
