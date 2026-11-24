require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { AdvancedConsoleLogger, QueryFailedError } = require('typeorm');
const app = require('../src/App').default;
const { AppDataSource } = require('../src/shared/database/data-source');
const { authConfig } = require('../src/shared/config/auth');
const { ModeracaoQueryLogger } = require('../src/modules/moderacao/infra/ModeracaoQueryLogger');
const { AdminDenunciaService } = require('../src/modules/moderacao/services/AdminDenunciaService');
const { sancoesService } = require('../src/modules/moderacao/services/SancaoService');

const privado = 'MARCADOR-PRIVADO-DE-TESTE';

function logs(Logger, sql, parametros) {
  const logger = new Logger(true);
  const saida = [];
  logger.writeLog = (nivel, mensagens) => saida.push({ nivel, mensagens });
  logger.logQuery(sql, parametros);
  logger.logQueryError('Erro contendo ' + privado, sql, parametros);
  logger.logQuerySlow(30, sql, parametros);
  return saida;
}

test('logger protege justificativas, snapshots e erros do SQL de moderação', () => {
  for (const [sql, parametros] of [
    ['INSERT INTO "denuncias" ("evidencia_snapshot") VALUES ($1)', [privado]],
    ['INSERT INTO "sancoes" ("motivo") VALUES ($1)', [privado]],
    ['INSERT INTO "log_auditoria" ("entidade_tipo", "detalhes") VALUES ($1,$2)', ['denuncia', privado]],
    ['INSERT INTO "log_auditoria" ("entidade_tipo", "detalhes") VALUES ($1,$2)', ['sancao', privado]],
  ]) {
    assert.ok(!JSON.stringify(logs(ModeracaoQueryLogger, sql, parametros)).includes(privado),
      'Vazamento de parâmetros ou mensagem do driver no log de moderação');
  }
  const legado = ['INSERT INTO "log_auditoria" ("entidade_tipo") VALUES ($1)', ['startup']];
  assert.deepEqual(logs(ModeracaoQueryLogger, ...legado), logs(AdvancedConsoleLogger, ...legado));
});

test('falha inesperada em decisão administrativa não registra parâmetros privados nem os envia ao cliente', async t => {
  t.mock.method(sancoesService, 'verificarAcesso', async () => {});
  t.mock.method(AppDataSource, 'getRepository', () => ({
    findOneBy: async () => ({ ativo: true, tipoPerfil: 'admin' }),
  }));
  const erro = new QueryFailedError('INSERT INTO "log_auditoria" VALUES ($1)', [privado],
    Object.assign(new Error('Falha ' + privado), { code: '23514' }));
  t.mock.method(AdminDenunciaService.prototype, 'decidir', async () => { throw erro; });
  const logger = t.mock.method(console, 'error', () => {});
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const token = jwt.sign({ tipoPerfil: 'admin' }, authConfig.secret, { subject: randomUUID() });
  const resposta = await fetch(`http://127.0.0.1:${server.address().port}/admin/denuncias/${randomUUID()}/decisao`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ procedente: true, justificativa: privado }),
  });
  assert.equal(resposta.status, 500);
  assert.deepEqual(await resposta.json(), { message: 'Erro interno do servidor.' });
  assert.ok(logger.mock.callCount() > 0);
  assert.ok(logger.mock.calls.every(({ arguments: args }) =>
    !args.includes(erro) && !JSON.stringify(args).includes(privado)));
});
