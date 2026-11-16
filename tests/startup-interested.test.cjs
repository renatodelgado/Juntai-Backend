require('ts-node/register/transpile-only');require('tsconfig-paths/register');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {AppDataSource:db}=require('../src/shared/database/data-source');
const {StartupReceivedInterestsService:Service}=require('../src/modules/startups/services/StartupReceivedInterestsService');
const id='11111111-1111-1111-1111-111111111111';
test('interessados exigem startup ativa e aprovada derivada da conta autenticada',async t=>{
 const s=new Service();await assert.rejects(s.list('invalid'),e=>e.statusCode===401);
 t.mock.method(db,'query',async()=>[]);await assert.rejects(s.list(id),e=>e.statusCode===403);
});
test('resumo usa interesses deduplicados e reunioes reais sem dados privados',async t=>{
 const calls=[];t.mock.method(db,'query',async(sql,args)=>{calls.push({sql,args});return calls.length===1?[{id:'own-startup'}]:[{conversaIniciada:true,reunioesAgendadas:2},{conversaIniciada:false,reunioesAgendadas:0}];});
 const result=await new Service().list(id);
 assert.deepEqual(result.resumo,{interessados:2,conversasIniciadas:1,reunioesAgendadas:2});
 assert.deepEqual(calls[1].args,['own-startup',id]);
 assert.ok(!/email|senha_hash|telefone|ticket_minimo/i.test(calls[1].sql));
});
