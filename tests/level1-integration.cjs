// Explicit integration audit: main database READ ONLY; synthetic writes only in a unique disposable database.
require('dotenv').config({ quiet: true });
delete process.env.MATCHMAKING_STRATEGY; // O teste legado sempre começa no padrão rules.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { AppDataSource: db } = require('../src/shared/database/data-source');
const { readContext, issueContext } = require('../src/modules/matchmaking/ExposureContext');
const { profileRevision } = require('../src/modules/matchmaking/MatchmakingService');
const { project, investorFeatures, startupFeatures } = require('../src/modules/matchmaking/contracts');
const { Investidor } = require('../src/modules/investidores/entities/Investidor');
const { Startup } = require('../src/modules/startups/entities/Startup');
const { MatchmakingClient } = require('../src/modules/matchmaking/MatchmakingClient');
const { supervisedProfile } = require('../src/modules/matchmaking/supervisedContracts');
const { ExposicoesSupervised1793404800000 } = require('../src/shared/database/migrations/1793404800000-ExposicoesSupervised');
const fixture = require('./fixtures/matchmaking-contract.json');
const nativeConsoleError = console.error;
console.error = error => nativeConsoleError(error instanceof Error ? `${error.code || error.name}: ${error.message}` : error);
db.logger = { logQuery() {}, logQueryError(error) { console.log('SQL ERROR: ' + error); }, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} };
const source = process.env.DB_NAME;
const disposable = 'juntai_level1_test_' + randomUUID().replaceAll('-', '');
const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000 };
const nativeFetch = global.fetch;
const upstream = [];
// Observe real HTTP without substituting either requests or responses.
global.fetch = async (url, options) => {
  const response = await nativeFetch(url, options);
  if (['/match/rules','/match/supervised'].includes(new URL(url).pathname) && options?.body) {
    upstream.push({ request: JSON.parse(options.body), response: await response.clone().json() });
  }
  return response;
};
const app = require('../src/App').default;
let server, created = false, main, admin, baseline, schemaBefore;
const checks = [];
const observations = {};
function docker(args, input) {
  return execFileSync('docker', ['exec', ...(input === undefined ? [] : ['-i']), 'postgres_juntai', ...args], { input, encoding: 'utf8', timeout: 45000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
function schema() { return docker(['pg_dump', '-U', 'admin', '-d', source, '--schema-only', '--no-owner', '--no-privileges']); }
function normalized(value) { return value.split('\n').filter(l => !/^\\(?:un)?restrict\s/.test(l)).join('\n'); }
async function state() {
  const result = {};
  const tables = (await main.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for (const { tablename } of tables) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    result[tablename] = (await main.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS digest FROM (SELECT md5(row_to_json(t)::text) h FROM public.${quoted} t) s`)).rows[0];
  }
  return result;
}
async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log('OK: ' + name); }
  catch (e) { checks.push({ name, passed: false, error: e.message.slice(0, 400) }); console.log('FAIL: ' + name + ': ' + e.message.slice(0, 400)); }
}
let base;
async function request(path, token, body, expected = 200) {
  const response = await nativeFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const json = await response.json();
  assert.equal(response.status, expected, path + ': ' + JSON.stringify(json).slice(0, 150));
  return json;
}
async function listen() { server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = 'http://127.0.0.1:' + server.address().port; }
async function closeServer() { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; } }
function disposableGuard() { assert.match(disposable, /^juntai_level1_test_[a-f0-9]{32}$/); assert.notEqual(disposable, source); }
function withoutContexts(result) { return result.recomendacoes.map(({ contextoExposicao, ...r }) => r); }
function frontendPageSchema() {
  const fs=require('node:fs'),path=require('node:path');
  const root=path.resolve(__dirname,'../../Juntai-Frontend');
  const profiles=fs.readFileSync(path.join(root,'src/features/auth/services/profiles.ts'),'utf8');
  const api=fs.readFileSync(path.join(root,'src/features/explore-startups/api.ts'),'utf8');
  function between(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
  const code=between(profiles,'const numeric =','export const investorSchema').replace('export const startupSchema','const startupSchema')+'\n'+between(api,'const schema = startupSchema.extend','type RemoteStartup')+'\n'+between(api,'const pageSchema =','export type StartupPage')+'\nreturn pageSchema;';
  const compiled=require('typescript').transpile(code,{target:require('typescript').ScriptTarget.ES2022});
  return new Function('z',compiled)(require(path.join(root,'node_modules/zod')).z);
}
async function mainRun() {
  assert.equal(source, 'juntai_db'); assert.equal(db.options.synchronize, false);
  main = new Client({ ...config, database: source, options: '-c default_transaction_read_only=on' }); await main.connect();
  assert.equal((await main.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
  baseline = await state(); schemaBefore = schema();
  observations.mainCounts = Object.fromEntries(Object.entries(baseline).map(([k,v]) => [k,v.count]));
  await check('main: migration history and exposure table exist', async () => {
    assert.equal((await main.query("SELECT count(*)::int n FROM migrations WHERE name='ExposicoesStartups1793232000000'")).rows[0].n, 1);
    assert.ok(Object.hasOwn(baseline, 'exposicoes_startups'));
  });
  await check('existing backend and FastAPI respond over HTTP', async () => {
    assert.equal((await nativeFetch('http://127.0.0.1:3333/')).status, 200);
    assert.equal((await nativeFetch('http://127.0.0.1:8000/health')).status, 200);
  });
  if (process.env.LEVEL1_TEST_USER_ID) {
    db.setOptions({ logging: false, installExtensions: false, extra: { options: '-c default_transaction_read_only=on' } }); await db.initialize(); await listen();
    await check('main: approved test investor recommendation and discovery via real HTTP', async () => {
      const token = jwt.sign({ tipoPerfil: 'investidor' }, process.env.JWT_SECRET, { subject: process.env.LEVEL1_TEST_USER_ID, expiresIn: '5m' });
      const result = await request('/startups/recomendacoes?limite=24', token);
      assert.equal(result.recomendacoes.length, 24);
      const second = await request('/startups/recomendacoes?limite=24', token);
      assert.deepEqual(withoutContexts(result), withoutContexts(second));
      const page = await request('/startups/discovery?sort=compatibility&size=24&page=0', token);
      assert.deepEqual(page.items.map(x => x.id), result.recomendacoes.map(x => x.startupId));
      page.items.forEach((x,i) => assert.equal(x.compatibility, result.recomendacoes[i].score * 100));
      observations.mainRecommendation = { version: result.versaoAlgoritmo, count: result.recomendacoes.length, candidateBatchSizes: upstream.map(x => x.request.startups.length), discoveryTotal: page.total };
    });
    await closeServer(); await db.destroy();
  } else observations.mainRecommendation = 'NOT RUN: no confirmed existing test account';
  disposableGuard(); admin = new Client({ ...config, database: 'postgres' }); await admin.connect();
  await admin.query('CREATE DATABASE "' + disposable + '" TEMPLATE template0'); created = true;
  // Schema only: no main-database personal data is copied and no migration is executed.
  const ddl = schemaBefore.replace(/^CREATE SCHEMA public;\r?\n/gm, '');
  docker(['psql', '-U', 'admin', '-d', disposable, '-X', '-v', 'ON_ERROR_STOP=1'], ddl);
  db.setOptions({ database: disposable, logging: false, extra: { max: 8, connectionTimeoutMillis: 5000 } }); await db.initialize();
  assert.equal((await db.query('SELECT current_database() name'))[0].name, disposable);
  // Copia apenas metadados do histórico; aplica exclusivamente a nova migration se o schema ainda for antigo.
  const history=(await main.query('SELECT id,timestamp::text timestamp,name FROM migrations ORDER BY id')).rows;
  for(const row of history)await db.query('INSERT INTO migrations(id,timestamp,name) VALUES($1,$2,$3)',[row.id,row.timestamp,row.name]);
  await db.query("SELECT setval(pg_get_serial_sequence('migrations','id'),(SELECT max(id) FROM migrations))");
  const pending=(await db.showMigrations());
  if(pending){const applied=await db.runMigrations({transaction:'all'});assert.deepEqual(applied.map(m=>m.name),['ExposicoesSupervised1793404800000']);}
  const investorUser = randomUUID(), investorId = randomUUID();
  const startupIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const startupUsers = startupIds.map(() => randomUUID());
  const password = randomUUID(); const hash = await bcrypt.hash(password, 4);
  await db.query("INSERT INTO usuarios(id,nome,email,senha_hash,tipo_perfil,ativo) VALUES($1,'Synthetic Investor','level1@example.invalid',$2,'investidor',true)", [investorUser,hash]);
  await db.query("INSERT INTO investidores(id,usuario_id,nome,status_moderacao,tipo_investidor,segmentos_interesse,estagios_interesse,regioes_interesse,modelos_interesse,areas_ajuda) VALUES($1,$2,'Synthetic Investor','aprovado','anjo_mentor',ARRAY['agtech']::segmento_enum[],ARRAY['mvp']::estagio_enum[],ARRAY['nordeste']::regiao_enum[],ARRAY['b2b']::modelo_negocio_enum[],ARRAY['mentoria']::area_ajuda_enum[])", [investorId,investorUser]);
  for (let n=0;n<4;n++) {
    await db.query("INSERT INTO usuarios(id,nome,email,senha_hash,tipo_perfil,ativo) VALUES($1,'Synthetic Startup',$2,$3,'startup',$4)", [startupUsers[n], 'startup'+n+'@example.invalid',hash,n!==3]);
    await db.query("INSERT INTO startups(id,usuario_id,nome_fantasia,segmento,estagio,modelo_negocio,status_moderacao,regioes_atuacao,necessidades_adicionais,busca_investimento,capital_procurado,estado,cidade) VALUES($1,$2,$3,$4,'mvp','b2b',$5,ARRAY['nordeste']::regiao_enum[],ARRAY['mentoria']::necessidade_adicional_enum[],true,5000,'PE','Recife')", [startupIds[n],startupUsers[n],'Synthetic '+n,n===1?'fintech':'agtech',n===2?'pendente':'aprovado']);
  }
  await listen(); let token, startupToken, ranking, discovery;
  await check('disposable: actual login with bcrypt and JWT', async () => {
    token = (await request('/auth/login', null, {email:'level1@example.invalid',senha:password})).token;
    startupToken = (await request('/auth/login', null, {email:'startup0@example.invalid',senha:password})).token;
    assert.equal(jwt.verify(token,process.env.JWT_SECRET).sub, investorUser);
    await request('/auth/login',null,{email:'level1@example.invalid',senha:'wrong'},401);
  });
  await check('disposable: PostgreSQL -> Node -> FastAPI -> Node via actual application HTTP', async () => {
    const start = upstream.length;
    ranking = await request('/startups/recomendacoes?limite=24',token);
    assert.equal(ranking.versaoAlgoritmo,'1a-v3'); assert.equal(ranking.recomendacoes.length,2);
    assert.deepEqual(ranking.recomendacoes.map(x=>x.startupId),startupIds.slice(0,2));
    assert.equal(ranking.recomendacoes[0].score,1);assert.ok(Math.abs(ranking.recomendacoes[1].score-0.7)<1e-12);
    const observed=upstream[start]; assert.equal(observed.request.startups.length,2);
    assert.ok(!JSON.stringify(observed.request).includes('example.invalid')); assert.ok(!JSON.stringify(observed.request).includes('Synthetic'));
    const second=await request('/startups/recomendacoes?limite=24',token); assert.deepEqual(withoutContexts(second),withoutContexts(ranking));
    for(const r of ranking.recomendacoes) { const c=readContext(r.contextoExposicao); assert.equal(c.investorId,investorId);assert.equal(c.startupId,r.startupId);assert.equal(c.origin,'rules');assert.equal(c.position,r.posicao); }
    assert.equal((await db.query('SELECT count(*)::int n FROM exposicoes_startups'))[0].n,0);
    observations.syntheticRecommendation={version:ranking.versaoAlgoritmo,scores:ranking.recomendacoes.map(x=>x.score),eligible:2,excludedPending:1,excludedInactive:1};
  });
  await check('disposable: discovery pagination, filters, signed contexts and database card correspondence', async () => {
    discovery=await request('/startups/discovery?sort=compatibility&size=1&page=0',token);
    const page1=await request('/startups/discovery?sort=compatibility&size=1&page=1',token);
    assert.equal(discovery.total,2);assert.equal(discovery.hasMore,true);assert.equal(page1.hasMore,false);
    assert.equal(discovery.items[0].id,startupIds[0]);assert.equal(page1.items[0].id,startupIds[1]);assert.equal(discovery.items[0].compatibility,100);assert.equal(page1.items[0].compatibility,70);
    const filters=['segment=agtech','stage=mvp','model=b2b','q=Synthetic','location=Recife','investment=yes','min=4999&max=5001','saved=1&ids='+startupIds[0]];
    for(const filter of filters){const page=await request('/startups/discovery?sort=compatibility&'+filter,token);assert.ok(page.items.length>0);for(const item of page.items){const [stored]=await db.query('SELECT nome_fantasia FROM startups WHERE id=$1',[item.id]);assert.equal(item.nomeFantasia,stored.nome_fantasia);assert.ok(!Object.hasOwn(item,'usuario'));const c=readContext(item.contextoExposicao);assert.equal(c.startupId,item.id);assert.equal(c.origin,'rules');}}
    const bySegment=await request('/startups/discovery?sort=compatibility&segment=agtech',token);assert.equal(bySegment.total,1);
    await request('/startups/discovery?page=-1',token,undefined,400);await request('/startups/discovery?investment=invalid',token,undefined,400);await request('/startups/discovery?min=10&max=1',token,undefined,400);
  });
  await check('disposable: discovery default, recent, name and investment sorting', async () => {
    const statuses={};
    for(const sort of ['', 'recent','name','investment']) {const response=await nativeFetch(base+'/startups/discovery'+(sort?'?sort='+sort:''),{headers:{Authorization:'Bearer '+token}});statuses[sort||'default']=response.status;await response.text();}
    observations.discoverySortStatuses=statuses;assert.ok(Object.values(statuses).every(s=>s===200),JSON.stringify(statuses));
  });
  await check('regression: inherited ORDER BY reproduces 42P10; discovery preserves sorting, pagination and filters', async () => {
    const original = db.getRepository(Startup).createQueryBuilder('s').innerJoin('s.usuario','u')
      .where('s.statusModeracao = :status AND u.ativo = true',{status:'aprovado'})
      .orderBy('s.criadoEm','DESC').addOrderBy('s.id','ASC').skip(0).take(1);
    await assert.rejects(
      original.clone().select('s.estado','estado').addSelect('s.segmento','segmento').addSelect('s.regioes_atuacao','regioes').distinct(true).getRawMany(),
      error => error.driverError?.code === '42P10',
    );
    for (const [sort,column,direction] of [['recent','criado_em','DESC'],['name','nome_fantasia','ASC'],['investment','busca_investimento','DESC']]) {
      const expected = await db.query(`SELECT s.id FROM startups s JOIN usuarios u ON u.id=s.usuario_id WHERE s.status_moderacao='aprovado' AND u.ativo=true ORDER BY s.${column} ${direction},s.id ASC`);
      for (let page=0;page<2;page++) {
        const response=await request(`/startups/discovery?sort=${sort}&page=${page}&size=1`,token);
        assert.deepEqual(response.items.map(item=>item.id),[expected[page].id]);
        assert.equal(response.total,2);assert.equal(response.hasMore,page===0);
        assert.deepEqual(response.facets,{locations:['PE'],segments:2,regions:1});
        assert.equal(readContext(response.items[0].contextoExposicao).origin,'discovery');
        assert.ok(!Object.hasOwn(response.items[0],'compatibility'));
      }
      const filtered=await request(`/startups/discovery?sort=${sort}&segment=agtech&size=1`,token);
      assert.deepEqual(filtered.items.map(item=>item.id),[startupIds[0]]);
      assert.equal(filtered.total,1);assert.equal(filtered.hasMore,false);
      assert.deepEqual(filtered.facets,{locations:['PE'],segments:1,regions:1});
    }
  });
  await check('frontend: actual Zod schemas accept HTTP discovery response', async () => {
    const schema=frontendPageSchema();schema.parse(discovery);
    schema.parse(await request('/startups/discovery?sort=compatibility&size=24',token));
  });
  await check('disposable: authentication, roles, tampered and expired contexts leave zero exposures', async () => {
    for(const path of ['/startups/recomendacoes','/startups/discovery']){await request(path,null,undefined,401);await request(path,startupToken,undefined,403);await request(path,'invalid',undefined,401);}
    const context=ranking.recomendacoes[0].contextoExposicao;
    await request('/startups/exposicoes',null,{contexto:context},401);await request('/startups/exposicoes',startupToken,{contexto:context},403);
    await request('/startups/exposicoes',token,{contexto:'invalid'},400);
    const altered=context.split('.');altered[1]=Buffer.from(JSON.stringify({...jwt.decode(context),origin:'discovery'})).toString('base64url');await request('/startups/exposicoes',token,{contexto:altered.join('.')},400);
    const payload=jwt.decode(context);delete payload.iat;delete payload.exp;
    const expired=jwt.sign(payload,process.env.JWT_SECRET,{expiresIn:-1});await request('/startups/exposicoes',token,{contexto:expired},400);
    await request('/startups/exposicoes',token,{contexto:context,investidor_id:randomUUID()},400);
    assert.equal((await db.query('SELECT count(*)::int n FROM exposicoes_startups'))[0].n,0);
  });
  await check('disposable: actual exposure persistence, fields, snapshots and concurrent idempotence', async () => {
    const context=ranking.recomendacoes[0].contextoExposicao;
    const first=await request('/startups/exposicoes',token,{contexto:context});
    const retries=await Promise.all(Array.from({length:4},()=>request('/startups/exposicoes',token,{contexto:context})));
    retries.forEach(x=>assert.deepEqual(x,first));
    const [row]=await db.query('SELECT * FROM exposicoes_startups');assert.equal(row.id,readContext(context).exposureId);assert.equal(row.investidor_id,investorId);assert.equal(row.startup_id,startupIds[0]);assert.ok(row.ocorrido_em instanceof Date);assert.equal(row.origem_recomendacao,'rules');assert.equal(row.posicao_ranking,1);assert.equal(row.versao_recomendador,'1a-v3');
    const investor=await db.getRepository(Investidor).findOneByOrFail({id:investorId});const startup=await db.getRepository(Startup).findOneByOrFail({id:startupIds[0]});
    assert.deepEqual(row.snapshot_perfis,{investidor:project(investor,investorFeatures),startup:project(startup,startupFeatures)});
    assert.equal((await db.query('SELECT count(*)::int n FROM exposicoes_startups'))[0].n,1);
    // Independently exercise discovery-origin persistence even if the discovery listing is broken.
    const contextDiscovery=issueContext({investorId,startupId:startupIds[0],investorRevision:profileRevision(investor,true),startupRevision:profileRevision(startup,false),origin:'discovery',position:null,version:null});
    const concurrentFirst=await Promise.all(Array.from({length:4},()=>request('/startups/exposicoes',token,{contexto:contextDiscovery})));
    concurrentFirst.forEach(x=>assert.deepEqual(x,concurrentFirst[0]));
    const [discoveryRow]=await db.query("SELECT * FROM exposicoes_startups WHERE origem_recomendacao='discovery'");assert.equal(discoveryRow.posicao_ranking,null);assert.equal(discoveryRow.versao_recomendador,null);
    observations.syntheticExposure={rows:2,retryRequests:4,originDataDefault:row.origem_dados,contract:row.versao_contrato,semantics:row.semantica};
  });
  await check('disposable: ineligible startup, stale profile and unauthorized investor rejected', async () => {
    const context=ranking.recomendacoes[1].contextoExposicao;
    await db.query("UPDATE startups SET status_moderacao='pendente' WHERE id=$1",[startupIds[1]]);await request('/startups/exposicoes',token,{contexto:context},404);
    await db.query("UPDATE startups SET status_moderacao='aprovado', atualizado_em=clock_timestamp() WHERE id=$1",[startupIds[1]]);await request('/startups/exposicoes',token,{contexto:context},409);
    await db.query("UPDATE investidores SET status_moderacao='pendente' WHERE id=$1",[investorId]);await request('/startups/recomendacoes',token,undefined,403);
    await db.query("UPDATE investidores SET status_moderacao='aprovado' WHERE id=$1",[investorId]);
    assert.equal((await db.query('SELECT count(*)::int n FROM exposicoes_startups'))[0].n,2);
  });
  await check('FastAPI: invalid payload rejected through actual HTTP', async () => { assert.equal((await nativeFetch('http://127.0.0.1:8000/match/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,422); });
  await check('disposable: real supervised HTTP, eligibility, pagination and frontend contract', async () => {
    process.env.MATCHMAKING_STRATEGY='supervised';
    try {
      const result=await request('/startups/recomendacoes?limite=24',token);
      assert.equal(result.origemRecomendacao,'supervised');assert.equal(result.recomendacoes.length,2);
      const investor=await db.getRepository(Investidor).findOneOrFail({where:{id:investorId},relations:{usuario:true}});
      const startups=await db.getRepository(Startup).find({relations:{usuario:true}});
      const direct=await new MatchmakingClient().supervised({investidor:supervisedProfile(investor,true),startups:startups.filter(s=>s.statusModeracao==='aprovado'&&s.usuario.ativo).map(s=>supervisedProfile(s,false)),limite:24});
      assert.deepEqual(result.recomendacoes.map(r=>[r.startupId,r.probabilidadeInteresse]),direct.recomendacoes.map(r=>[r.startupId,r.probabilidadeInteresse]));
      const first=await request('/startups/discovery?sort=compatibility&size=1&page=0',token);
      const second=await request('/startups/discovery?sort=compatibility&size=1&page=1',token);
      assert.equal(first.total,2);assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
      assert.equal(first.items[0].id,result.recomendacoes[0].startupId);assert.equal(second.items[0].id,result.recomendacoes[1].startupId);
      assert.ok(!Object.hasOwn(first.items[0],'compatibility'));frontendPageSchema().parse(first);
      const filtered=await request('/startups/discovery?sort=compatibility&segment=agtech',token);assert.equal(filtered.total,1);assert.equal(filtered.items[0].id,startupIds[0]);
      const context=readContext(result.recomendacoes[0].contextoExposicao);
      assert.equal(context.origin,'supervised');assert.equal(context.version,result.versaoModelo);
      const body={contexto:result.recomendacoes[0].contextoExposicao};
      const confirmations=await Promise.all(Array.from({length:4},()=>request('/startups/exposicoes',token,body)));
      confirmations.forEach(value=>assert.deepEqual(value,confirmations[0]));
      const [saved]=await db.query('SELECT * FROM exposicoes_startups WHERE id=$1',[context.exposureId]);
      assert.equal(saved.origem_recomendacao,'supervised');assert.equal(saved.versao_recomendador,result.versaoModelo);assert.equal(saved.posicao_ranking,1);
      const matched=startups.find(s=>s.id===context.startupId);
      const {supervisedInvestorFeatures,supervisedStartupFeatures}=require('../src/modules/matchmaking/supervisedContracts');
      assert.deepEqual(saved.snapshot_perfis,{investidor:project(investor,supervisedInvestorFeatures),startup:project(matched,supervisedStartupFeatures)});
      assert.equal(saved.snapshot_perfis.startup.estado,'PE');
      assert.equal((await db.query('SELECT count(*)::int n FROM exposicoes_startups'))[0].n,3);
      observations.supervised={version:result.versaoModelo,origin:result.origemRecomendacao,
        recommendations:result.recomendacoes.map(r=>({probabilidadeInteresse:r.probabilidadeInteresse,posicaoRanking:r.posicaoRanking})),exposureStatus:200,idempotent:true};
    } finally {delete process.env.MATCHMAKING_STRATEGY;}
  });
  await check('disposable: controlled upstream outage uses real rules HTTP and preserves exposure idempotence', async () => {
    const http=require('node:http');const originalUrl=process.env.MATCHMAKING_API_URL;
    const upstreamUrl=originalUrl||'http://127.0.0.1:8000';
    const proxy=http.createServer(async(req,res)=>{
      if(req.url==='/match/supervised'){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"detail":"controlled test outage"}');return;}
      try{const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const upstream=await nativeFetch(new URL('/match/rules',upstreamUrl),{method:'POST',headers:{'Content-Type':'application/json'},body:Buffer.concat(chunks)});
        res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(await upstream.text());
      }catch{res.writeHead(503);res.end('{}');}
    });
    await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
    process.env.MATCHMAKING_API_URL='http://127.0.0.1:'+proxy.address().port;process.env.MATCHMAKING_STRATEGY='supervised';
    try{
      const result=await request('/startups/recomendacoes?limite=24',token);
      assert.equal(result.origemRecomendacao,'rules');assert.equal(result.fallback.de,'supervised');
      assert.ok(result.recomendacoes.every(r=>r.probabilidadeInteresse===undefined));
      assert.equal(readContext(result.recomendacoes[0].contextoExposicao).origin,'rules');
      const body={contexto:result.recomendacoes[0].contextoExposicao};
      const a=await request('/startups/exposicoes',token,body);const b=await request('/startups/exposicoes',token,body);assert.deepEqual(a,b);
      assert.equal((await db.query('SELECT count(*)::int n FROM exposicoes_startups'))[0].n,4);
    }finally{
      delete process.env.MATCHMAKING_STRATEGY;if(originalUrl===undefined)delete process.env.MATCHMAKING_API_URL;else process.env.MATCHMAKING_API_URL=originalUrl;
      proxy.closeAllConnections();await new Promise(r=>proxy.close(r));
    }
  });
  await check('real client: refused connection returns 503 without stopping FastAPI', async () => {
    const http=require('node:http');const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
    const previous=process.env.MATCHMAKING_API_URL;process.env.MATCHMAKING_API_URL='http://127.0.0.1:'+port;
    try{await assert.rejects(new MatchmakingClient().rules(fixture.request),e=>e.statusCode===503);}finally{if(previous===undefined)delete process.env.MATCHMAKING_API_URL;else process.env.MATCHMAKING_API_URL=previous;}
  });
}
mainRun().catch(e=>{checks.push({name:'harness',passed:false,error:e.message.slice(0,400)});console.error('FAIL: '+e.message.slice(0,400));}).finally(async()=>{
  await closeServer();if(db.isInitialized)await db.destroy();
  if(created){disposableGuard();await admin.query('DROP DATABASE "'+disposable+'" WITH (FORCE)');assert.equal((await admin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[disposable])).rows[0].n,0);console.log('OK: disposable database removed');}
  if(admin)await admin.end();
  if(baseline){await check('main: every table count and full-row digest unchanged',async()=>assert.deepEqual(await state(),baseline));await check('main: schema unchanged',async()=>assert.equal(normalized(schema()),normalized(schemaBefore)));}
  if(main)await main.end();global.fetch=nativeFetch;
  console.log(JSON.stringify({checks,observations,cleaned:created,upstreamHttpCalls:upstream.length},null,2));
  if(checks.some(x=>!x.passed))process.exitCode=1;
});
