require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validarNota,validarContexto,validarMetricas,AvaliacaoService} = require('../src/modules/avaliacoes/services/AvaliacaoService');
const {AppDataSource:db} = require('../src/shared/database/data-source');
const {ReuniaoService} = require('../src/modules/reunioes/services/ReuniaoService');
const {ReuniaoRepository} = require('../src/modules/reunioes/repositories/ReuniaoRepository');
test('feedback valida nota inteira, comentário e contexto', () => {
 for (const nota of [0,6,1.5,'5',null,undefined]) assert.throws(() => validarNota(nota,''));
 assert.deepEqual(validarNota(5,' ótimo '),{nota:5,comentario:'ótimo'});
 assert.deepEqual(validarNota(1,undefined),{nota:1,comentario:null});
 assert.throws(() => validarNota(2,'a'.repeat(2001)));
 assert.throws(() => validarNota(2,{}));
 for (const [tipo,id] of [['outro','1'],['reuniao','1 OR true'],['conversa','1']]) assert.throws(() => validarContexto(tipo,id));
});
test('feedback não permite consultar ou avaliar contexto de terceiros',async t => {
 t.mock.method(db,'query',async () => []);
 const s=new AvaliacaoService();
 await assert.rejects(s.consultar('user','reuniao','1'),e => e.statusCode===404);
 await assert.rejects(s.salvar('user','reuniao','1',{nota:5}),e => e.statusCode===404);
});
test('feedback impede avaliar antes da interação e resolve o avaliado no servidor',async t => {
 const s=new AvaliacaoService();
 t.mock.method(s,'contexto',async () => ({elegivel:false,startup:'a',investidor:'b'}));
 await assert.rejects(s.salvar('a','reuniao','1',{nota:5}),e => e.statusCode===409);
 s.contexto=async () => ({elegivel:true,startup:'a',investidor:'b'});
 t.mock.method(s,'consultar',async () => ({elegivel:true}));
 const calls=[];t.mock.method(db,'query',async (...args) => {calls.push(args);return [];});
 await s.salvar('a','reuniao','1',{nota:4,avaliado:'terceiro'});
 assert.equal(calls[0][1][2],'b');assert.match(calls[0][0],/ON CONFLICT/);
});
test('conclusão manual só é permitida após início',async t => {
 const s=new ReuniaoService();
 t.mock.method(s.reuniaoRepository,'buscarPorId',async () => ({id:'1',status:'agendada',dataHoraAgendada:new Date(Date.now()+60000),startup:{id:'s'},investidor:{id:'i'}}));
 t.mock.method(s.usuarioRepository,'findById',async () => ({ativo:true,tipoPerfil:'startup'}));
 t.mock.method(s.startupRepository,'findByUsuarioId',async () => ({id:'s'}));
 await assert.rejects(s.atualizarStatus('a','1','realizada'),e => e.statusCode===400);
});
test('conclusão automática atualiza apenas agendadas com 24 horas completas',async t => {
 let sql;t.mock.method(db,'query',async value => {sql=value;return [];});
 await new ReuniaoRepository().concluirVencidas();
 assert.match(sql,/status='agendada'/);assert.match(sql,/data_hora_agendada <= now\(\)-interval '24 hours'/);
});

test('atualização manual não sobrescreve um estado final concorrente',async t => {
 const repository=new ReuniaoRepository();
 const builder={update(){return this;},set(){return this;},where(){return this;},async execute(){return {affected:0};}};
 t.mock.method(db,'getRepository',()=>({createQueryBuilder:()=>builder}));
 await assert.rejects(repository.atualizarStatus('1','cancelada'),e=>e.statusCode===409);
});

test('metricas compactas validam opcoes e mantem compatibilidade com clientes anteriores', () => {
 assert.deepEqual(validarMetricas({}),{resultado:null,perspectiva:null});
 for(const resultadoInteracao of ['em_analise','avancar','nao_seguir']) assert.equal(validarMetricas({resultadoInteracao}).resultado,resultadoInteracao);
 for(const perspectivaInvestimento of ['nao_definido','em_negociacao','intencao','realizado','nao_se_aplica']) assert.equal(validarMetricas({perspectivaInvestimento}).perspectiva,perspectivaInvestimento);
 for(const value of [null,1,{},'confirmado','']) {
  assert.throws(()=>validarMetricas({resultadoInteracao:value}));
  assert.throws(()=>validarMetricas({perspectivaInvestimento:value}));
 }
});
