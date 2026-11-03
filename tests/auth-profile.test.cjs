process.env.JWT_SECRET = 'test-only-secret';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/modules/auth/services/AuthService');
const { AppDataSource } = require('../src/shared/database/data-source');
const { Startup } = require('../src/modules/startups/entities/Startup');
const { Investidor } = require('../src/modules/investidores/entities/Investidor');
const { Usuario } = require('../src/modules/usuarios/entities/Usuario');

for (const [role, entity] of [['startup', Startup], ['investidor', Investidor]]) {
  test(`loads only the authenticated ${role} profile without the user relation`, async (t) => {
    const service = new AuthService();
    t.mock.method(service.usuarioRepository, 'findById', async (id) => ({ id, ativo: true, tipoPerfil: role }));
    t.mock.method(AppDataSource, 'getRepository', (target) => {
      if (role === 'investidor' && target === Usuario) {
        return { findOne: async (options) => {
          assert.deepEqual(options, { select: { id: true, avatarUrl: true }, where: { id: 'current-user' } });
          return { id: 'current-user', avatarUrl: 'https://example.com/avatar.png' };
        } };
      }
      assert.equal(target, entity);
      return { findOne: async (options) => {
        assert.deepEqual(options, { where: { usuario: { id: 'current-user' } } });
        return { id: 'own-profile' };
      } };
    });
    assert.deepEqual(await service.profile('current-user'), {
      id: 'own-profile',
      ...(role === 'investidor' ? { avatarUrl: 'https://example.com/avatar.png' } : {}),
    });
  });
}

test('inactive accounts cannot read profiles', async (t) => {
  const service = new AuthService();
  t.mock.method(service.usuarioRepository, 'findById', async () => ({ ativo: false }));
  const repository = t.mock.method(AppDataSource, 'getRepository', () => { throw new Error('Must not query profile'); });
  await assert.rejects(service.profile('inactive'), (error) => error.statusCode === 401);
  assert.equal(repository.mock.callCount(), 0);
});

test('missing profile returns 404', async (t) => {
  const service = new AuthService();
  t.mock.method(service.usuarioRepository, 'findById', async (id) => ({ id, ativo: true, tipoPerfil: 'startup' }));
  t.mock.method(AppDataSource, 'getRepository', () => ({ findOne: async () => null }));
  await assert.rejects(service.profile('no-profile'), (error) => error.statusCode === 404);
});
