/* Executar explicitamente: EXPOSURES_DISPOSABLE_TEST=1 node tests/exposures-postgres.cjs.
 * Não faz parte do glob *.test.cjs. Nunca usa juntai_db para escritas.
 */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
require('dotenv').config({ quiet: true });
const { execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const path = require('node:path');
const { ExposicoesStartups1793232000000 } = require('../src/shared/database/migrations/1793232000000-ExposicoesStartups');
const { MatchmakingService, profileRevision } = require('../src/modules/matchmaking/MatchmakingService');
const { issueContext, readContext } = require('../src/modules/matchmaking/ExposureContext');
const { Investidor } = require('../src/modules/investidores/entities/Investidor');
const { Startup } = require('../src/modules/startups/entities/Startup');
const { project, investorFeatures, startupFeatures } = require('../src/modules/matchmaking/contracts');

const container = 'postgres_juntai';
const sourceDatabase = 'juntai_db';
const database = `juntai_exposure_test_${randomUUID().replaceAll('-', '')}`;
const results = [];
let created = false;
let db;

function docker(args, input) {
  return execFileSync('docker', ['exec', ...(input === undefined ? [] : ['-i']), container, ...args], {
    input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 45000,
  });
}
function assertDisposable() {
  assert.match(database, /^juntai_exposure_test_[a-f0-9]{32}$/);
  assert.notEqual(database, sourceDatabase);
  assert.equal(created, true);
}
function sourceSchema() {
  return docker(['pg_dump', '-U', 'admin', '-d', sourceDatabase, '--schema-only', '--no-owner', '--no-privileges']);
}
function normalizeDump(value) {
  return value.split('\n').filter(line => !/^\\(?:un)?restrict\s/.test(line)).join('\n');
}
function mainCounts() {
  return docker(['psql', '-U', 'admin', '-d', sourceDatabase, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c',
    `BEGIN READ ONLY; SELECT json_build_array((SELECT count(*) FROM usuarios),(SELECT count(*) FROM investidores),(SELECT count(*) FROM startups),(SELECT count(*) FROM funil_interacoes),(SELECT count(*) FROM historico_investimentos),(SELECT count(*) FROM migrations)); COMMIT;`]);
}
async function check(name, fn) {
  await fn(); results.push(name); console.log(`OK: ${name}`);
}
const schemaQuery = `SELECT c.relname, a.attname, format_type(a.atttypid,a.atttypmod) AS type,
  a.attnotnull, pg_get_expr(d.adbin,d.adrelid) AS default_value
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])
  ORDER BY c.relname,a.attnum`;
async function existingState(tables) {
  const data = {};
  for (const name of tables) {
    // Nomes vêm apenas do catálogo do banco temporário, nunca de entrada externa.
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    data[name] = (await db.query(`SELECT row_to_json(t)::text AS value FROM public.${quoted} t ORDER BY row_to_json(t)::text`));
  }
  const schema = await db.query(schemaQuery, [tables]);
  const constraints = await db.query(`SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,con.conname`, [tables]);
  const indexes = await db.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename,indexname`, [tables]);
  return { data, schema, constraints, indexes };
}
const investorId = randomUUID();
const startupId = randomUUID();
const investorUser = randomUUID();
const startupUser = randomUUID();
function params(id = randomUUID()) { return [id, investorId, startupId, JSON.stringify({ investidor: { id: investorId }, startup: { id: startupId } })]; }
const insert = `INSERT INTO public.exposicoes_startups(id,investidor_id,startup_id,origem_recomendacao,snapshot_perfis)
  VALUES ($1,$2,$3,'discovery',$4::jsonb)`;
const upsert = insert + ' ON CONFLICT(id) DO NOTHING RETURNING id,ocorrido_em';

async function concurrencyScenario(commitFirst) {
  const a = db.createQueryRunner(); const b = db.createQueryRunner();
  let pending;
  try {
    await a.connect(); await b.connect();
    await a.startTransaction('READ COMMITTED'); await b.startTransaction('READ COMMITTED');
    await a.query("SET LOCAL statement_timeout='10s'");
    await b.query("SET LOCAL statement_timeout='10s'");
    const id = randomUUID();
    const first = await a.query(upsert, params(id));
    assert.equal(first.length, 1);
    const [{ pid }] = await b.query('SELECT pg_backend_pid() AS pid');
    pending = b.query(upsert, params(id));
    // Handler imediato evita rejeição não observada se statement_timeout disparar.
    pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const [activity] = await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
      if (activity?.wait_event_type === 'Lock') { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(blocked, true, 'A segunda inserção deve aguardar a primeira transação');
    if (commitFirst) await a.commitTransaction(); else await a.rollbackTransaction();
    const second = await pending;
    assert.equal(second.length, commitFirst ? 0 : 1);
    const retry = await b.query('SELECT id,ocorrido_em FROM public.exposicoes_startups WHERE id=$1 AND investidor_id=$2', [id, investorId]);
    assert.equal(retry.length, 1);
    if (commitFirst) assert.equal(retry[0].ocorrido_em.getTime(), first[0].ocorrido_em.getTime());
    await b.commitTransaction();
    assert.equal((await db.query('SELECT count(*)::int AS total FROM public.exposicoes_startups WHERE id=$1', [id]))[0].total, 1);
  } finally {
    if (a.isTransactionActive) await a.rollbackTransaction();
    if (pending) await pending.catch(() => {});
    if (b.isTransactionActive) await b.rollbackTransaction();
    await a.release(); await b.release();
  }
}

async function main() {
  assert.equal(process.env.EXPOSURES_DISPOSABLE_TEST, '1', 'Teste requer opt-in explícito');
  const baselineSchema = sourceSchema();
  const baselineCounts = mainCounts();
  try {
    // Nenhum dado de produção é copiado: somente DDL do schema restaurado.
    docker(['createdb', '-U', 'admin', '--template=template0', database]);
    created = true;
    assertDisposable();
    if (/^CREATE SCHEMA public;/m.test(baselineSchema)) docker(['psql', '-U', 'admin', '-d', database, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA public CASCADE;']);
    docker(['psql', '-U', 'admin', '-d', database, '-X', '-v', 'ON_ERROR_STOP=1'], baselineSchema);
    db = new DataSource({ type: 'postgres', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432,
      username: process.env.DB_USER, password: process.env.DB_PASSWORD, database,
      entities: [path.join(__dirname,'../src/modules/**/entities/*.ts')], migrations: [ExposicoesStartups1793232000000], synchronize: false, logging: false,
      extra: { max: 6, connectionTimeoutMillis: 10000 } });
    await db.initialize();
    assert.equal((await db.query('SELECT current_database() AS name'))[0].name, database);
    console.log(`Banco descartável: ${database}`);
    await db.query(`INSERT INTO usuarios(id,nome,email,senha_hash,tipo_perfil,ativo) VALUES
      ($1,'Synthetic Investor','investor@example.invalid','synthetic','investidor',true),
      ($2,'Synthetic Startup','startup@example.invalid','synthetic','startup',true)`, [investorUser,startupUser]);
    await db.query(`INSERT INTO investidores(id,usuario_id,nome,status_moderacao) VALUES ($1,$2,'Synthetic Investor','aprovado')`, [investorId,investorUser]);
    await db.query(`INSERT INTO startups(id,usuario_id,nome_fantasia,segmento,estagio,modelo_negocio,status_moderacao,capital_procurado)
      VALUES ($1,$2,'Synthetic Startup','agtech','mvp','b2b','aprovado',5000.00)`, [startupId,startupUser]);
    await db.query(`INSERT INTO funil_interacoes(investidor_id,startup_id,tipo_evento) VALUES ($1,$2,'interesse_demonstrado')`, [investorId,startupId]);
    const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'migrations' ORDER BY tablename")).map(r => r.tablename);
    assert.ok(!tables.includes('exposicoes_startups'), 'O schema de origem não deve conter a migration em avaliação');
    const before = await existingState(tables);
    const migrationsBefore = await db.query('SELECT * FROM migrations ORDER BY id');
    await check('migration real aplicada via TypeORM, somente no banco descartável', async () => {
      const applied = await db.runMigrations({ transaction: 'all' });
      assert.deepEqual(applied.map(m => m.name), ['ExposicoesStartups1793232000000']);
      assert.equal(await db.showMigrations(), false);
    });
    await check('todas as tabelas preexistentes mantêm dados, colunas, defaults, constraints e índices', async () => {
      assert.deepEqual(await existingState(tables), before);
      assert.equal((await db.query('SELECT * FROM migrations')).length, migrationsBefore.length + 1);
    });
    await check('colunas, tipos, obrigatoriedade e índice composto', async () => {
      const columns = await db.query(schemaQuery, [['exposicoes_startups']]);
      assert.equal(columns.length, 11);
      const expected = { id: 'uuid', investidor_id: 'uuid', startup_id: 'uuid', ocorrido_em: 'timestamp with time zone',
        origem_recomendacao: 'character varying(30)', posicao_ranking: 'integer', versao_recomendador: 'character varying(100)',
        snapshot_perfis: 'jsonb', versao_contrato: 'character varying(30)', semantica: 'character varying(50)', origem_dados: 'character varying(10)' };
      for (const column of columns) { assert.equal(column.type, expected[column.attname]); assert.equal(column.attnotnull, !['posicao_ranking','versao_recomendador'].includes(column.attname)); }
      const indexes = await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='exposicoes_startups' ORDER BY indexname");
      assert.equal(indexes.length, 2);
      assert.ok(indexes.some(i => i.indexname === 'exposicoes_par_data' && i.indexdef.includes('(investidor_id, startup_id, ocorrido_em)')));
      const constraints = await db.query("SELECT contype, confdeltype, confrelid::regclass::text AS referenced FROM pg_constraint WHERE conrelid='public.exposicoes_startups'::regclass");
      assert.equal(constraints.filter(c => c.contype === 'p').length, 1);
      assert.equal(constraints.filter(c => c.contype === 'c').length, 3);
      assert.deepEqual(constraints.filter(c => c.contype === 'f').map(c => [c.referenced,c.confdeltype]).sort(), [['investidores','c'],['startups','c']]);
    });
    await check('defaults de timestamp, origem real, contrato, semântica e opcionais', async () => {
      const [row] = await db.query(insert + ' RETURNING *', params());
      assert.ok(row.ocorrido_em instanceof Date);
      assert.equal(row.origem_dados, 'real'); assert.equal(row.versao_contrato, 'supervised-v1');
      assert.equal(row.semantica, 'card_50pct_1000ms_ack');
      assert.equal(row.posicao_ranking, null); assert.equal(row.versao_recomendador, null);
    });
    await check('PK, FKs, NOT NULL e CHECKs rejeitam valores inválidos', async () => {
      const values = params(); await db.query(insert, values);
      await assert.rejects(db.query(insert, values), e => e.driverError?.code === '23505');
      for (const index of [1,2]) { const invalid = params(); invalid[index] = randomUUID(); await assert.rejects(db.query(insert, invalid), e => e.driverError?.code === '23503'); }
      for (const index of [0,1,2,3]) { const invalid = params(); invalid[index] = null; await assert.rejects(db.query(insert, invalid), e => e.driverError?.code === '23502'); }
      await assert.rejects(db.query(insert.replace("'discovery'", "'invalid'"), params()), e => e.driverError?.code === '23514');
      for (const value of [0,-1]) await assert.rejects(db.query(insert.replace('snapshot_perfis)', 'snapshot_perfis,posicao_ranking)').replace('$4::jsonb)', '$4::jsonb,$5)'), [...params(),value]), e => e.driverError?.code === '23514');
      await assert.rejects(db.query(insert.replace('snapshot_perfis)', 'snapshot_perfis,origem_dados)').replace('$4::jsonb)', '$4::jsonb,$5)'), [...params(),'invalid']), e => e.driverError?.code === '23514');
    });
    await check('ON CONFLICT sequencial preserva timestamp e snapshot originais', async () => {
      const values = params(); const [first] = await db.query(upsert, values);
      assert.deepEqual(await db.query(upsert, [...values.slice(0,3), JSON.stringify({ attemptedOverwrite: true })]), []);
      const [row] = await db.query('SELECT ocorrido_em,snapshot_perfis FROM public.exposicoes_startups WHERE id=$1', [values[0]]);
      assert.equal(row.ocorrido_em.getTime(), first.ocorrido_em.getTime()); assert.deepEqual(row.snapshot_perfis, JSON.parse(values[3]));
    });
    await check('concorrência real: segunda conexão bloqueia, primeira confirma, apenas uma linha', () => concurrencyScenario(true));
    await check('concorrência real: primeira desfaz, segunda insere sem perda do evento', () => concurrencyScenario(false));
    await check('UUIDs distintos permitem múltiplas exposições do mesmo par', async () => {
      const a = params(); const b = params();
      const [first] = await db.query(upsert, a); await db.query('SELECT pg_sleep(0.01)'); const [second] = await db.query(upsert, b);
      assert.notEqual(first.id, second.id); assert.ok(second.ocorrido_em >= first.ocorrido_em);
      assert.equal((await db.query('SELECT count(*)::int AS total FROM public.exposicoes_startups WHERE id=ANY($1::uuid[])', [[a[0],b[0]]]))[0].total, 2);
    });
    await check('serviço real: confirmações concorrentes retornam mesma exposição e snapshot minimizado', async () => {
      const investor = await db.getRepository(Investidor).findOneOrFail({ where: { id: investorId }, relations: { usuario: true } });
      const startup = await db.getRepository(Startup).findOneOrFail({ where: { id: startupId }, relations: { usuario: true } });
      const token = issueContext({ investorId, startupId, investorRevision: profileRevision(investor,true), startupRevision: profileRevision(startup,false), origin: 'discovery', position: null, version: null });
      const service = new MatchmakingService(db);
      const [a,b] = await Promise.all([service.confirmExposure(investorUser,token),service.confirmExposure(investorUser,token)]);
      assert.equal(a.id,b.id); assert.equal(a.ocorrido_em.getTime(),b.ocorrido_em.getTime());
      const rows = await db.query('SELECT snapshot_perfis FROM public.exposicoes_startups WHERE id=$1', [readContext(token).exposureId]);
      assert.equal(rows.length,1);
      assert.deepEqual(rows[0].snapshot_perfis, { investidor: project(investor,investorFeatures), startup: project(startup,startupFeatures) });
      assert.ok(!JSON.stringify(rows[0].snapshot_perfis).includes('example.invalid'));
      assert.ok(!JSON.stringify(rows[0].snapshot_perfis).includes('Synthetic'));
    });
    await check('rollback automático é bloqueado sem remover tabela, dados ou histórico de migrations', async () => {
      const saved = await db.query('SELECT id FROM public.exposicoes_startups ORDER BY id');
      const migrations = await db.query('SELECT * FROM migrations ORDER BY id');
      await assert.rejects(db.undoLastMigration({ transaction: 'all' }), /Rollback requer plano explícito/);
      assert.deepEqual(await db.query('SELECT id FROM public.exposicoes_startups ORDER BY id'), saved);
      assert.deepEqual(await db.query('SELECT * FROM migrations ORDER BY id'), migrations);
    });
    await check('inserções e falhas não alteram tabelas preexistentes', async () => assert.deepEqual(await existingState(tables), before));
    await check('ON DELETE CASCADE das duas FKs e da cadeia usuario → perfil → exposição', async () => {
      for (const target of ['startup','investor','user']) {
        const runner = db.createQueryRunner(); await runner.connect(); await runner.startTransaction();
        try {
          const [exposure] = await runner.query(upsert, params());
          if (target === 'startup') await runner.query('DELETE FROM startups WHERE id=$1', [startupId]);
          if (target === 'investor') await runner.query('DELETE FROM investidores WHERE id=$1', [investorId]);
          if (target === 'user') await runner.query('DELETE FROM usuarios WHERE id=$1', [investorUser]);
          assert.equal((await runner.query('SELECT count(*)::int AS total FROM public.exposicoes_startups WHERE id=$1', [exposure.id]))[0].total, 0);
        } finally { await runner.rollbackTransaction(); await runner.release(); }
      }
      assert.deepEqual(await existingState(tables), before);
    });
  } finally {
    if (db?.isInitialized) await db.destroy();
    if (created) {
      assertDisposable();
      docker(['dropdb', '-U', 'admin', '--force', database]);
      const remaining = docker(['psql','-U','admin','-d','postgres','-XAt','-c',`SELECT count(*) FROM pg_database WHERE datname='${database}'`]).trim();
      assert.equal(remaining, '0');
      console.log('OK: banco descartável removido e ausência confirmada');
    }
    assert.equal(normalizeDump(sourceSchema()), normalizeDump(baselineSchema), 'Schema principal mudou durante a execução');
    assert.equal(mainCounts(), baselineCounts, 'Contagens principais mudaram durante a execução');
    console.log('OK: schema e contagens de juntai_db permanecem iguais ao início');
  }
  console.log(JSON.stringify({ checksPassed: results.length, sourceSchemaSha256: createHash('sha256').update(normalizeDump(baselineSchema)).digest('hex'), cleaned: true }));
}
main().catch(error => {
  // Não imprimir configuração de conexão, credenciais ou dados reais.
  console.error('FALHA:', error.message);
  process.exitCode = 1;
});
