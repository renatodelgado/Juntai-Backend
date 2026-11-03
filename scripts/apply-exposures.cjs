// Preparação por padrão. Escritas somente com --apply e backup verificado.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DataSource, Migration, MigrationExecutor } = require('typeorm');
const { AppDataSource } = require('../src/shared/database/data-source');
const { ExposicoesStartups1793232000000 } = require('../src/shared/database/migrations/1793232000000-ExposicoesStartups');

const targetName = 'ExposicoesStartups1793232000000';
const targetHash = '9a9c598c14f80d107a09fd66faaac10a9c2fce765c50f9c529facc61579bd277';
const expected = [
  ['1791158400000','StartupApresentacaoUrl1791158400000'],
  ['1791244800000','AtualizarCadastroStartupInvestidor1791244800000'],
  ['1791244800001','UsuarioAvatarOpcional1791244800001'],
  ['1791244800002','ConversasMensagens1791244800002'],
  ['1791244800003','IndicesAuditoria1791244800003'],
];
const args = process.argv.slice(2);
const applying = args[0] === '--apply';
assert.ok((args.length === 0) || (args.length === 1 && args[0] === '--plan') || (args.length === 2 && applying), 'Use --plan ou --apply <backup.dump>');
const digest = value => createHash('sha256').update(value).digest('hex');

async function validateState(runner) {
  const [destination] = await runner.query('SELECT current_database() AS database');
  assert.equal(destination.database, 'juntai_db');
  const history = await runner.query('SELECT timestamp::text AS timestamp,name FROM public.migrations ORDER BY timestamp,id');
  assert.deepEqual(history.map(row => [row.timestamp,row.name]), expected, 'Histórico mudou; requer nova revisão');
  const [objects] = await runner.query("SELECT to_regclass('public.exposicoes_startups') AS exposures,to_regclass('public.exposicoes_par_data') AS index");
  assert.equal(objects.exposures,null); assert.equal(objects.index,null);
  console.log(JSON.stringify({ database: destination.database, registered: history, pendingSelected: [targetName] }));
}

async function main() {
  assert.equal(AppDataSource.options.database, 'juntai_db', 'DB_NAME deve ser juntai_db');
  assert.equal(AppDataSource.options.synchronize, false);
  const migrationFile = path.join(__dirname,'../src/shared/database/migrations/1793232000000-ExposicoesStartups.ts');
  assert.equal(digest(fs.readFileSync(migrationFile)),targetHash,'Arquivo da migration mudou; revisar antes de aplicar');
  if (applying) {
    const backup = args[1];
    const manifest = JSON.parse(fs.readFileSync(backup + '.json','utf8'));
    assert.equal(manifest.database,'juntai_db');
    assert.equal(manifest.archiveDecoded,true);
    assert.equal(digest(fs.readFileSync(backup)),manifest.sha256,'Backup não corresponde ao checksum');
    console.log('Backup verificado. Somente a migration selecionada será executada.');
  }
  const db = new DataSource({ ...AppDataSource.options, entities: [], migrations: [ExposicoesStartups1793232000000],
    migrationsRun: false, synchronize: false, logging: false, schema: 'public', migrationsTableName: 'migrations' });
  let runner;
  try {
    await db.initialize();
    assert.equal(db.migrations.length,1); assert.equal(db.migrations[0].constructor.name,targetName);
    runner = db.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    if (!applying) await runner.query('SET TRANSACTION READ ONLY');
    await runner.query("SET LOCAL search_path TO public; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    if (applying) {
      await runner.query("SELECT pg_advisory_xact_lock(hashtext('juntai:exposicoes:1793232000000'))");
      await runner.query('LOCK TABLE public.migrations IN SHARE ROW EXCLUSIVE MODE');
    }
    await validateState(runner);
    if (applying) {
      const migration = new ExposicoesStartups1793232000000();
      await migration.up(runner);
      // Registro pelo executor oficial, na MESMA transação do DDL.
      await new MigrationExecutor(db,runner).insertMigration(new Migration(undefined,1793232000000,targetName,migration));
      assert.equal((await runner.query("SELECT count(*)::int AS count FROM public.migrations WHERE name=$1",[targetName]))[0].count,1);
      assert.equal((await runner.query("SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname='public' AND tablename='exposicoes_startups'"))[0].count,2);
      await runner.commitTransaction(); console.log('COMMIT: somente ExposicoesStartups1793232000000 aplicada.');
    } else {
      await runner.rollbackTransaction(); console.log('PLANO VALIDADO EM READ ONLY. Nenhuma migration executada.');
    }
  } finally {
    if (runner?.isTransactionActive) await runner.rollbackTransaction();
    if (runner) await runner.release();
    if (db.isInitialized) await db.destroy();
  }
}
main().catch(error => { console.error('Operação interrompida:',error.message); process.exitCode=1; });
