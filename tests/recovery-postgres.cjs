// Only runs against an explicitly named disposable local test database.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
process.env.JWT_SECRET = 'integration-test-only';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = process.env.RECOVERY_TEST_PORT;
process.env.DB_USER = 'postgres';
process.env.DB_PASSWORD = 'recovery-test-only';
process.env.DB_NAME = 'recovery_test';
process.env.NODE_ENV = 'production';
Object.assign(process.env, { ACS_EMAIL_ENDPOINT: 'https://example.communication.azure.com', ACS_EMAIL_ACCESS_KEY: Buffer.from('test-key').toString('base64'), ACS_EMAIL_SENDER: 'sender@example.invalid', PASSWORD_RESET_FRONTEND_URL: 'https://frontend.example/redefinir-senha' });
if (!/^\d+$/.test(process.env.DB_PORT || '')) throw new Error('RECOVERY_TEST_PORT must identify a disposable local database');
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { AppDataSource: db } = require('../src/shared/database/data-source');
const { PasswordRecovery1795000000000: Migration } = require('../src/shared/database/migrations/1795000000000-PasswordRecovery');
const { requestPasswordRecovery, resetPassword } = require('../src/modules/auth/services/PasswordRecoveryService');
const { ensureAuthenticated } = require('../src/shared/middlewares/ensureAuthenticated');
const { recoveryRateLimit } = require('../src/modules/auth/routes/recoveryRateLimit');
const jwt = require('jsonwebtoken');

(async () => {
  await db.initialize();
  try {
    assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'"))[0].n, 0, 'Database must be empty');
    await db.query('CREATE TABLE usuarios(id uuid PRIMARY KEY, email varchar(150) NOT NULL, senha_hash varchar(255) NOT NULL, tipo_perfil varchar(20) NOT NULL, ativo boolean NOT NULL, atualizado_em timestamptz NOT NULL DEFAULT now())');
    const runner = db.createQueryRunner();
    await new Migration().up(runner);
    for (let attempt = 1; attempt <= 21; attempt++) {
      let rateStatus = 200;
      await recoveryRateLimit({ socket: { remoteAddress: '127.0.0.10' }, header: () => undefined }, { status(n) { rateStatus = n; return this; }, json() { return this; } }, () => {});
      assert.equal(rateStatus, attempt <= 20 ? 200 : 429);
    }
    const id = randomUUID();
    await db.query("INSERT INTO usuarios(id,email,senha_hash,tipo_perfil,ativo) VALUES ($1,'user@example.invalid','old','startup',true)", [id]);
    let link;
    global.fetch = async (_url, options) => { link = JSON.parse(options.body).content.plainText.match(/https:\/\/\S+/)[0]; return { ok: true }; };
    await requestPasswordRecovery('user@example.invalid');
    const token = new URL(link).hash.slice(1);
    const existing = await db.query('SELECT token_hash FROM password_recovery_tokens');
    assert.notEqual(existing[0].token_hash, token);
    const oldToken = jwt.sign({ tipoPerfil: 'startup', sessionVersion: 0 }, process.env.JWT_SECRET, { subject: id });
    const results = await Promise.allSettled([resetPassword(token, 'password-one'), resetPassword(token, 'password-two')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'Only one concurrent reset succeeds');
    assert.equal((await db.query('SELECT session_version FROM usuarios WHERE id = $1', [id]))[0].session_version, 1);
    let status = 200;
    await ensureAuthenticated({ headers: { authorization: `Bearer ${oldToken}` } }, { status(n) { status = n; return this; }, json() { return this; } }, () => { throw new Error('old session accepted'); });
    assert.equal(status, 401);
    await db.query("INSERT INTO password_recovery_tokens(token_hash,user_id,expires_at) VALUES ($1,$2,now()-interval '1 minute')", [createHash('sha256').update('a'.repeat(64)).digest('hex'), id]);
    await assert.rejects(resetPassword('a'.repeat(64), 'password-one'), /inválido ou expirado/);
    console.log('PostgreSQL: migration, hash, concurrent single use, expired token and session revocation passed.');
  } finally { await db.destroy(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
