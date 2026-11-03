process.env.JWT_SECRET = 'synthetic-unit-test-secret-only';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/matchmaking-contract.json'), 'utf8'));
const { MatchmakingClient } = require('../src/modules/matchmaking/MatchmakingClient');
const { MatchmakingService, profileRevision } = require('../src/modules/matchmaking/MatchmakingService');
const { issueContext, readContext } = require('../src/modules/matchmaking/ExposureContext');
const { matchmakingRoutes } = require('../src/modules/matchmaking/matchmaking.routes');
const { investorFeatures, startupFeatures, project } = require('../src/modules/matchmaking/contracts');
const { StartupInterestService } = require('../src/modules/startups/services/StartupInterestService');
const clone = value => structuredClone(value);

test('cliente valida contrato real do FastAPI e envia apenas /match/rules', async () => {
  const client = new MatchmakingClient(async (url, options) => {
    assert.equal(url.pathname, '/match/rules');
    assert.deepEqual(JSON.parse(options.body), fixture.request);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(fixture.response));
  });
  assert.deepEqual(await client.rules(fixture.request), fixture.response);
});
test('payload inválido não chama transporte', async () => {
  const client = new MatchmakingClient(() => { throw Error('transporte não deveria executar'); });
  await assert.rejects(client.rules({ ...fixture.request, investidor: { id: 'bad' } }), e => e.statusCode === 502);
});
test('JSON inválido é 502 e propriedades extras internas são removidas', async () => {
  await assert.rejects(new MatchmakingClient(async () => new Response('not JSON')).rules(fixture.request), e => e.statusCode === 502);
  const upstream = clone(fixture.response);
  upstream.recomendacoes[0].internalTrace = 'do-not-return';
  upstream.recomendacoes[0].criterios.ajuda.internalTrace = 'do-not-return';
  const result = await new MatchmakingClient(async () => new Response(JSON.stringify(upstream))).rules(fixture.request);
  assert.ok(!JSON.stringify(result).includes('do-not-return'));
});
for (const status of [422, 500, 503]) test(`HTTP ${status} é sanitizado`, async () => {
  const client = new MatchmakingClient(async () => new Response('segredo interno', { status }));
  await assert.rejects(client.rules(fixture.request), e => !e.message.includes('segredo') && e.statusCode === (status >= 500 ? 503 : 502));
});
test('indisponibilidade e timeout', async () => {
  await assert.rejects(new MatchmakingClient(async () => { throw Error('internal host'); }).rules(fixture.request), e => e.statusCode === 503 && !e.message.includes('host'));
  const previous = process.env.MATCHMAKING_TIMEOUT_MS;
  process.env.MATCHMAKING_TIMEOUT_MS = '5';
  try {
    const client = new MatchmakingClient((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })));
    await assert.rejects(client.rules(fixture.request), e => e.statusCode === 504);
  } finally { if (previous === undefined) delete process.env.MATCHMAKING_TIMEOUT_MS; else process.env.MATCHMAKING_TIMEOUT_MS = previous; }
});
for (const mutate of [r => r.recomendacoes[0].startupId = 'foreign', r => r.recomendacoes[0].score = 2, r => delete r.recomendacoes[0].criterios.ajuda, r => r.investidorId = 'other']) test('resposta inválida rejeitada', async () => {
  const result = clone(fixture.response); mutate(result);
  await assert.rejects(new MatchmakingClient(async () => new Response(JSON.stringify(result))).rules(fixture.request), e => e.statusCode === 502);
});

function fakeStore() {
  const investor = { ...clone(fixture.request.investidor), atualizadoEm: new Date('2026-01-01'), statusModeracao: 'aprovado', nome: 'DO NOT EXPORT', usuario: { ...fixture.request.investidor.usuario, tipoPerfil: 'investidor', senhaHash: 'DO NOT EXPORT' } };
  const startup = { ...clone(fixture.request.startups[0]), atualizadoEm: new Date('2026-01-01'), nomeFantasia: 'Synthetic', usuario: { ...fixture.request.startups[0].usuario, tipoPerfil: 'startup', senhaHash: 'DO NOT EXPORT' } };
  let saved = null;
  const calls = [];
  const candidates = [startup];
  function repository(entity) {
    const isInvestor = entity.name === 'Investidor';
    const query = new Proxy({}, { get(_target, name) {
      if (name === 'getOne') return async () => isInvestor ? investor : startup;
      if (name === 'getMany') return async () => candidates;
      if (name === 'getCount') return async () => candidates.length;
      if (name === 'getRawMany') return async () => [{ estado: 'PE', segmento: 'agtech', regioes: ['nordeste'] }];
      return () => query;
    } });
    return { createQueryBuilder: () => query };
  }
  const manager = { getRepository: repository, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith('INSERT')) { saved = { id: values[0], ocorrido_em: new Date('2026-01-01T00:00:00Z') }; return [saved]; }
    return saved ? [saved] : [];
  } };
  const db = { manager, getRepository: repository, transaction: async fn => fn(manager) };
  return { investor, startup, calls, candidates, db, context: () => issueContext({ investorId: investor.id, startupId: startup.id, investorRevision: profileRevision(investor, true), startupRevision: profileRevision(startup, false), origin: 'rules', position: 1, version: '1a-v3' }) };
}
test('cálculo não persiste exposição, payload exclui informações pessoais', async () => {
  const store = fakeStore();
  const service = new MatchmakingService(store.db, { async rules(payload) {
    assert.ok(!JSON.stringify(payload).includes('DO NOT EXPORT'));
    return fixture.response;
  } });
  const response = await service.recommend(fixture.request.investidor.usuario.id, 24);
  assert.equal(response.recomendacoes.length, 1);
  assert.equal(store.calls.length, 0);
  assert.equal(readContext(response.recomendacoes[0].contextoExposicao).investorId, store.investor.id);
});
test('descoberta mantém paginação, contexto e dados públicos sem persistir exposições', async () => {
  const store = fakeStore();
  const result = await new MatchmakingService(store.db).discovery(fixture.request.investidor.usuario.id, { page: '0', size: '24', sort: 'recent' });
  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.items[0].usuario, undefined);
  assert.equal(readContext(result.items[0].contextoExposicao).origin, 'discovery');
  assert.deepEqual(result.facets, { locations: ['PE'], segments: 1, regions: 1 });
  assert.equal(store.calls.length, 0);
});
test('descoberta por compatibilidade usa score real e não retorna relação usuário', async () => {
  const store = fakeStore();
  const service = new MatchmakingService(store.db, { rules: async () => fixture.response });
  const result = await service.discovery(fixture.request.investidor.usuario.id, { sort: 'compatibility' });
  assert.equal(result.items[0].compatibility, 100);
  assert.equal(result.items[0].usuario, undefined);
  assert.equal(readContext(result.items[0].contextoExposicao).origin, 'rules');
  assert.equal(store.calls.length, 0);
});
test('mais de 10.000 candidatas usam lotes e ranking global determinístico', async () => {
  const store = fakeStore();
  for (let n = 1; n <= 10000; n++) store.candidates.push({ ...store.startup, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
  const sizes = [];
  const service = new MatchmakingService(store.db, { async rules(payload) {
    sizes.push(payload.startups.length);
    const result = clone(fixture.response);
    result.recomendacoes[0].startupId = payload.startups[0].id;
    return result;
  } });
  const result = await service.recommend(fixture.request.investidor.usuario.id, 1);
  assert.deepEqual(sizes, [10000, 1]);
  assert.equal(result.recomendacoes.length, 1);
  assert.equal(result.recomendacoes[0].startupId, store.candidates[10000].id);
  assert.equal(store.calls.length, 0);
});
test('confirmação idempotente, snapshot minimizado e sem alterar interesses', async () => {
  const store = fakeStore();
  const service = new MatchmakingService(store.db);
  const token = store.context();
  assert.deepEqual(await service.confirmExposure(fixture.request.investidor.usuario.id, token), await service.confirmExposure(fixture.request.investidor.usuario.id, token));
  const inserts = store.calls.filter(c => c.sql.startsWith('INSERT'));
  assert.equal(inserts.length, 1);
  assert.ok(!inserts[0].values[6].includes('DO NOT EXPORT'));
  assert.ok(store.calls.every(c => !c.sql.includes('funil_interacoes')));
  assert.deepEqual(JSON.parse(inserts[0].values[6]), {
    investidor: project(store.investor, investorFeatures), startup: project(store.startup, startupFeatures),
  });
});
test('contexto de outro investidor e token adulterado rejeitados', async () => {
  const store = fakeStore(); const token = store.context();
  store.investor.id = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(new MatchmakingService(store.db).confirmExposure(fixture.request.investidor.usuario.id, token), e => e.statusCode === 403);
  assert.throws(() => readContext(token + 'x'));
  assert.equal(store.calls.length, 0);
});
test('snapshot obsoleto e startup inelegível não geram exposição', async () => {
  const store = fakeStore(); const token = store.context();
  store.startup.segmento = 'fintech';
  await assert.rejects(new MatchmakingService(store.db).confirmExposure(fixture.request.investidor.usuario.id, token), e => e.statusCode === 409);
  store.startup.statusModeracao = 'suspenso';
  await assert.rejects(new MatchmakingService(store.db).confirmExposure(fixture.request.investidor.usuario.id, token), e => e.statusCode === 404);
  assert.equal(store.calls.filter(c => c.sql.startsWith('INSERT')).length, 0);
});
test('investidor pendente não consulta candidatas', async () => {
  const store = fakeStore(); store.investor.statusModeracao = 'pendente';
  await assert.rejects(new MatchmakingService(store.db).recommend(fixture.request.investidor.usuario.id, 24), e => e.statusCode === 403);
});

test('rotas: autenticação, RBAC, validação e identidade derivada do JWT', async () => {
  const calls = [];
  const service = { recommend: async (user, limit) => { calls.push([user, limit]); return {}; }, confirmExposure: async () => ({}) };
  const router = matchmakingRoutes(service);
  async function invoke(url, role, body, method = 'GET') {
    const headers = role ? { authorization: 'Bearer ' + jwt.sign({ tipoPerfil: role }, process.env.JWT_SECRET, { subject: 'authenticated-user' }) } : {};
    const req = { method, url, headers, query: {}, body };
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { resolve({ status: this.statusCode, value }); } };
      router.handle(req, res, reject);
    });
  }
  assert.equal((await invoke('/recomendacoes')).status, 401);
  assert.equal((await invoke('/recomendacoes', 'startup')).status, 403);
  assert.equal((await invoke('/recomendacoes', 'investidor')).status, 200);
  assert.deepEqual(calls, [['authenticated-user', 24]]);
  assert.equal((await invoke('/exposicoes', 'investidor', { contexto: 'x', investidor_id: 'arbitrary' }, 'POST')).status, 400);
});
test('interesse continua idempotente e preserva a primeira data', async t => {
  const { AppDataSource } = require('../src/shared/database/data-source');
  let interest = null;
  let inserts = 0;
  t.mock.method(AppDataSource, 'transaction', async callback => callback({ query: async (sql) => {
    assert.ok(!sql.includes('exposicoes_startups'));
    if (sql.includes('FROM investidores')) return [{ id: fixture.request.investidor.id, ativo: true, perfil: 'investidor', status: 'aprovado' }];
    if (sql.includes('FROM startups')) return [{ id: fixture.request.startups[0].id, ativo: true, status: 'aprovado', nome: 'Synthetic', usuario_id: fixture.request.startups[0].usuario.id }];
    if (sql.startsWith('INSERT')) { inserts++; interest = { ocorrido_em: '2026-01-01T00:00:00Z' }; return [interest]; }
    return interest ? [interest] : [];
  } }));
  const service = new StartupInterestService();
  const first = await service.confirm(fixture.request.investidor.usuario.id, fixture.request.startups[0].id);
  assert.deepEqual(await service.confirm(fixture.request.investidor.usuario.id, fixture.request.startups[0].id), first);
  assert.equal(inserts, 1);
});
