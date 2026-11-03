// --validate-backup only writes a disposable database; --apply targets only the selected migration.
require('ts-node/register/transpile-only');require('tsconfig-paths/register');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');const {execFileSync}=require('node:child_process');
const {DataSource,MigrationExecutor}=require('typeorm');
const {AppDataSource}=require('../src/shared/database/data-source');
const {ExposicoesStartups1793232000000:Previous}=require('../src/shared/database/migrations/1793232000000-ExposicoesStartups');
const {ExposicoesSupervised1793404800000:Selected}=require('../src/shared/database/migrations/1793404800000-ExposicoesSupervised');
const {state,hash,target,assertMigrationOnly}=require('./supervised-migration-state.cjs');
const artifact=path.resolve(__dirname,'../artifacts/migrations/supervised-validation.json');
const selectedFile=path.resolve(__dirname,'../src/shared/database/migrations/1793404800000-ExposicoesSupervised.ts');
function source(readonly=true){return new DataSource({...AppDataSource.options,entities:[],migrationsRun:false,synchronize:false,installExtensions:false,logging:false,
 extra:{options:readonly?'-c default_transaction_read_only=on':'',connectionTimeoutMillis:10000}});}
function temporary(name,migrations){assert.match(name,/^juntai_supervised_audit_[a-f0-9]{32}$/);assert.notEqual(name,'juntai_db');return new DataSource({...AppDataSource.options,database:name,entities:[],migrations,migrationsRun:false,synchronize:false,installExtensions:false,logging:false});}
function docker(args,input){return execFileSync('docker',['exec',...(input===undefined?[]:['-i']),'postgres_juntai',...args],{input,encoding:input===undefined?'utf8':undefined,maxBuffer:32*1024*1024,timeout:60000,stdio:['pipe','pipe','pipe']});}
async function validate(backup){
 const manifest=JSON.parse(fs.readFileSync(backup+'.json','utf8'));const bytes=fs.readFileSync(backup);
 assert.equal(manifest.database,'juntai_db');assert.equal(hash(bytes),manifest.sha256);assert.equal(bytes.length,manifest.bytes);
 const main=source();let db,created=false;const name='juntai_supervised_audit_'+randomUUID().replaceAll('-','');
 await main.initialize();assert.equal((await main.query('SELECT current_database() name'))[0].name,'juntai_db');
 const before=await state(main);
 try{
  docker(['createdb','-U','admin','--template=template0',name]);created=true;
  docker(['pg_restore','-U','admin','--clean','--if-exists','--exit-on-error','--no-owner','--no-privileges','--dbname',name],bytes);
  db=temporary(name,[Previous]);await db.initialize();
  const recovered=await db.runMigrations({transaction:'all'});assert.deepEqual(recovered.map(m=>m.name),['ExposicoesStartups1793232000000']);
  assert.deepEqual(await state(db),before,'Backup + migration original não recuperam exatamente o estado atual');
  console.log('OK: backup restaurado e estado atual integralmente recuperado; nenhum novo backup criado.');
  const [{id:investor}]=await db.query('SELECT id FROM investidores ORDER BY id LIMIT 1');const [{id:startup}]=await db.query('SELECT id FROM startups ORDER BY id LIMIT 1');
  const insert="INSERT INTO exposicoes_startups(id,investidor_id,startup_id,origem_recomendacao,snapshot_perfis) VALUES($1,$2,$3,$4,$5::jsonb)";
  const params=origin=>[randomUUID(),investor,startup,origin,JSON.stringify({preserve:true})];
  await db.query(insert,params('rules'));await db.query(insert,params('discovery'));
  const pre=await state(db);await db.destroy();db=temporary(name,[Selected]);await db.initialize();
  const rollback=db.createQueryRunner();await rollback.connect();await rollback.startTransaction();
  try{await new Selected().up(rollback);await rollback.rollbackTransaction();}finally{if(rollback.isTransactionActive)await rollback.rollbackTransaction();await rollback.release();}
  assert.deepEqual(await state(db),pre);console.log('OK: rollback transacional restaura integralmente a CHECK e os dados.');
  const applied=await db.runMigrations({transaction:'all'});assert.deepEqual(applied.map(m=>m.name),[target]);assert.equal(await db.showMigrations(),false);
  assertMigrationOnly(pre,await state(db));console.log('OK: migration transacional preserva dados, colunas, índices, PK, FKs e CHECKs restantes.');
  for(const origin of ['discovery','rules','supervised'])await db.query(insert,params(origin));
  await assert.rejects(db.query(insert,params('invalid')),e=>e.driverError?.code==='23514');
  const badFk=params('supervised');badFk[1]=randomUUID();await assert.rejects(db.query(insert,badFk),e=>e.driverError?.code==='23503');
  const badNull=params('supervised');badNull[4]=null;await assert.rejects(db.query(insert,badNull),e=>e.driverError?.code==='23502');
  const duplicate=params('supervised');await db.query(insert,duplicate);await assert.rejects(db.query(insert,duplicate),e=>e.driverError?.code==='23505');
  await assert.rejects(db.query(insert.replace('snapshot_perfis)','snapshot_perfis,posicao_ranking)').replace('$5::jsonb)','$5::jsonb,0)'),params('supervised')),e=>e.driverError?.code==='23514');
  console.log('OK: três origens aceitas; desconhecida, FK inválida, NULL, PK duplicada e posição zero rejeitados.');
 }finally{
  if(db?.isInitialized)await db.destroy();if(created){docker(['dropdb','-U','admin','--force',name]);console.log('OK: banco de restauração/validação descartável removido.');}
  assert.deepEqual(await state(main),before,'Principal mudou durante validação');await main.destroy();
 }
 const cwd=path.resolve(__dirname,'..');
 const env={...process.env,ADMIN_DB_TEST:'0',MATCHMAKING_STRATEGY:'rules'};
 const unit=execFileSync(process.execPath,['--test','tests/*.test.cjs'],{cwd,env,encoding:'utf8',timeout:60000});
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit'],{cwd,env,encoding:'utf8',timeout:60000});
 fs.mkdirSync(path.dirname(artifact),{recursive:true});
 fs.writeFileSync(artifact,JSON.stringify({backup:path.resolve(backup),backupSha256:manifest.sha256,mainState:before,migrationHash:hash(fs.readFileSync(selectedFile)),unitHash:hash(unit),backupRestored:true,migrationValidated:true,typecheckPassed:true},null,2));
 console.log('OK: backend e TypeScript aprovados; recibo local salvo sem dados pessoais.');
}
async function apply(){
 const receipt=JSON.parse(fs.readFileSync(artifact,'utf8'));
 assert.equal(receipt.backupRestored,true);assert.equal(receipt.migrationValidated,true);assert.equal(receipt.typecheckPassed,true);
 assert.equal(hash(fs.readFileSync(receipt.backup)),receipt.backupSha256);assert.equal(hash(fs.readFileSync(selectedFile)),receipt.migrationHash);
 assert.equal(AppDataSource.options.database,'juntai_db');assert.equal(AppDataSource.options.synchronize,false);
 const db=source(false);let runner;
 try{
  await db.initialize();runner=db.createQueryRunner();await runner.connect();await runner.startTransaction();
  await runner.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
  assert.equal((await runner.query('SELECT current_database() name'))[0].name,'juntai_db');
  await runner.query("SELECT pg_advisory_xact_lock(hashtext('juntai:supervised-exposures'))");
  await runner.query('LOCK TABLE public.migrations IN SHARE ROW EXCLUSIVE MODE');
  const tables=await runner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  for(const {tablename} of tables)if(tablename!=='migrations')await runner.query('LOCK TABLE public."'+tablename.replaceAll('"','""')+'" IN SHARE MODE');
  const before=await state(runner);assert.deepEqual(before,receipt.mainState,'Estado principal divergiu do backup validado');
  const executor=new MigrationExecutor(db,runner);const pending=await executor.getPendingMigrations();assert.deepEqual(pending.map(m=>m.name),[target],'Migration selecionada deve ser a única pendente');
  console.log('Destino confirmado: juntai_db; única pendente: '+target+'; transação ativa e backup compatível.');
  const executed=await executor.executePendingMigrations();assert.deepEqual(executed.map(m=>m.name),[target]);
  const after=await state(runner);assertMigrationOnly(before,after);
  await runner.commitTransaction();
  const committed=await state(db);assert.deepEqual(committed,after);
  fs.writeFileSync(path.join(path.dirname(artifact),'supervised-applied.json'),JSON.stringify({migration:target,applied:true,dataPreserved:true,before,after},null,2));
  console.log('COMMIT confirmado: apenas '+target+' aplicada; dados existentes preservados.');
 }finally{if(runner?.isTransactionActive)await runner.rollbackTransaction();if(runner)await runner.release();if(db.isInitialized)await db.destroy();}
}
const [mode,backup]=process.argv.slice(2);
(async()=>{if(mode==='--validate-backup'&&backup)await validate(backup);else if(mode==='--apply'&&!backup)await apply();else throw Error('Use --validate-backup <arquivo.dump> ou --apply');})().catch(e=>{console.error('INTERROMPIDO:',e.message);process.exitCode=1;});
