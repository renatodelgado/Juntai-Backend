require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { AppDataSource } = require('../src/shared/database/data-source');
const { requestPasswordRecovery, resetPassword } = require('../src/modules/auth/services/PasswordRecoveryService');

test('recovery sends a fragment link and consumes a hashed token once', async () => {
  const originalTransaction = AppDataSource.transaction;
  const originalFetch = global.fetch;
  const oldEnv = { ...process.env };
  Object.assign(process.env, { ACS_EMAIL_ENDPOINT: 'https://example.communication.azure.com', ACS_EMAIL_ACCESS_KEY: Buffer.from('test-key').toString('base64'), ACS_EMAIL_SENDER: 'sender@example.invalid', PASSWORD_RESET_FRONTEND_URL: 'https://frontend.example/redefinir-senha' });
  let savedTokenHash, passwordHash, link, lastAuthorization;
  const manager = { async query(sql, args) {
    if (sql.startsWith('SELECT id FROM usuarios')) return args[0] === 'user@example.invalid' ? [{ id: 'user' }] : [];
    if (sql.startsWith('SELECT 1 FROM password_recovery')) return [];
    if (sql.startsWith('INSERT INTO password_recovery')) { savedTokenHash = args[0]; return []; }
    if (sql.startsWith('WITH consumed AS')) {
      if (savedTokenHash !== args[0]) return [];
      savedTokenHash = null;
      return [{ user_id: 'user' }];
    }
    if (sql.startsWith('WITH updated AS')) { passwordHash = args[0]; return [{ id: 'user' }]; }
    return [];
  } };
  AppDataSource.transaction = async (callback) => callback(manager);
  global.fetch = async (url, options) => {
    assert.equal(url.toString(), 'https://example.communication.azure.com/emails:send?api-version=2023-03-31');
    lastAuthorization = options.headers.Authorization;
    link = JSON.parse(options.body).content.plainText.match(/https:\/\/\S+/)[0];
    return { ok: true };
  };
  try {
    await requestPasswordRecovery(' USER@example.invalid ');
    const token = new URL(link).hash.slice(1);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.notEqual(token, savedTokenHash);
    assert.match(lastAuthorization, /^HMAC-SHA256 /);
    await resetPassword(token, 'new-password');
    assert.ok(await bcrypt.compare('new-password', passwordHash));
    await assert.rejects(resetPassword(token, 'new-password'), /inválido ou expirado/);
    await assert.rejects(resetPassword(token, 'short'), /requisitos/);
  } finally {
    AppDataSource.transaction = originalTransaction;
    global.fetch = originalFetch;
    process.env = oldEnv;
  }
});
