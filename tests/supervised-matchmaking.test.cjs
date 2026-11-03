process.env.JWT_SECRET='synthetic-supervised-tests-only';
delete process.env.MATCHMAKING_STRATEGY;
require('ts-node/register/transpile-only');require('tsconfig-paths/register');
const {test}=require('node:test');const assert=require('node:assert/strict');
const fixture=require('./fixtures/supervised-contract.json');
const rulesFixture=require('./fixtures/matchmaking-contract.json');
const {MatchmakingClient}=require('../src/modules/matchmaking/MatchmakingClient');
const {MatchmakingService}=require('../src/modules/matchmaking/MatchmakingService');
const {SupervisedContractError,supervisedProfile}=require('../src/modules/matchmaking/supervisedContracts');
const {readContext}=require('../src/modules/matchmaking/ExposureContext');
const {AppError}=require('../src/shared/errors/AppError');
const clone=v=>structuredClone(v);

function store(){
 const investor={...clone(fixture.request.investidor),usuario:{...fixture.request.investidor.usuario,tipoPerfil:'investidor',senhaHash:'PRIVATE'},nome:'PRIVATE',email:'PRIVATE',statusModeracao:'aprovado',atualizadoEm:new Date('2026-01-01'),estado:'PE'};
 const startup={...clone(fixture.request.startups[0]),usuario:{...fixture.request.startups[0].usuario,tipoPerfil:'startup',senhaHash:'PRIVATE'},nomeFantasia:'PRIVATE',atualizadoEm:new Date('2026-01-01'),estado:'PE'};
 const candidates=[startup],calls=[];
 function repository(entity){const actor=entity.name==='Investidor';const q=new Proxy({}, {get(_,name){if(name==='getOne')return async()=>actor?investor:startup;if(name==='getMany')return async()=>candidates;if(name==='getCount')return async()=>candidates.length;if(name==='getRawMany')return async()=>[{estado:'PE',segmento:'agtech',regioes:['nordeste']}];return()=>q;}});return{createQueryBuilder:()=>q};}
 const saved=new Map();
 const manager={getRepository:repository,query:async(sql,values)=>{calls.push(sql);if(sql.startsWith('INSERT')){saved.set(values[0],{id:values[0],ocorrido_em:new Date('2026-01-01'),snapshot:JSON.parse(values[6])});return[saved.get(values[0])];}return saved.has(values[0])?[saved.get(values[0])]:[];}};
 return{investor,startup,candidates,calls,db:{manager,getRepository:repository,transaction:fn=>fn(manager)}};
}
function strategy(t,value){const old=process.env.MATCHMAKING_STRATEGY;if(value===undefined)delete process.env.MATCHMAKING_STRATEGY;else process.env.MATCHMAKING_STRATEGY=value;t.after(()=>{if(old===undefined)delete process.env.MATCHMAKING_STRATEGY;else process.env.MATCHMAKING_STRATEGY=old;});}
function supervisedResponse(payload){const response=clone(fixture.response);response.investidorId=payload.investidor.id;response.recomendacoes=payload.startups.slice(0,payload.limite).map((s,i)=>({...clone(fixture.response.recomendacoes[0]),startupId:s.id,posicao:i+1,probabilidadeInteresse:1-i*.1}));return response;}

test('cliente supervisionado: HTTP correto, contrato validado e projeção sem extras',async()=>{
 const upstream=clone(fixture.response);upstream.secret='PRIVATE';upstream.recomendacoes[0].secret='PRIVATE';
 const client=new MatchmakingClient(async(url,options)=>{assert.equal(url.pathname,'/match/supervised');assert.deepEqual(JSON.parse(options.body),fixture.request);assert.equal(options.redirect,'error');return new Response(JSON.stringify(upstream));});
 assert.ok(!JSON.stringify(await client.supervised(fixture.request)).includes('PRIVATE'));
});
for(const mutate of [p=>p.investidor.ticketMinimo=-1,p=>p.investidor.anosExperiencia='3',p=>p.investidor.secret='PRIVATE',p=>p.startups[0].statusModeracao='pendente',p=>p.startups[0].usuario.ativo=false,p=>p.startups[0].taxaCrescimentoPct='0.001',p=>p.investidor.ticketMinimo='10.00',p=>p.investidor.setoresAtuacao=['invalid']])test('payload supervisionado inválido não usa transporte',async()=>{
 const p=clone(fixture.request);p.investidor.ticketMaximo='1.00';mutate(p);
 await assert.rejects(new MatchmakingClient(()=>{throw Error('não chamar');}).supervised(p),SupervisedContractError);
});
for(const mutate of [r=>r.recomendacoes[0].probabilidadeInteresse=2,r=>r.recomendacoes[0].probabilidadeInteresse=null,r=>r.recomendacoes[0].startupId='foreign',r=>r.versaoFeatures='wrong',r=>r.recomendacoes[0].versaoModelo='other',r=>r.recomendacoes=[],r=>r.experimental=false,r=>r.excluidas=[{startupId:fixture.request.startups[0].id}]])test('contrato supervisionado inconsistente é 502',async()=>{
 const r=clone(fixture.response);mutate(r);await assert.rejects(new MatchmakingClient(async()=>new Response(JSON.stringify(r))).supervised(fixture.request),SupervisedContractError);
});
test('resposta fora de ordem e duplicações são rejeitadas',async()=>{
 const p=clone(fixture.request);p.startups.push({...p.startups[0],id:'33333333-3333-4333-8333-333333333333'});
 const r=supervisedResponse(p);r.recomendacoes[1].probabilidadeInteresse=1;r.recomendacoes.reverse();r.recomendacoes.forEach((x,i)=>x.posicao=i+1);
 await assert.rejects(new MatchmakingClient(async()=>new Response(JSON.stringify(r))).supervised(p),SupervisedContractError);
 r.recomendacoes[1].startupId=r.recomendacoes[0].startupId;
 await assert.rejects(new MatchmakingClient(async()=>new Response(JSON.stringify(r))).supervised(p),SupervisedContractError);
});
test('timeout e conexão indisponível são controlados no cliente supervisionado',async(t)=>{
 await assert.rejects(new MatchmakingClient(async()=>{throw Error('internal');}).supervised(fixture.request),e=>e.statusCode===503);
 const old=process.env.MATCHMAKING_TIMEOUT_MS;process.env.MATCHMAKING_TIMEOUT_MS='5';t.after(()=>{if(old===undefined)delete process.env.MATCHMAKING_TIMEOUT_MS;else process.env.MATCHMAKING_TIMEOUT_MS=old;});
 await assert.rejects(new MatchmakingClient((_u,{signal})=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}))).supervised(fixture.request),e=>e.statusCode===504);
});
for(const code of [404,503,500,422])test('HTTP supervisionado '+code+' tem classificação explícita',async()=>{
 await assert.rejects(new MatchmakingClient(async()=>new Response('private',{status:code})).supervised(fixture.request),e=>e.statusCode===(code===422?502:503));
});
test('estratégia padrão continua rules',async(t)=>{strategy(t,undefined);const s=store();let called=0;
 const r=await new MatchmakingService(s.db,{rules:async()=>{called++;return rulesFixture.response;},supervised:async()=>{throw Error('não chamar');}}).recommend(s.investor.usuario.id,24);
 assert.equal(called,1);assert.equal(r.origemRecomendacao,'rules');assert.equal(r.recomendacoes[0].score,1);
});
test('supervised: perfil minimizado, filtros operacionais e contexto assinado',async(t)=>{
 strategy(t,'supervised');const s=store();s.candidates.push({...s.startup,id:'33333333-3333-4333-8333-333333333333',statusModeracao:'pendente'});
 const r=await new MatchmakingService(s.db,{supervised:async p=>{assert.equal(p.startups.length,1);assert.ok(!JSON.stringify(p).includes('PRIVATE'));assert.equal(p.investidor.estado,'PE');return supervisedResponse(p);}}).recommend(s.investor.usuario.id,24);
 assert.equal(r.origemRecomendacao,'supervised');assert.equal(r.recomendacoes.length,1);assert.equal(r.recomendacoes[0].score,undefined);
 const c=readContext(r.recomendacoes[0].contextoExposicao);assert.equal(c.origin,'supervised');assert.equal(c.version,fixture.response.versaoModelo);assert.equal(c.position,1);
 const service=new MatchmakingService(s.db),context=r.recomendacoes[0].contextoExposicao;
 const a=await service.confirmExposure(s.investor.usuario.id,context);const b=await service.confirmExposure(s.investor.usuario.id,context);
 assert.deepEqual(a,b);assert.equal(a.snapshot.investidor.estado,'PE');assert.equal(a.snapshot.startup.estado,'PE');assert.equal(s.calls.filter(sql=>sql.startsWith('INSERT')).length,1);
});
test('paginação supervisionada não apresenta probabilidade como compatibility',async(t)=>{
 strategy(t,'supervised');const s=store();s.candidates.push({...s.startup,id:'33333333-3333-4333-8333-333333333333'});
 const r=await new MatchmakingService(s.db,{supervised:async p=>supervisedResponse(p)}).discovery(s.investor.usuario.id,{sort:'compatibility',page:'1',size:'1'});
 assert.equal(r.total,2);assert.equal(r.hasMore,false);assert.equal(r.items[0].probabilidadeInteresse,.9);assert.equal(r.items[0].compatibility,undefined);assert.equal(r.items[0].posicaoRanking,2);assert.equal(r.items[0].usuario,undefined);
});
for(const code of [503,504])test('fallback '+code+' retorna rules sem probabilidades inventadas',async(t)=>{
 strategy(t,'supervised');const s=store();const logs=[];t.mock.method(console,'warn',v=>logs.push(v));
 const r=await new MatchmakingService(s.db,{supervised:async()=>{throw new AppError('private',code);},rules:async()=>rulesFixture.response}).recommend(s.investor.usuario.id,24);
 assert.equal(r.origemRecomendacao,'rules');assert.equal(r.fallback.de,'supervised');assert.equal(r.recomendacoes[0].probabilidadeInteresse,undefined);assert.equal(readContext(r.recomendacoes[0].contextoExposicao).origin,'rules');assert.ok(!JSON.stringify(logs).includes('private'));
});
test('erros graves de contrato não são ocultados por fallback',async(t)=>{
 strategy(t,'supervised');const s=store();t.mock.method(console,'error',()=>{});let fallback=0;
 await assert.rejects(new MatchmakingService(s.db,{supervised:async()=>{throw new SupervisedContractError();},rules:async()=>{fallback++;}}).recommend(s.investor.usuario.id,24),SupervisedContractError);assert.equal(fallback,0);
});
test('falha em lote posterior descarta todo o ranking parcial e recalcula rules',async(t)=>{
 strategy(t,'supervised');const s=store();t.mock.method(console,'warn',()=>{});for(let n=1;n<=10000;n++)s.candidates.push({...s.startup,id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`});
 let calls=0;const batches=[];
 const r=await new MatchmakingService(s.db,{supervised:async p=>{if(++calls===2)throw new AppError('unavailable',503);return supervisedResponse(p);},rules:async p=>{batches.push(p.startups.length);const f=clone(rulesFixture.response);f.recomendacoes[0].startupId=p.startups[0].id;return f;}}).recommend(s.investor.usuario.id,1);
 assert.deepEqual(batches,[10000,1]);assert.equal(r.origemRecomendacao,'rules');assert.equal(r.recomendacoes[0].probabilidadeInteresse,undefined);
});
test('estratégia desconhecida falha explicitamente',async(t)=>{strategy(t,'invalid');const s=store();await assert.rejects(new MatchmakingService(s.db).recommend(s.investor.usuario.id,24),e=>e.statusCode===500);});
test('ranking global supervisionado combina lotes por probabilidade sem misturar versões',async(t)=>{
 strategy(t,'supervised');const s=store();for(let n=1;n<=10000;n++)s.candidates.push({...s.startup,id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`});
 let calls=0;
 const r=await new MatchmakingService(s.db,{supervised:async p=>{const r=supervisedResponse(p);r.recomendacoes[0].probabilidadeInteresse=++calls===1?.1:.9;return r;}}).recommend(s.investor.usuario.id,1);
 assert.equal(calls,2);assert.equal(r.recomendacoes[0].startupId,s.candidates[10000].id);assert.equal(r.recomendacoes[0].probabilidadeInteresse,.9);assert.equal(r.recomendacoes[0].posicaoRanking,1);
});
test('versões inconsistentes entre lotes são erro grave',async(t)=>{
 strategy(t,'supervised');const s=store();t.mock.method(console,'error',()=>{});for(let n=1;n<=10000;n++)s.candidates.push({...s.startup,id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`});
 let calls=0;
 await assert.rejects(new MatchmakingService(s.db,{supervised:async p=>{const r=supervisedResponse(p);if(++calls===2)r.versaoModelo='another-version';return r;}}).recommend(s.investor.usuario.id,1),SupervisedContractError);
});
for(const actor of ['investor','startup'])test('snapshot supervisionado rejeita estado alterado do '+actor,async(t)=>{
 strategy(t,'supervised');const s=store();const service=new MatchmakingService(s.db,{supervised:async p=>supervisedResponse(p)});
 const r=await service.recommend(s.investor.usuario.id,24);s[actor].estado='SP';
 await assert.rejects(service.confirmExposure(s.investor.usuario.id,r.recomendacoes[0].contextoExposicao),e=>e.statusCode===409);
 assert.equal(s.calls.filter(sql=>sql.startsWith('INSERT')).length,0);
});
