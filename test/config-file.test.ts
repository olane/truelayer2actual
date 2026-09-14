import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// config.ts resolves its paths from process.cwd() at import time, so chdir to
// a scratch directory before importing it. The test runner runs each file in
// its own process, so this does not affect other tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2a-config-'));
const dataDir = path.join(tmpDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.chdir(tmpDir);

const { loadConfig, loadConfigIfPresent, addBudget, ConfigNotFoundError } = await import(
  '../src/config.js'
);

const configPath = path.join(dataDir, 'config.json');

describe('config file safety', () => {
  before(() => {
    fs.writeFileSync(configPath, '{ not valid json');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws instead of returning null for a corrupt config', async () => {
    await assert.rejects(loadConfigIfPresent(), /Failed to read or parse/);
  });

  it('does not overwrite a corrupt config when adding a budget', async () => {
    await assert.rejects(
      addBudget({ id: 'b1', name: 'Budget', syncId: 'sync-1' }),
      /Failed to read or parse/
    );
    assert.equal(fs.readFileSync(configPath, 'utf-8'), '{ not valid json');
  });

  it('returns null only when the file is missing', async () => {
    fs.rmSync(configPath, { force: true });
    assert.equal(await loadConfigIfPresent(), null);
    await assert.rejects(loadConfig(), (err: unknown) => err instanceof ConfigNotFoundError);
  });
});
