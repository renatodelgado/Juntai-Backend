process.env.JWT_SECRET = 'synthetic-unit-test-secret-only';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DiscoveryInteractions } = require('../src/modules/matchmaking/DiscoveryInteractions');
const investorId = '11111111-1111-4111-8111-111111111111';
const startupId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';

function store() {
  const events = new Set();
  let saved = false;
  const manager = { async query(sql, values) {
    if (sql.startsWith('SELECT s.id')) return [{ id: startupId }];
    if (sql.startsWith('INSERT INTO interacoes')) {
      if (events.has(values[0])) return [];
      events.add(values[0]); return [{ id: values[0] }];
    }
    if (sql.startsWith('INSERT INTO startups_salvas')) saved = true;
    if (sql.startsWith('DELETE FROM startups_salvas')) saved = false;
    return [];
  } };
  const db = { transaction: async fn => fn(manager), query: async () => saved ? [{ id: startupId }] : [] };
  const matcher = { actor: async () => ({ id: investorId }) };
  return { service: new DiscoveryInteractions(db, matcher), get saved() { return saved; } };
}
test('salvar e remover persistem separadamente do interesse; retries são idempotentes', async () => {
  const s = store();
  await s.service.record(investorId, startupId, { eventId, tipo: 'salvou' });
  assert.equal(s.saved, true);
  assert.deepEqual(await s.service.saved(investorId), [startupId]);
  await s.service.record(investorId, startupId, { eventId: '44444444-4444-4444-8444-444444444444', tipo: 'removeu_salvo' });
  await s.service.record(investorId, startupId, { eventId, tipo: 'salvou' });
  assert.equal(s.saved, false);
});
test('valida evento e duração antes de gravar', async () => {
  const { service } = store();
  for (const body of [
    { eventId, tipo: 'tempo_perfil', segundos: 9 },
    { eventId, tipo: 'tempo_perfil', segundos: 301 },
    { eventId, tipo: 'perfil_aberto', segundos: 20 },
    { eventId, tipo: 'interesse_demonstrado' },
    { eventId, tipo: 'salvou', investidorId: investorId },
  ]) await assert.rejects(service.record(investorId, startupId, body), e => e.statusCode === 400);
  await service.record(investorId, startupId, { eventId, tipo: 'tempo_perfil', segundos: 10 });
});
