require('ts-node/register/transpile-only');require('tsconfig-paths/register');require('dotenv').config({quiet:true});
const {Client}=require('pg');const {randomUUID}=require('node:crypto');const assert=require('node:assert/strict');
const {AppDataSource:db}=require('../src/shared/database/data-source');
const {StartupReceivedInterestsService:Service}=require('../src/modules/startups/services/StartupReceivedInterestsService');
(async()=>{
 assert.equal(process.env.INTERESTED_DB_TEST,'1');assert.ok(['localhost','127.0.0.1'].includes(process.env.DB_HOST||'localhost'));
 const c=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT)||5432,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
 await c.connect();const query=async(...args)=>(await c.query(...args)).rows;
 try{
 await query('BEGIN');const schema='interested_test_'+randomUUID().replaceAll('-','');await query(`CREATE SCHEMA ${schema}`);await query(`SET LOCAL search_path TO ${schema}`);
 await query(`CREATE TYPE interested_help AS ENUM ('networking');
 CREATE TYPE interested_segment AS ENUM ('fintech');
 CREATE TYPE interested_stage AS ENUM ('mvp');
 CREATE TABLE usuarios(id uuid PRIMARY KEY,tipo_perfil text,ativo boolean DEFAULT true,avatar_url text,email text,senha_hash text);
 CREATE TABLE startups(id uuid PRIMARY KEY,usuario_id uuid,status_moderacao text);
 CREATE TABLE investidores(id uuid PRIMARY KEY,usuario_id uuid,nome text,tipo_investidor text,status_moderacao text,
 titulo_profissional text,bio text,cidade text,estado text,linkedin_url text,descricao_experiencia text,anos_experiencia int,
 areas_ajuda interested_help[] DEFAULT '{}',segmentos_interesse interested_segment[] DEFAULT '{}',estagios_interesse interested_stage[] DEFAULT '{}');
 CREATE TABLE funil_interacoes(startup_id uuid,investidor_id uuid,tipo_evento text,ocorrido_em timestamptz DEFAULT now());
 CREATE TABLE conversas(id uuid PRIMARY KEY,startup_id uuid,investidor_id uuid);
 CREATE TABLE mensagens(conversa_id uuid,remetente_usuario_id uuid);
 CREATE TABLE reunioes(id bigserial PRIMARY KEY,startup_id uuid,investidor_id uuid,status text,data_hora_agendada timestamptz);`);
 db.query=query;
 const su=randomUUID(),su2=randomUUID(),s=randomUUID(),s2=randomUUID(),users=Array.from({length:5},randomUUID),investors=Array.from({length:5},randomUUID);
 for(const user of [su,su2])await query("INSERT INTO usuarios(id,tipo_perfil) VALUES($1,'startup')",[user]);
 await query("INSERT INTO startups VALUES($1,$2,'aprovado'),($3,$4,'aprovado')",[s,su,s2,su2]);
 for(let j=0;j<5;j++){
 await query("INSERT INTO usuarios(id,tipo_perfil,email,senha_hash) VALUES($1,'investidor','private@example.com','NEVER_RETURN')",[users[j]]);
 await query("INSERT INTO investidores(id,usuario_id,nome,tipo_investidor,status_moderacao) VALUES($1,$2,$3,$4,$5)",[investors[j],users[j],'Pessoa '+j,j===0?'mentor':'anjo',j===3?'pendente':'aprovado']);
 }
 await query("UPDATE investidores SET areas_ajuda='{networking}',segmentos_interesse='{fintech}',estagios_interesse='{mvp}'");
 await query('UPDATE investidores SET areas_ajuda=NULL,segmentos_interesse=NULL,estagios_interesse=NULL WHERE id=$1',[investors[0]]);
 await query("UPDATE usuarios SET ativo=false WHERE id=$1",[users[4]]);
 for(const j of [0,0,1,2,3,4])await query("INSERT INTO funil_interacoes(startup_id,investidor_id,tipo_evento) VALUES($1,$2,$3)",[s,investors[j],j===2?'visualizacao':'interesse_demonstrado']);
 await query("INSERT INTO funil_interacoes(startup_id,investidor_id,tipo_evento) VALUES($1,$2,'interesse_demonstrado')",[s2,investors[2]]);
 const conversation=randomUUID();await query('INSERT INTO conversas VALUES($1,$2,$3)',[conversation,s,investors[1]]);
 await query('INSERT INTO mensagens VALUES($1,$2),($1,$3)',[conversation,users[1],su]);
 await query("INSERT INTO reunioes(startup_id,investidor_id,status,data_hora_agendada) VALUES($1,$2,'agendada',now()+interval '1 day'),($1,$2,'agendada',now()+interval '2 days'),($1,$2,'realizada',now()-interval '1 day'),($3,$2,'agendada',now()+interval '1 hour')",[s,investors[1],s2]);
 const service=new Service();let result=await service.list(su);
 assert.deepEqual(result.resumo,{interessados:2,conversasIniciadas:1,reunioesAgendadas:2});
 const mentor=result.items.find(item=>item.investidorId===investors[0]);const investor=result.items.find(item=>item.investidorId===investors[1]);
 assert.deepEqual(mentor.areasAjuda,[]);assert.deepEqual(mentor.segmentosInteresse,[]);assert.deepEqual(mentor.estagiosInteresse,[]);
 assert.deepEqual(investor.areasAjuda,['networking']);assert.deepEqual(investor.segmentosInteresse,['fintech']);assert.deepEqual(investor.estagiosInteresse,['mvp']);
 assert.equal(result.items.length,2);assert.equal(result.items.find(i=>i.investidorId===investors[0]).situacao,'novo_interesse');
 const active=result.items.find(i=>i.investidorId===investors[1]);assert.equal(active.situacao,'reuniao_agendada');assert.equal(active.podeAvaliarConversa,true);assert.equal(active.conversaId,conversation);assert.ok(active.reuniaoRealizadaId);assert.equal(active.reunioesAgendadas,2);
 const serialized=JSON.stringify(result);assert.ok(!serialized.includes('NEVER_RETURN'));assert.ok(!serialized.includes('private@example.com'));assert.ok(!serialized.includes('senha_hash'));
 result=await service.list(su2);assert.equal(result.items.length,1);assert.equal(result.items[0].investidorId,investors[2]);
 await assert.rejects(service.list(users[0]),e=>e.statusCode===403);
 await query("UPDATE startups SET status_moderacao='pendente' WHERE id=$1",[s]);await assert.rejects(service.list(su),e=>e.statusCode===403);
 console.log('PASS PostgreSQL: startup isolation, deduplication, approval, active users, real actions, counts and public fields only');
 }finally{await c.query('ROLLBACK');await c.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
