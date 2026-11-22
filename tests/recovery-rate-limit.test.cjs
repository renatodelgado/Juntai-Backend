process.env.JWT_SECRET ||= 'ci-tests-only-not-a-deployment-secret';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AppDataSource } = require('../src/shared/database/data-source');
const { recoveryRateLimit } = require('../src/modules/auth/routes/recoveryRateLimit');

test('recovery limits fail closed and reject excess requests', async () => {
  const original = AppDataSource.query;
  let attempts = 20;
  AppDataSource.query = async () => [{ attempts }];
  async function call() {
    let status = 200, nextCalled = false;
    const res = { status(value) { status = value; return this; }, json() { return this; } };
    await recoveryRateLimit({ socket: { remoteAddress: '127.0.0.1' }, header: () => undefined }, res, () => { nextCalled = true; });
    return { status, nextCalled };
  }
  try {
    assert.deepEqual(await call(), { status: 200, nextCalled: true });
    attempts++;
    assert.deepEqual(await call(), { status: 429, nextCalled: false });
    AppDataSource.query = async () => { throw new Error('offline'); };
    assert.deepEqual(await call(), { status: 503, nextCalled: false });
  } finally { AppDataSource.query = original; }
});

test('Azure mode uses only the rightmost forwarded address', async () => {
  const original = AppDataSource.query;
  const oldMode = process.env.RECOVERY_TRUST_AZURE_INGRESS;
  let key;
  AppDataSource.query = async (_sql, params) => { key = params[0]; return [{ attempts: 1 }]; };
  async function run(header) {
    const res = { status() { throw new Error('unexpected status'); } };
    await recoveryRateLimit({ socket: { remoteAddress: '10.0.0.1' }, header: () => header }, res, () => {});
    return key;
  }
  try {
    process.env.RECOVERY_TRUST_AZURE_INGRESS = 'true';
    assert.equal(await run('198.51.100.1, 203.0.113.2'), await run('198.51.100.5, 203.0.113.2'));
    assert.notEqual(await run('198.51.100.1, 203.0.113.2'), await run('198.51.100.1, 203.0.113.3'));
    process.env.RECOVERY_TRUST_AZURE_INGRESS = 'false';
    assert.equal(await run('198.51.100.1'), await run('198.51.100.5'));
  } finally {
    AppDataSource.query = original;
    if (oldMode === undefined) delete process.env.RECOVERY_TRUST_AZURE_INGRESS;
    else process.env.RECOVERY_TRUST_AZURE_INGRESS = oldMode;
  }
});
