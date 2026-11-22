process.env.JWT_SECRET ||= 'ci-tests-only-not-a-deployment-secret';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { AppDataSource } = require('../src/shared/database/data-source');
const { ensureAuthenticated } = require('../src/shared/middlewares/ensureAuthenticated');

test('password reset version invalidates previously issued sessions', async () => {
  const original = AppDataSource.query;
  let version = 0;
  AppDataSource.query = async () => [{ tipo_perfil: 'startup', session_version: version, ativo: true }];
  const token = jwt.sign({ tipoPerfil: 'startup', sessionVersion: 0 }, process.env.JWT_SECRET, { subject: 'user' });
  async function verify() {
    let status = 200, nextCalled = false;
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = { status(value) { status = value; return this; }, json() { return this; } };
    await ensureAuthenticated(req, res, () => { nextCalled = true; });
    return { status, nextCalled };
  }
  try {
    assert.deepEqual(await verify(), { status: 200, nextCalled: true });
    version++;
    assert.deepEqual(await verify(), { status: 401, nextCalled: false });
  } finally { AppDataSource.query = original; }
});
