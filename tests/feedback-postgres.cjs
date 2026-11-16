// Opt-in PostgreSQL integration. All DDL/data are isolated in a transaction and rolled back.
require('ts-node/register/transpile-only');require('tsconfig-paths/register');require('dotenv').config({quiet:true});
const {Client}=require('pg');const {randomUUID}=require('node:crypto');const assert=require('node:assert/strict');
const {AppDataSource:db}=require('../src/shared/database/data-source');
const {FeedbackInteracoes1794787200000:Migration}=require('../src/shared/database/migrations/1794787200000-FeedbackInteracoes');
const {FeedbackResultados1794787200001:MetricasMigration}=require('../src/shared/database/migrations/1794787200001-FeedbackResultados');
const {AvaliacaoService}=require('../src/modules/avaliacoes/services/AvaliacaoService');
const {ReuniaoRepository}=require('../src/modules/reunioes/repositories/ReuniaoRepository');
async function main(){
 assert.equal(process.env.FEEDBACK_DB_TEST,'1');assert.ok(['localhost','127.0.0.1'].includes(process.env.DB_HOST || 'localhost'));
 const client=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT)||5432,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
 await client.connect();const query=async (...args)=>(await client.query(...args)).rows;
 const schema='feedback_test_'+randomUUID().replaceAll('-','');
 try {
 await query('BEGIN');await query(`CREATE SCHEMA ${schema}`);await query(`SET LOCAL search_path TO ${schema}`);
 await query(`CREATE TABLE usuarios(id uuid PRIMARY KEY,ativo boolean DEFAULT true);
 CREATE TABLE startups(id uuid PRIMARY KEY,usuario_id uuid REFERENCES usuarios(id),nome_fantasia text);
 CREATE TABLE investidores(id uuid PRIMARY KEY,usuario_id uuid REFERENCES usuarios(id),nome text);
 CREATE TABLE conversas(id uuid PRIMARY KEY,startup_id uuid,investidor_id uuid);
 CREATE TABLE mensagens(id bigserial,conversa_id uuid,remetente_usuario_id uuid);
 CREATE TABLE reunioes(id bigserial PRIMARY KEY,startup_id uuid,investidor_id uuid,status text,data_hora_agendada timestamptz);`);
 await new Migration().up({query});db.query=query;
 const a=randomUUID(),b=randomUUID(),outsider=randomUUID(),s=randomUUID(),i=randomUUID(),c=randomUUID();
 for (const id of [a,b,outsider]) await query('INSERT INTO usuarios(id) VALUES($1)',[id]);
 await query("INSERT INTO startups VALUES($1,$2,'Startup')",[s,a]);await query("INSERT INTO investidores VALUES($1,$2,'Investidor')",[i,b]);
 await query('INSERT INTO conversas VALUES($1,$2,$3)',[c,s,i]);
 await query('INSERT INTO avaliacoes(conversa_id,avaliador_usuario_id,avaliado_usuario_id,nota,comentario) VALUES($1,$2,$3,3,$4)',[c,a,b,'Historico preservado']);
 await new MetricasMigration().up({query});
 const [legacy]=await query('SELECT nota,comentario,resultado_interacao,perspectiva_investimento FROM avaliacoes');
 assert.deepEqual(legacy,{nota:3,comentario:'Historico preservado',resultado_interacao:'em_analise',perspectiva_investimento:'nao_definido'});
 const service=new AvaliacaoService();
 assert.equal((await service.consultar(a,'conversa',c)).elegivel,false);
 await assert.rejects(service.salvar(a,'conversa',c,{nota:4}));
 await assert.rejects(service.consultar(outsider,'conversa',c));
 await query('INSERT INTO mensagens(conversa_id,remetente_usuario_id) VALUES($1,$2),($1,$3)',[c,a,b]);
 assert.equal((await service.consultar(a,'conversa',c)).elegivel,true);
 await Promise.all([service.salvar(a,'conversa',c,{nota:4}),service.salvar(a,'conversa',c,{nota:5})]);
 assert.equal((await query('SELECT * FROM avaliacoes')).length,1);
 assert.equal((await service.consultar(b,'conversa',c)).avaliacao,null);
 await service.salvar(b,'conversa',c,{nota:2});
 let state=await service.salvar(a,'conversa',c,{nota:5,comentario:'Privado',resultadoInteracao:'avancar',perspectivaInvestimento:'realizado',investimentoConfirmado:true});
 assert.equal(state.investimentoConfirmado,false,'Client cannot assert a confirmed investment');
 state=await service.consultar(b,'conversa',c);
 assert.equal(state.investimentoInformadoPeloOutro,true);assert.equal(state.investimentoConfirmado,false);
 assert.equal(state.avaliacao.nota,2);assert.equal(state.avaliacao.comentario,null);
 state=await service.salvar(b,'conversa',c,{nota:2,perspectivaInvestimento:'realizado'});
 assert.equal(state.investimentoConfirmado,true);
 assert.equal((await service.consultar(a,'conversa',c)).investimentoConfirmado,true);
 await service.salvar(b,'conversa',c,{nota:2,perspectivaInvestimento:'nao_se_aplica'});
 assert.equal((await service.consultar(a,'conversa',c)).investimentoConfirmado,false);
 state=await service.salvar(a,'conversa',c,{nota:4});
 assert.equal(state.avaliacao.resultadoInteracao,'avancar');
 assert.equal(state.avaliacao.perspectivaInvestimento,'realizado','Legacy update preserves new fields');
 await assert.rejects(service.salvar(a,'conversa',c,{nota:4,perspectivaInvestimento:'confirmado'}));
 await query('SAVEPOINT invalid_metric');
 await assert.rejects(query("UPDATE avaliacoes SET resultado_interacao='invalido'"));
 await query('ROLLBACK TO SAVEPOINT invalid_metric');
 await assert.rejects(query("UPDATE avaliacoes SET perspectiva_investimento='confirmado'"));
 await query('ROLLBACK TO SAVEPOINT invalid_metric');
 const rows=await query(`INSERT INTO reunioes(startup_id,investidor_id,status,data_hora_agendada) VALUES
 ($1,$2,'agendada',now()-interval '25 hours'),($1,$2,'agendada',now()-interval '23 hours'),
 ($1,$2,'cancelada',now()-interval '25 hours'),($1,$2,'no_show',now()-interval '25 hours') RETURNING id::text`,[s,i]);
 await new ReuniaoRepository().concluirVencidas();
 assert.deepEqual((await query('SELECT status FROM reunioes ORDER BY id')).map(r=>r.status),['realizada','agendada','cancelada','no_show']);
 assert.equal((await service.pendentes(a)).length,1);await service.adiar(a,'reuniao',rows[0].id);assert.equal((await service.pendentes(a)).length,0);
 await query("UPDATE avaliacao_adiamentos SET adiado_ate=now()-interval '1 minute'");assert.equal((await service.pendentes(a)).length,1);
 await service.salvar(a,'reuniao',rows[0].id,{nota:5});assert.equal((await service.pendentes(a)).length,0);
 assert.equal((await service.pendentes(b)).length,1);
 await assert.rejects(query(`INSERT INTO avaliacoes(conversa_id,avaliador_usuario_id,avaliado_usuario_id,nota) VALUES($1,$2,$3,6)`,[c,outsider,b]));
 console.log('PASS PostgreSQL: migration, RBAC, eligibility, concurrent upsert, privacy, reminders, automatic completion, compact metrics, bilateral confirmation, legacy data and constraints');
 } finally {await client.query('ROLLBACK');await client.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
