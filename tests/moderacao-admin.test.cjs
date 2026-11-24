require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const express = require('express');
const { v2: cloudinary } = require('cloudinary');
const app = require('../src/App').default;
const { discoveryRoutes } = require('../src/modules/startups/routes/discovery.routes');
const { AppDataSource: db } = require('../src/shared/database/data-source');
const { authConfig } = require('../src/shared/config/auth');
const { sancoesService } = require('../src/modules/moderacao/services/SancaoService');
const { EvidenciaService } = require('../src/modules/moderacao/services/EvidenciaService');
const { ModeracaoIa1794873600000 } = require('../src/shared/database/migrations/1794873600000-ModeracaoIa');
const { EvidenciaDenuncia1794873600001 } = require('../src/shared/database/migrations/1794873600001-EvidenciaDenuncia');
const { FeedbackInteracoes1794787200000 } = require('../src/shared/database/migrations/1794787200000-FeedbackInteracoes');
const { FeedbackResultados1794787200001 } = require('../src/shared/database/migrations/1794787200001-FeedbackResultados');

function token(usuarioId, tipoPerfil) {
  return 'Bearer ' + jwt.sign({ tipoPerfil }, authConfig.secret, { subject: usuarioId });
}

async function ouvir(t, aplicacao = app) {
  const server = aplicacao.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  return (path, { authorization, body, method, prefix = '/admin/denuncias' } = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${prefix}${path}`,
    {
      method,
      headers: { ...(authorization && { authorization }), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

test('administração de denúncias exige JWT e nega todas as operações a usuários comuns', async t => {
  t.mock.method(sancoesService, 'verificarAcesso', async () => {});
  const http = await ouvir(t);
  const id = randomUUID();
  assert.equal((await http('')).status, 401);
  const authorization = token(randomUUID(), 'startup');
  for (const [path, method] of [['', 'GET'], [`/${id}`, 'GET'], [`/${id}/assumir`, 'POST'], [`/${id}/decisao`, 'POST']]) {
    const resposta = await http(path, { authorization, method });
    assert.equal(resposta.status, 403);
    assert.deepEqual(Object.keys(await resposta.json()), ['message']);
  }
});

test('evidência de arquivo exige ativo autenticado vinculado à denúncia e expira em cinco minutos', async t => {
  const anterior = process.env.CLOUDINARY_URL;
  t.after(() => {
    if (anterior === undefined) delete process.env.CLOUDINARY_URL;
    else process.env.CLOUDINARY_URL = anterior;
  });
  const id = randomUUID();
  const service = new EvidenciaService();
  const referencia = 'cloudinary:identificador';
  delete process.env.CLOUDINARY_URL;
  assert.deepEqual(await service.acessar(id, referencia), { disponivel: false });
  process.env.CLOUDINARY_URL = 'cloudinary://test:test@test';
  t.mock.method(cloudinary, 'config', () => ({}));
  const publicId = `juntai/moderacao/evidencias/${id}.pdf`;
  const asset = { asset_id: 'identificador', resource_type: 'raw', public_id: publicId, type: 'authenticated' };
  t.mock.method(cloudinary.api, 'resources_by_asset_ids', async ids => {
    assert.deepEqual(ids, ['identificador']);
    return { resources: [asset] };
  });
  const assinar = t.mock.method(cloudinary.utils, 'private_download_url', (id, formato, opcoes) => {
    assert.equal(id, publicId);
    assert.equal(formato, 'pdf');
    assert.equal(opcoes.type, 'authenticated');
    assert.equal(opcoes.resource_type, 'raw');
    assert.ok(opcoes.expires_at <= Math.floor(Date.now() / 1000) + 300);
    return 'https://example.test/temporario';
  });
  assert.equal((await service.acessar(id, referencia)).url, 'https://example.test/temporario');
  assert.deepEqual(await service.acessar(randomUUID(), referencia), { disponivel: false });
  asset.type = 'upload';
  assert.deepEqual(await service.acessar(id, referencia), { disponivel: false });
  assert.equal(assinar.mock.callCount(), 1);
});

test('PostgreSQL isolado: fila, detalhe, restrições, concorrência e rollback da auditoria', {
  skip: process.env.MODERACAO_DB_TEST !== '1', timeout: 30000,
}, async t => {
  const { host, port, username, password, database } = db.options;
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(host));
  const schema = 'moderacao_admin_test_' + randomUUID().replaceAll('-', '');
  const bootstrap = new Client({ host, port, user: username, password, database });
  await bootstrap.connect();
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await bootstrap.end();
  }
  t.diagnostic('Schema de teste preservado: ' + schema);
  db.setOptions({ schema, extra: { options: `-c search_path=${schema}` }, installExtensions: false });
  await db.initialize();
  t.after(() => db.destroy());

  const [adminA, adminB, usuario, rollbackAssumir, rollbackDecisao, rollbackAcesso, arquivoId,
    usuarioInvestidor, startupId, investidorId, conversaId] = Array.from({ length: 11 }, () => randomUUID());
  await db.transaction(async manager => {
    await manager.query(`
      CREATE TYPE acao_auditoria_enum AS ENUM ('remocao_conteudo');
      CREATE TABLE usuarios (id uuid PRIMARY KEY, nome text, email text, senha_hash text, tipo_perfil text,
        ativo boolean NOT NULL DEFAULT true, avatar_url text, criado_em timestamptz, atualizado_em timestamptz);
      CREATE TABLE log_auditoria (id bigserial PRIMARY KEY, admin_usuario_id uuid REFERENCES usuarios,
        acao acao_auditoria_enum NOT NULL, entidade_tipo varchar(30) NOT NULL, entidade_id uuid,
        detalhes jsonb, criado_em timestamptz NOT NULL DEFAULT now());
      CREATE TABLE conversas (id uuid PRIMARY KEY, startup_id uuid, investidor_id uuid,
        criada_em timestamptz DEFAULT now(), ultima_mensagem_em timestamptz);
      CREATE TABLE mensagens (id bigint GENERATED BY DEFAULT AS IDENTITY (START WITH 100) PRIMARY KEY,
        conversa_id uuid, remetente_usuario_id uuid, conteudo text, enviado_em timestamptz DEFAULT now(), lido_em timestamptz);
      CREATE TABLE reunioes (id bigint PRIMARY KEY, startup_id uuid, investidor_id uuid,
        status text, data_hora_agendada timestamptz, link_reuniao text, notas text, criado_em timestamptz DEFAULT now());
      CREATE TABLE funil_interacoes (startup_id uuid, investidor_id uuid, tipo_evento text, ocorrido_em timestamptz);
    `);
    for (const entidade of ['Startup', 'Investidor']) {
      const metadata = db.getMetadata(entidade);
      const colunas = metadata.columns.map(coluna => {
        const tipo = coluna.enum ? 'text' : db.driver.normalizeType(coluna);
        return `"${coluna.databaseName}" ${tipo}${coluna.isArray ? '[]' : ''}${coluna.isPrimary ? ' PRIMARY KEY' : ''}`;
      });
      await manager.query(`CREATE TABLE "${metadata.tableName}" (${colunas.join(',')})`);
    }
    await new FeedbackInteracoes1794787200000().up(manager);
    await new FeedbackResultados1794787200001().up(manager);
    await new ModeracaoIa1794873600000().up(manager);
    await new EvidenciaDenuncia1794873600001().up(manager);
  });
  await db.query(
    "INSERT INTO usuarios(id,nome,tipo_perfil) VALUES ($1,'Admin A','admin'), ($2,'Admin B','admin'), ($3,'Usuário','startup'), ($4,'Conta', 'investidor')",
    [adminA, adminB, usuario, usuarioInvestidor]);
  await db.query(`INSERT INTO startups(id,usuario_id,nome_fantasia,descricao_curta,status_moderacao,atualizado_em,criado_em)
    VALUES ($1,$2,'Nome visível','abacaxi confidencial','aprovado',now(),now())`, [startupId, usuario]);
  await db.query(`INSERT INTO investidores(id,usuario_id,nome,status_moderacao,atualizado_em,criado_em)
    VALUES ($1,$2,'Nome investidor', 'aprovado',now(),now())`, [investidorId, usuarioInvestidor]);
  await db.query('INSERT INTO conversas(id,startup_id,investidor_id) VALUES ($1,$2,$3)', [conversaId, startupId, investidorId]);
  await db.query(`INSERT INTO mensagens(id,conversa_id,remetente_usuario_id,conteudo,enviado_em)
    VALUES (1,$1,$2,'Somente a mensagem denunciada',now()), (2,$1,$2,'Mensagem anterior',now()-interval '1 min'),
      (3,$1,$3,'Resposta',now()-interval '2 min')`, [conversaId, usuarioInvestidor, usuario]);
  await db.query(`INSERT INTO avaliacoes(id,conversa_id,avaliador_usuario_id,avaliado_usuario_id,nota,comentario)
    VALUES (4,$1,$2,$3,4,'Comentário denunciado')`, [conversaId, usuario, usuarioInvestidor]);
  await db.query(`INSERT INTO funil_interacoes VALUES ($1,$2,'interesse_demonstrado',now())`, [startupId, investidorId]);
  let proximoAlvo = 1;
  const seed = async (tipo, criadaEm, id = randomUUID(), alvoId, campoAlvo = null, autor = usuario) => {
    alvoId ??= tipo === 'startup' ? randomUUID() : String(proximoAlvo++);
    await db.query(`INSERT INTO denuncias(id, denunciante_usuario_id, denunciado_usuario_id, tipo_alvo,
      alvo_id, motivo, descricao, criada_em, evidencia_snapshot, campo_alvo)
      VALUES ($1,$2,$2,$3,$4,'Motivo','Descrição',$5,'{"conteudo":"Somente a mensagem denunciada"}',$6)`,
    [id, autor, tipo, alvoId, criadaEm, campoAlvo]);
    return id;
  };
  const recente = await seed('mensagem', '2026-11-20T23:59:59Z');
  const anterior = await seed('mensagem', '2026-11-19T00:00:00Z');
  await seed('mensagem', '2026-11-21T00:00:00Z');
  const avaliacaoId = await seed('avaliacao', '2026-11-20T15:00:00Z');
  for (const id of [rollbackAssumir, rollbackDecisao, rollbackAcesso, arquivoId])
    await seed('startup', '2026-11-16T00:00:00Z', id);
  await db.query(`UPDATE denuncias SET evidencia_snapshot=NULL, evidencia_ref='cloudinary:assetTeste' WHERE id=$1`, [arquivoId]);
  await db.query(`INSERT INTO log_auditoria(admin_usuario_id,acao,entidade_tipo,entidade_id)
    VALUES ($1,'remocao_conteudo','mensagem',$2)`, [adminA, recente]);
  await db.query(`ALTER TABLE log_auditoria ADD CONSTRAINT teste_falha_auditoria CHECK (
    NOT (entidade_id='${rollbackAssumir}' AND acao='analise_denuncia') AND
    NOT (entidade_id='${rollbackDecisao}' AND acao='decisao_denuncia') AND
    NOT (entidade_id='${rollbackAcesso}' AND acao='acesso_evidencia'))`);

  const http = await ouvir(t);
  const get = (path, id = adminA) => http(path, { authorization: token(id, 'admin') });
  const post = (id, acao, admin, body) => http(`/${id}/${acao}`, { authorization: token(admin, 'admin'), method: 'POST', body });
  const decisao = { procedente: true, justificativa: '  Violação confirmada.  ' };
  const comoUsuario = (path, role = 'startup', options = {}) => http(path, {
    prefix: '', authorization: token(role === 'startup' ? usuario : usuarioInvestidor, role), ...options,
  });
  const ler = async (path, role, options) => {
    const response = await comoUsuario(path, role, options);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const estado = async id => (await db.query('SELECT status, admin_usuario_id, analisada_em FROM denuncias WHERE id=$1', [id]))[0];
  const auditoria = async id => db.query(`SELECT acao, admin_usuario_id, detalhes FROM log_auditoria
    WHERE entidade_tipo='denuncia' AND entidade_id=$1 ORDER BY id`, [id]);

  assert.equal((await get('', usuario)).status, 403);
  assert.equal((await get('/' + randomUUID())).status, 404);
  assert.equal((await get('/id-invalido')).status, 400);
  assert.equal((await get('?inicio=2026-02-30')).status, 400);
  assert.equal((await get('?inicio=2026-11-20&fim=2026-11-19')).status, 400);
  assert.equal((await get('?size=51')).status, 400);
  assert.equal((await get('?status=aprovado')).status, 400);
  const filtro = '?status=pendente&tipoAlvo=mensagem&inicio=2026-11-19&fim=2026-11-20&size=1';
  for (const [page, id] of [[1, recente], [2, anterior]]) {
    const response = await get(filtro + '&page=' + page);
    assert.equal(response.status, 200);
    const fila = await response.json();
    assert.equal(fila.page, page);
    assert.equal(fila.hasMore, page === 1);
    assert.deepEqual(fila.items.map(row => row.id), [id]);
    assert.ok(!('evidencia' in fila.items[0]) && !('descricao' in fila.items[0]));
  }

  const detalhe = await get('/' + recente);
  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.headers.get('cache-control'), 'no-store');
  const inicial = await detalhe.json();
  assert.equal(inicial.descricao, 'Descrição');
  assert.equal(inicial.adminResponsavel, null);
  assert.deepEqual(inicial.evidencia.snapshot, { conteudo: 'Somente a mensagem denunciada' });
  assert.deepEqual(inicial.historico.map(row => row.acao), ['acesso_evidencia']);
  const [acesso] = await auditoria(recente);
  assert.equal(acesso.admin_usuario_id, adminA);
  assert.deepEqual(acesso.detalhes, { tipoAlvo: 'mensagem', alvoId: '1', campoAlvo: null, snapshot: true, arquivo: false });

  const arquivo = t.mock.method(EvidenciaService.prototype, 'acessar', async (id, ref) => {
    assert.equal(id, arquivoId);
    assert.equal(ref, 'cloudinary:assetTeste');
    return { disponivel: true, url: 'https://example.test/temporario', expiraEm: new Date() };
  });
  assert.equal((await get('/' + arquivoId, usuario)).status, 403);
  assert.equal(arquivo.mock.callCount(), 0);
  const detalheArquivo = await (await get('/' + arquivoId)).json();
  assert.equal(detalheArquivo.evidencia.arquivo.url, 'https://example.test/temporario');
  assert.equal((await auditoria(arquivoId))[0].detalhes.arquivo, true);
  assert.doesNotMatch(JSON.stringify(await auditoria(arquivoId)), /temporario|assetTeste/);

  assert.equal((await post(recente, 'decisao', adminA, decisao)).status, 409);
  assert.equal((await ler('/mensagens/conversas'))[0].ultimaMensagem, 'Somente a mensagem denunciada');
  assert.equal((await post(randomUUID(), 'assumir', adminA)).status, 404);
  const transacao = db.transaction.bind(db);
  const pids = new Set();
  let barreira;
  let liberar;
  const sincronizar = () => {
    pids.clear();
    barreira = new Promise(resolve => { liberar = resolve; });
  };
  const observar = t.mock.method(db, 'transaction', (isolation, executar) => transacao(isolation, async manager => {
    if (barreira) {
      const [{ pid }] = await manager.query('SELECT pg_backend_pid() AS pid');
      pids.add(pid);
      if (pids.size === 2) liberar();
      await barreira;
    }
    return executar(manager);
  }));
  sincronizar();
  const disputas = await Promise.all([post(recente, 'assumir', adminA), post(recente, 'assumir', adminB)]);
  barreira = undefined;
  assert.deepEqual(disputas.map(response => response.status).sort(), [200, 409]);
  assert.equal(pids.size, 2);
  const assumida = await disputas.find(response => response.ok).json();
  assert.equal(assumida.status, 'em_analise');
  assert.equal(assumida.analisadaEm, null);
  const responsavel = assumida.adminUsuarioId;
  const outro = responsavel === adminA ? adminB : adminA;
  assert.equal((await post(recente, 'decisao', outro, decisao)).status, 403);
  assert.equal((await post(recente, 'decisao', responsavel, { procedente: true })).status, 400);
  assert.equal((await post(recente, 'decisao', responsavel, { ...decisao, sancao: {} })).status, 400);
  sincronizar();
  const concorrentes = await Promise.all([
    post(recente, 'decisao', responsavel, decisao), post(recente, 'decisao', responsavel, decisao),
  ]);
  assert.deepEqual(concorrentes.map(response => response.status).sort(), [200, 409]);
  assert.equal(pids.size, 2);
  observar.mock.restore();
  assert.equal((await concorrentes.find(response => response.ok).json()).status, 'resolvida');
  assert.equal((await post(recente, 'decisao', responsavel, { ...decisao, procedente: false })).status, 409);
  const final = await (await get('/' + recente)).json();
  assert.equal(final.status, 'resolvida');
  assert.equal(final.justificativaDecisao, 'Violação confirmada.');
  assert.equal(final.adminResponsavel.id, responsavel);
  assert.ok(final.analisadaEm);
  const eventos = await auditoria(recente);
  assert.deepEqual(eventos.map(row => row.acao), ['acesso_evidencia', 'analise_denuncia', 'decisao_denuncia', 'remocao_conteudo', 'acesso_evidencia']);
  assert.equal(eventos[2].detalhes.justificativa, 'Violação confirmada.');
  assert.equal(eventos[3].detalhes.operacao, 'ocultacao');
  assert.deepEqual(final.evidencia.snapshot, inicial.evidencia.snapshot);
  const [previa] = await ler('/mensagens/conversas');
  assert.equal(previa.ultimaMensagem, 'Mensagem anterior');
  assert.equal(previa.naoLidas, 1);
  assert.deepEqual((await ler('/mensagens/' + usuarioInvestidor)).map(m => m.id), ['3', '2']);
  assert.deepEqual((await db.query('SELECT conteudo,lido_em,ocultada_por_moderacao FROM mensagens WHERE id=1'))[0],
    { conteudo: 'Somente a mensagem denunciada', lido_em: null, ocultada_por_moderacao: true });
  assert.equal((await post(anterior, 'assumir', adminB)).status, 200);
  assert.equal((await post(anterior, 'decisao', adminB, { procedente: false, justificativa: 'Sem violação.' })).status, 200);
  assert.equal((await estado(anterior)).status, 'rejeitada');
  assert.equal((await db.query('SELECT ocultada_por_moderacao FROM mensagens WHERE id=2'))[0].ocultada_por_moderacao, false);

  const caminhoAvaliacao = '/avaliacoes/conversa/' + conversaId;
  assert.equal((await ler(caminhoAvaliacao)).avaliacao.comentario, 'Comentário denunciado');
  assert.equal((await post(avaliacaoId, 'assumir', adminA)).status, 200);
  assert.equal((await post(avaliacaoId, 'decisao', adminA, decisao)).status, 200);
  const { avaliacao } = await ler(caminhoAvaliacao);
  assert.equal(avaliacao.nota, 4);
  assert.equal(avaliacao.comentario, null);
  const editada = await ler(caminhoAvaliacao, 'startup', { method: 'PUT', body: { nota: 5, comentario: 'Reexposição' } });
  assert.equal(editada.avaliacao.nota, 5);
  assert.equal(editada.avaliacao.comentario, null);
  assert.equal((await db.query('SELECT comentario FROM avaliacoes WHERE id=4'))[0].comentario, 'Comentário denunciado');

  const perfil = await seed('startup', '2026-11-22', undefined, startupId, 'descricaoCurta');
  const duplicata = await seed('startup', '2026-11-22', undefined, startupId, 'descricaoCurta', usuarioInvestidor);
  const semCampo = await seed('startup', '2026-11-22', undefined, startupId);
  assert.equal((await ler('/startups/discovery?q=abacaxi', 'investidor')).total, 1);
  for (const id of [perfil, duplicata, semCampo]) {
    assert.equal((await post(id, 'assumir', adminA)).status, 200);
    assert.equal((await post(id, 'decisao', adminA, decisao)).status, 200);
  }
  assert.equal((await db.query('SELECT count(*)::int AS total FROM campos_perfil_ocultados'))[0].total, 1);
  assert.equal((await auditoria(perfil)).filter(row => row.acao === 'remocao_conteudo').length, 1);
  assert.equal((await auditoria(duplicata)).filter(row => row.acao === 'remocao_conteudo').length, 0);
  assert.equal((await ler('/startups/' + startupId)).descricaoCurta, null);
  assert.equal((await ler('/startups'))[0].descricaoCurta, null);
  assert.equal((await ler('/startups/discovery?sort=name', 'investidor')).items[0].descricaoCurta, null);
  assert.equal((await ler('/startups/discovery?q=abacaxi', 'investidor')).total, 0);
  const descoberta = await ouvir(t, express().use(discoveryRoutes));
  for (const [filtroDescoberta, total] of [['sort=name', 1], ['q=abacaxi', 0]]) {
    const response = await descoberta('/discovery?' + filtroDescoberta, {
      prefix: '', authorization: token(usuario, 'startup'),
    });
    assert.equal(response.status, 200);
    const resultado = await response.json();
    assert.equal(resultado.total, total);
    if (total) assert.equal(resultado.items[0].descricaoCurta, null);
  }
  assert.equal((await ler('/auth/profile')).descricaoCurta, null);
  assert.equal((await db.query('SELECT descricao_curta FROM startups WHERE id=$1', [startupId]))[0].descricao_curta, 'abacaxi confidencial');
  assert.equal((await ler('/startups/' + startupId, 'startup', { method: 'PATCH', body: { descricaoCurta: 'texto editado' } })).descricaoCurta, null);
  assert.equal((await ler('/startups/' + startupId)).nomeFantasia, 'Nome visível');

  const perfilInvestidor = await seed('investidor', '2026-11-22', undefined, investidorId, 'nome');
  assert.equal((await post(perfilInvestidor, 'assumir', adminA)).status, 200);
  assert.equal((await post(perfilInvestidor, 'decisao', adminA, decisao)).status, 200);
  assert.equal((await ler('/investidores/' + investidorId)).nome, null);
  assert.equal((await ler('/auth/profile', 'investidor')).nome, null);
  assert.equal((await ler('/auth/me', 'investidor')).nome, null);
  assert.equal((await ler('/mensagens/conversas'))[0].nome, null);
  assert.equal((await ler('/startups/interessados')).items[0].nome, null);
  assert.equal((await ler(caminhoAvaliacao)).nome, null);
  await db.query(`INSERT INTO reunioes(id,startup_id,investidor_id,status,data_hora_agendada)
    VALUES (1,$1,$2,'realizada',now())`, [startupId, investidorId]);
  assert.equal((await ler('/reunioes'))[0].investidorNome, null);

  const logo = await seed('startup', '2026-11-22', undefined, startupId, 'logoUrl');
  await db.query("UPDATE startups SET logo_url='https://example.test/logo.png' WHERE id=$1", [startupId]);
  assert.equal((await post(logo, 'assumir', adminA)).status, 200);
  assert.equal((await post(logo, 'decisao', adminA, decisao)).status, 200);
  assert.equal((await ler('/startups/interesses', 'investidor'))[0].logoUrl, null);
  assert.equal((await ler('/startups/' + startupId + '/interesse', 'investidor', { method: 'POST' })).logoUrl, null);
  assert.equal((await ler('/mensagens/conversas', 'investidor'))[0].logoUrl, null);

  const ausente = await seed('mensagem', '2026-11-22', undefined, '999');
  assert.equal((await post(ausente, 'assumir', adminA)).status, 200);
  assert.equal((await post(ausente, 'decisao', adminA, decisao)).status, 409);
  assert.deepEqual(await estado(ausente), { status: 'em_analise', admin_usuario_id: adminA, analisada_em: null });
  assert.deepEqual((await auditoria(ausente)).map(row => row.acao), ['analise_denuncia']);

  t.mock.method(console, 'error', () => {});
  // A restrição força falha depois de a mensagem ser marcada como ocultada.
  const falhaNaOcultacao = await seed('mensagem', '2026-11-22', undefined, '3', null, usuarioInvestidor);
  await db.query(`ALTER TABLE log_auditoria ADD CONSTRAINT teste_falha_registro_ocultacao
    CHECK (NOT (entidade_id='${falhaNaOcultacao}' AND acao='remocao_conteudo'))`);
  assert.equal((await post(falhaNaOcultacao, 'assumir', adminA)).status, 200);
  assert.equal((await post(falhaNaOcultacao, 'decisao', adminA, decisao)).status, 500);
  assert.equal((await db.query('SELECT ocultada_por_moderacao FROM mensagens WHERE id=3'))[0].ocultada_por_moderacao, false);
  assert.equal((await estado(falhaNaOcultacao)).status, 'em_analise');
  assert.deepEqual((await auditoria(falhaNaOcultacao)).map(row => row.acao), ['analise_denuncia']);
  assert.equal((await post(rollbackAssumir, 'assumir', adminA)).status, 500);
  assert.deepEqual(await estado(rollbackAssumir), { status: 'pendente', admin_usuario_id: null, analisada_em: null });
  assert.deepEqual(await auditoria(rollbackAssumir), []);
  assert.equal((await post(rollbackDecisao, 'assumir', adminA)).status, 200);
  assert.equal((await post(rollbackDecisao, 'decisao', adminA, decisao)).status, 500);
  assert.deepEqual(await estado(rollbackDecisao), { status: 'em_analise', admin_usuario_id: adminA, analisada_em: null });
  assert.deepEqual((await auditoria(rollbackDecisao)).map(row => row.acao), ['analise_denuncia']);
  const acessoRecusado = await get('/' + rollbackAcesso);
  assert.equal(acessoRecusado.status, 500);
  assert.deepEqual(Object.keys(await acessoRecusado.json()), ['message']);
  assert.deepEqual(await auditoria(rollbackAcesso), []);

  await t.test('aplicação explícita e bloqueios por vigência, com revogação concorrente', async () => {
    const fimEm = new Date(Date.now() + 3600000).toISOString();
    const advertencia = { tipo: 'advertencia', justificativa: 'Advertência de teste.' };
    const chat = { tipo: 'restricao_chat', justificativa: 'Restrição de teste.', fimEm };
    const enviar = role => comoUsuario('/mensagens', role, {
      method: 'POST', body: { destinatarioId: role === 'investidor' ? usuario : usuarioInvestidor, conteudo: 'Nova mensagem' },
    });
    const revogar = (id, admin, payload = { justificativa: 'Motivo da revogação.' }) => http(
      '/admin/sancoes/' + id + '/revogacao',
      { prefix: '', authorization: token(admin, 'admin'), method: 'POST', body: payload },
    );
    const preparar = async (role = 'startup') => {
      const investidor = role === 'investidor';
      const id = await seed(role, '2026-11-22', undefined,
        investidor ? investidorId : startupId, null, investidor ? usuario : usuarioInvestidor);
      await db.query('UPDATE denuncias SET denunciado_usuario_id=$2 WHERE id=$1', [id, investidor ? usuarioInvestidor : usuario]);
      assert.equal((await post(id, 'assumir', adminA)).status, 200);
      return id;
    };
    const decidirCom = (id, sancao) => post(id, 'decisao', adminA, { ...decisao, sancao });
    const aplicada = async (id, dados) => {
      const response = await decidirCom(id, dados);
      const resultado = await response.json();
      assert.equal(response.status, 200, JSON.stringify(resultado));
      assert.equal(resultado.sancao.tipo, dados.tipo);
      return resultado.sancao;
    };

    const aviso = await preparar();
    assert.equal((await post(aviso, 'decisao', usuario, { ...decisao, sancao: advertencia })).status, 403);
    assert.equal((await post(aviso, 'decisao', adminA, { ...decisao, procedente: false, sancao: advertencia })).status, 400);
    assert.equal((await decidirCom(aviso, { tipo: 'advertencia' })).status, 400);
    assert.equal((await decidirCom(aviso, { ...chat, fimEm: undefined })).status, 400);
    assert.equal((await decidirCom(aviso, { ...chat, fimEm: '2027-02-30T12:00:00Z' })).status, 400);
    assert.equal((await decidirCom(aviso, { ...chat, fimEm: '2020-01-01T00:00:00Z' })).status, 400);
    assert.equal((await decidirCom(aviso, { ...chat, tipo: 'banimento' })).status, 400);
    assert.equal((await decidirCom(aviso, { ...advertencia, usuarioId: usuarioInvestidor })).status, 400);
    await db.query('UPDATE denuncias SET denunciado_usuario_id=NULL WHERE id=$1', [aviso]);
    assert.equal((await decidirCom(aviso, advertencia)).status, 409);
    await db.query('UPDATE denuncias SET denunciado_usuario_id=$2 WHERE id=$1', [aviso, usuario]);
    assert.equal((await estado(aviso)).status, 'em_analise');
    assert.equal((await db.query('SELECT id FROM sancoes WHERE denuncia_id=$1', [aviso])).length, 0);
    const avisoSalvo = await aplicada(aviso, advertencia);
    assert.equal((await enviar('startup')).status, 201);
    const minhas = await ler('/minhas-sancoes');
    assert.deepEqual(minhas.items.map(item => item.id), [avisoSalvo.id]);
    assert.deepEqual(Object.keys(minhas.items[0]).sort(), ['fimEm', 'id', 'inicioEm', 'tipo']);
    assert.deepEqual((await ler('/minhas-sancoes', 'investidor')).items, []);
    assert.equal((await http('/minhas-sancoes', { prefix: '' })).status, 401);
    const avisoAdmin = await (await get('/' + aviso)).json();
    assert.equal(avisoAdmin.sancoes[0].motivo, advertencia.justificativa);
    assert.ok(avisoAdmin.historico.some(evento => evento.acao === 'aplicacao_sancao'));

    const restricao = await preparar();
    const concorrencia = await Promise.all([decidirCom(restricao, chat), decidirCom(restricao, chat)]);
    assert.deepEqual(concorrencia.map(res => res.status).sort(), [200, 409]);
    const { sancao: chatSalvo } = await concorrencia.find(res => res.ok).json();
    assert.equal((await db.query('SELECT id FROM sancoes WHERE denuncia_id=$1', [restricao])).length, 1);
    const bloqueado = await enviar('startup');
    assert.equal(bloqueado.status, 403);
    assert.match((await bloqueado.json()).message, /envio de mensagens/i);
    assert.ok(!(await ler('/mensagens/' + usuarioInvestidor)).some(m => m.id === '1'));
    assert.equal((await ler('/mensagens/conversas')).length, 1);
    assert.equal((await enviar('investidor')).status, 201);
    await db.query(`UPDATE sancoes SET inicio_em=now()+interval '1 hour',fim_em=now()+interval '2 hours' WHERE id=$1`, [chatSalvo.id]);
    assert.equal((await enviar('startup')).status, 201);
    await db.query(`UPDATE sancoes SET inicio_em=now()-interval '2 hours',fim_em=now()-interval '1 hour' WHERE id=$1`, [chatSalvo.id]);
    assert.equal((await enviar('startup')).status, 201);

    const suspensao = await preparar();
    const suspensaoSalva = await aplicada(suspensao, { ...chat, tipo: 'suspensao' });
    for (const [path, method, body] of [
      ['/auth/profile', 'GET'], ['/mensagens/conversas', 'GET'],
      ['/mensagens', 'POST', { destinatarioId: usuarioInvestidor, conteudo: 'Bloqueada' }],
      ['/startups/' + startupId, 'PATCH', { descricaoCurta: 'Bloqueada' }],
      [caminhoAvaliacao, 'PUT', { nota: 4 }], ['/uploads/startup/logo', 'POST', {}],
      ['/startups/interessados', 'GET'], ['/reunioes', 'POST', {}], ['/denuncias', 'POST', {}],
    ]) {
      const response = await comoUsuario(path, 'startup', { method, body });
      assert.equal(response.status, 403, path);
      assert.match((await response.json()).message, /suspensa/i, path);
    }
    assert.equal((await ler('/minhas-sancoes')).items[0].tipo, 'suspensao');
    await db.query(`UPDATE sancoes SET inicio_em=now()-interval '2 hours',fim_em=now()-interval '1 hour' WHERE id=$1`, [suspensaoSalva.id]);
    assert.equal((await comoUsuario('/auth/profile')).status, 200);
    await db.query('UPDATE sancoes SET fim_em=$2 WHERE id=$1', [suspensaoSalva.id, fimEm]);
    assert.equal((await revogar(suspensaoSalva.id, usuario)).status, 403);
    assert.equal((await revogar(suspensaoSalva.id, adminA, { justificativa: ' ' })).status, 400);
    assert.equal((await revogar(randomUUID(), adminA)).status, 404);
    const revogacoes = await Promise.all([revogar(suspensaoSalva.id, adminA), revogar(suspensaoSalva.id, adminB)]);
    assert.deepEqual(revogacoes.map(res => res.status).sort(), [200, 409]);
    assert.equal((await enviar('startup')).status, 201);
    assert.equal((await ler('/minhas-sancoes')).items.some(item => item.id === suspensaoSalva.id), false);
    const { sancoes, historico } = await (await get('/' + suspensao)).json();
    assert.ok(sancoes[0].revogadaEm);
    assert.ok([adminA, adminB].includes(sancoes[0].revogadaPorUsuarioId));
    assert.equal(historico.filter(evento => evento.acao === 'revogacao_sancao').length, 1);

    const banimento = await preparar('investidor');
    const banimentoSalvo = await aplicada(banimento, { ...advertencia, tipo: 'banimento' });
    assert.equal(banimentoSalvo.fimEm, null);
    for (const [path, method] of [
      ['/mensagens/conversas', 'GET'], ['/startups/recomendacoes', 'GET'],
      ['/startups/' + startupId + '/interesse', 'POST'], ['/startups/exposicoes', 'POST'],
      ['/uploads/investidor/avatar', 'POST'],
    ]) {
      const response = await comoUsuario(path, 'investidor', { method });
      assert.equal(response.status, 403, path);
      assert.match((await response.json()).message, /banida/i, path);
    }
    assert.equal((await ler('/minhas-sancoes', 'investidor')).items[0].tipo, 'banimento');
    await db.query(`ALTER TABLE log_auditoria ADD CONSTRAINT teste_falha_revogacao
      CHECK (NOT (entidade_id='${banimentoSalvo.id}' AND admin_usuario_id='${adminA}' AND acao='revogacao_sancao'))`);
    assert.equal((await revogar(banimentoSalvo.id, adminA)).status, 500);
    assert.equal((await enviar('investidor')).status, 403);
    assert.equal((await revogar(banimentoSalvo.id, adminB)).status, 200);
    assert.equal((await enviar('investidor')).status, 201);
    assert.equal((await db.query('SELECT ativo FROM usuarios WHERE id=$1', [usuarioInvestidor]))[0].ativo, true);
    const preservada = await (await get('/' + recente)).json();
    assert.deepEqual(preservada.evidencia.snapshot, inicial.evidencia.snapshot);
    assert.equal((await db.query('SELECT ocultada_por_moderacao FROM mensagens WHERE id=1'))[0].ocultada_por_moderacao, true);
  });

  await t.test('falhas na sanção e na sua auditoria revertem decisão, ocultação e registros', async () => {
    const advertencia = { tipo: 'advertencia', justificativa: 'Sanção que deve ser revertida.' };
    for (const [alvo, tabela, nome, verificacao] of [
      ['2', 'sancoes', 'teste_falha_insercao', id => `denuncia_id IS DISTINCT FROM '${id}'::uuid`],
      ['3', 'log_auditoria', 'teste_falha_aplicacao',
        id => `NOT (acao='aplicacao_sancao' AND detalhes->>'denunciaId'='${id}')`],
    ]) {
      const id = await seed('mensagem', '2026-11-22', undefined, alvo, null, adminB);
      await db.query(`ALTER TABLE ${tabela} ADD CONSTRAINT ${nome} CHECK (${verificacao(id)})`);
      assert.equal((await post(id, 'assumir', adminA)).status, 200);
      const response = await post(id, 'decisao', adminA, { ...decisao, sancao: advertencia });
      assert.equal(response.status, 500);
      assert.deepEqual(await estado(id), { status: 'em_analise', admin_usuario_id: adminA, analisada_em: null });
      assert.equal((await db.query('SELECT ocultada_por_moderacao FROM mensagens WHERE id=$1', [alvo]))[0].ocultada_por_moderacao, false);
      assert.equal((await db.query('SELECT id FROM sancoes WHERE denuncia_id=$1', [id])).length, 0);
      assert.deepEqual((await auditoria(id)).map(row => row.acao), ['analise_denuncia']);
    }
  });
});
