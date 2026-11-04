process.env.JWT_SECRET='synthetic-tests-only';
require('ts-node/register/transpile-only');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {selectHighlights}=require('../src/modules/matchmaking/highlights');
test('destaques mantêm pontuações maiores e sorteiam apenas empates',()=>{
 const items=[{startupId:'a',scoreRanking:1},{startupId:'b',scoreRanking:.9},{startupId:'c',scoreRanking:.9},{startupId:'d',scoreRanking:.9},{startupId:'e',scoreRanking:.4}];
 const first=selectHighlights(items,3,()=>0);const other=selectHighlights(items,3,()=>.99);
 assert.equal(first[0].startupId,'a');assert.equal(other[0].startupId,'a');
 assert.notDeepEqual(first,other);assert(!first.some(i=>i.startupId==='e'));assert(!other.some(i=>i.startupId==='e'));
 assert.equal(new Set(first.map(i=>i.startupId)).size,3);assert.deepEqual(items.map(i=>i.startupId),['a','b','c','d','e']);
});
test('destaques usam probabilidades do modelo e aceitam catálogo pequeno',()=>{
 const a={startupId:'a',probabilidadeInteresse:0.2},b={startupId:'b',probabilidadeInteresse:0.9};
 assert.deepEqual(selectHighlights([a,b]),[b,a]);assert.deepEqual(selectHighlights([]),[]);
});
require('tsconfig-paths/register');
const {MatchmakingService}=require('../src/modules/matchmaking/MatchmakingService');
test('highlights expose scores and public profiles without account data',async(t)=>{
 const profiles=[1,2,3].map(i=>({id:String(i),nomeFantasia:'Startup '+i,usuario:{senhaHash:'must-not-leak'}}));
 const query={where(){return this},async getMany(){return profiles}};
 const service=new MatchmakingService({getRepository(){return {createQueryBuilder(){return query}}}});
 t.mock.method(service,'recommend',async()=>({recomendacoes:profiles.map((p,i)=>({startupId:p.id,score:1-i*.1,scoreRanking:1-i*.1,origemRecomendacao:'rules',contextoExposicao:'signed-context'}))}));
 const result=await service.highlights('approved-user');
 assert.equal(result.items.length,3);assert.equal(result.items[0].compatibility,100);
 assert(result.items.every(p=>!('usuario' in p)&&p.contextoExposicao==='signed-context'));
});
