require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { v2: cloudinary } = require('cloudinary');
const app = require('../src/App').default;
const { AppDataSource: db } = require('../src/shared/database/data-source');
const { authConfig } = require('../src/shared/config/auth');
const { AlvoDenunciaService, validarAlvo } = require('../src/modules/moderacao/services/AlvoDenunciaService');
const { EvidenciaService } = require('../src/modules/moderacao/services/EvidenciaService');
const { DenunciaService } = require('../src/modules/moderacao/services/DenunciaService');
const { ModeracaoIa1794873600000 } = require('../src/shared/database/migrations/1794873600000-ModeracaoIa');
const { EvidenciaDenuncia1794873600001 } = require('../src/shared/database/migrations/1794873600001-EvidenciaDenuncia');

const mensagem = { tipoAlvo: 'mensagem', alvoId: '9223372036854775807', motivo: 'Abuso' };

test('valida bigint textual, normaliza UUID e aceita somente campos permitidos', () => {
  assert.equal(validarAlvo(mensagem).alvoId, mensagem.alvoId);
  for (const alvoId of [1, '01', '9223372036854775808', '0', '-1'])
    assert.throws(() => validarAlvo({ ...mensagem, alvoId }), { statusCode: 400 });
  const alvoId = randomUUID().toUpperCase();
  assert.deepEqual(validarAlvo({ tipoAlvo: 'startup', alvoId, campoAlvo: 'logoUrl' }), {
    tipoAlvo: 'startup', alvoId: alvoId.toLowerCase(), campoAlvo: 'logoUrl',
  });
  for (const campoAlvo of ['senhaHash', 'constructor', 'avatarUrl'])
    assert.throws(() => validarAlvo({ tipoAlvo: 'startup', alvoId, campoAlvo }), { statusCode: 400 });
  assert.throws(() => validarAlvo({ ...mensagem, campoAlvo: 'conteudo' }), { statusCode: 400 });
});

test('resolução de avaliação usa o autor e o vínculo, mantendo comentário oculto fora do snapshot', async () => {
  const usuario = randomUUID();
  const manager = {
    async query(sql, params) {
      assert.match(sql, /a\.avaliador_usuario_id=\$2 AND \$2 IN \(s\.usuario_id,i\.usuario_id\)/);
      assert.match(sql, /CASE WHEN NOT a\.comentario_ocultado_por_moderacao THEN a\.comentario END/);
      return params[1] === usuario ? [{ denunciadoId: usuario, snapshot: { nota: 4, comentario: null } }] : [];
    },
  };
  const service = new AlvoDenunciaService();
  const alvo = validarAlvo({ tipoAlvo: 'avaliacao', alvoId: '1' });
  assert.equal((await service.buscar(manager, usuario, alvo)).snapshot.nota, 4);
  await assert.rejects(service.buscar(manager, randomUUID(), alvo), { statusCode: 404 });
});

test('rotas de denúncia aplicam autenticação, acesso, cota e projeção privada', async t => {
  const autor = randomUUID();
  const terceiro = randomUUID();
  const denunciado = randomUUID();
  const criadas = [];
  const criadaEm = new Date();
  let total = 0;
  let aceitarDuplicada = false;
  t.mock.method(db, 'transaction', async (isolation, executar) => {
    assert.equal(isolation, 'READ COMMITTED');
    let bloqueada = false;
    return executar({
      async query(sql, params) {
        if (sql.includes('SELECT ativo')) return [{ ativo: true }];
        if (sql.includes('pg_advisory_xact_lock')) {
          bloqueada = true;
          return [];
        }
        assert.ok(bloqueada);
        if (sql.includes('SELECT 1 FROM denuncias'))
          return !aceitarDuplicada && criadas.some(row => row.denuncianteUsuario.id === params[0] &&
            row.alvoId === params[2]) ? [{}] : [];
        if (sql.includes('count(*)')) return [{ total }];
        assert.match(sql, /\$2 IN \(s\.usuario_id,i\.usuario_id\)/);
        assert.match(sql, /NOT m\.ocultada_por_moderacao/);
        return params[1] === autor && params[0] === mensagem.alvoId
          ? [{ denunciadoId: denunciado, snapshot: { conteudo: 'Texto privado' } }] : [];
      },
      getRepository() {
        return {
          async save(row) {
            if (aceitarDuplicada) throw { code: '23505', constraint: 'denuncias_abertas_unicas' };
            criadas.push(row);
            return { ...row, criadaEm };
          },
        };
      },
    });
  });
  t.mock.method(db, 'query', async (sql, params) => {
    if (sql.includes('FROM sancoes')) return [];
    if (sql.includes('SELECT ativo')) return [{ ativo: true }];
    assert.match(sql, /WHERE denunciante_usuario_id=\$1/);
    assert.doesNotMatch(sql, /evidencia|denunciado|descricao|admin/);
    assert.deepEqual(params.slice(1), [2, 0]);
    return params[0] === autor ? [{
      id: criadas[0].id, tipoAlvo: 'mensagem', alvoId: mensagem.alvoId, campoAlvo: null,
      motivo: mensagem.motivo, status: 'pendente', criadaEm, analisadaEm: null,
    }] : [];
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = id => `Bearer ${jwt.sign({ tipoPerfil: 'startup' }, authConfig.secret, { subject: id })}`;
  const post = (usuario, body) => fetch(base + '/denuncias', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(usuario && { authorization: token(usuario) }) },
    body: JSON.stringify(body),
  });
  const get = usuario => fetch(base + '/minhas-denuncias?size=1', {
    headers: usuario ? { authorization: token(usuario) } : {},
  });

  assert.equal((await post(null, mensagem)).status, 401);
  assert.equal((await get(null)).status, 401);
  assert.equal((await post(terceiro, mensagem)).status, 404);
  assert.equal((await post(autor, { ...mensagem, alvoId: '123' })).status, 404);
  assert.equal((await post(autor, { ...mensagem, denunciadoId: terceiro })).status, 400);
  const response = await post(autor, { ...mensagem, descricao: 'Descrição privada' });
  assert.equal(response.status, 201);
  const publica = await response.json();
  assert.equal(publica.status, 'pendente');
  assert.deepEqual(criadas[0].evidenciaSnapshot, { conteudo: 'Texto privado' });
  assert.equal(criadas[0].denunciadoUsuario.id, denunciado);
  assert.equal((await post(autor, mensagem)).status, 409);
  aceitarDuplicada = true;
  assert.equal((await post(autor, mensagem)).status, 409);
  total = 10;
  assert.equal((await post(autor, mensagem)).status, 429);
  const minhas = await get(autor);
  assert.equal(minhas.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await minhas.json(), { items: [publica], page: 1, size: 1, hasMore: false });
  assert.deepEqual(await (await get(terceiro)).json(), { items: [], page: 1, size: 1, hasMore: false });
  assert.deepEqual(Object.keys(publica).sort(),
    ['id', 'tipoAlvo', 'alvoId', 'campoAlvo', 'motivo', 'status', 'criadaEm', 'analisadaEm'].sort());
  const contaLimitada = randomUUID();
  for (let i = 0; i < 30; i++)
    assert.equal((await post(contaLimitada, {})).status, 400);
  const bloqueada = await post(contaLimitada, {});
  assert.equal(bloqueada.status, 429);
  assert.ok(Number(bloqueada.headers.get('retry-after')) > 0);
});

test('cópia Cloudinary usa somente o ativo e a versão verificados e exige entrega autenticada', async t => {
  const anterior = process.env.CLOUDINARY_URL;
  t.after(() => {
    if (anterior === undefined) delete process.env.CLOUDINARY_URL;
    else process.env.CLOUDINARY_URL = anterior;
  });
  delete process.env.CLOUDINARY_URL;
  const evidencia = new EvidenciaService();
  const pasta = 'juntai/startups/apresentacao';
  const arquivo = `${pasta}/${randomUUID()}.pdf`;
  const url = `https://res.cloudinary.com/test/raw/upload/v123/${arquivo}`;
  const midia = { tipo: 'raw', pasta, url };
  const id = randomUUID();
  await assert.rejects(evidencia.preservar(id, midia), { statusCode: 503 });
  process.env.CLOUDINARY_URL = 'cloudinary://test:test@test';
  t.mock.method(cloudinary, 'config', () => ({ cloud_name: 'test' }));
  let versaoAtual = url;
  const verificar = t.mock.method(cloudinary.api, 'resource', async (publicId, options) => {
    assert.equal(publicId, arquivo);
    assert.equal(options.resource_type, 'raw');
    return { secure_url: versaoAtual };
  });
  const copiar = t.mock.method(cloudinary.uploader, 'upload', async (origem, options) => {
    assert.equal(origem, url);
    assert.equal(options.type, 'authenticated');
    assert.equal(options.overwrite, false);
    assert.equal(options.public_id, `juntai/moderacao/evidencias/${id}.pdf`);
    return { asset_id: 'copia', type: options.type, public_id: options.public_id };
  });
  await assert.rejects(evidencia.preservar(id, { ...midia, url: 'https://example.org/sample.pdf' }), { statusCode: 422 });
  assert.equal(verificar.mock.callCount(), 0);
  assert.equal(await evidencia.preservar(id, midia), 'cloudinary:copia');
  versaoAtual = url.replace('v123', 'v124');
  await assert.rejects(evidencia.preservar(id, midia), { statusCode: 422 });
  assert.equal(copiar.mock.callCount(), 1);
});

test('PostgreSQL local: migrations, permissões, HTTP, snapshots e concorrência', {
  skip: process.env.MODERACAO_DB_TEST !== '1',
}, async t => {
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(db.options.host));
  const cloudinaryUrl = process.env.CLOUDINARY_URL;
  delete process.env.CLOUDINARY_URL;
  t.after(() => {
    if (cloudinaryUrl !== undefined) process.env.CLOUDINARY_URL = cloudinaryUrl;
  });
  await db.initialize();
  const schema = 'moderacao_test_' + randomUUID().replaceAll('-', '');
  const buscar = db.query.bind(db);
  const transacao = db.transaction.bind(db);
  const pids = new Set();
  const [autor, denunciado, terceiro, startup, investidor, conversa] = Array.from({ length: 6 }, () => randomUUID());
  try {
    // Commit only the generated test schema so independent connections can see the same fixtures.
    await transacao(async manager => {
      await manager.query(`CREATE SCHEMA ${schema}`);
      await manager.query(`SET LOCAL search_path TO ${schema}`);
      await manager.query(`
        CREATE TYPE acao_auditoria_enum AS ENUM ('remocao_conteudo');
        CREATE TABLE log_auditoria (entidade_id uuid);
        CREATE TABLE usuarios (id uuid PRIMARY KEY, ativo boolean NOT NULL DEFAULT true,
          avatar_url text, tipo_perfil text);
        CREATE TABLE startups (id uuid PRIMARY KEY, usuario_id uuid NOT NULL REFERENCES usuarios,
          nome_fantasia text, descricao_curta text, logo_url text, status_moderacao text);
        CREATE TABLE investidores (id uuid PRIMARY KEY, usuario_id uuid NOT NULL REFERENCES usuarios,
          bio text, status_moderacao text);
        CREATE TABLE conversas (id uuid PRIMARY KEY, startup_id uuid NOT NULL REFERENCES startups,
          investidor_id uuid NOT NULL REFERENCES investidores);
        CREATE TABLE reunioes (id bigint PRIMARY KEY, startup_id uuid, investidor_id uuid);
        CREATE TABLE funil_interacoes (startup_id uuid, investidor_id uuid, tipo_evento text);
        CREATE TABLE mensagens (id bigint PRIMARY KEY, conversa_id uuid NOT NULL REFERENCES conversas,
          remetente_usuario_id uuid NOT NULL REFERENCES usuarios, conteudo text NOT NULL,
          enviado_em timestamptz NOT NULL DEFAULT now());
        CREATE TABLE avaliacoes (id bigint PRIMARY KEY, conversa_id uuid, reuniao_id bigint,
          avaliador_usuario_id uuid, nota smallint, comentario text, atualizado_em timestamptz DEFAULT now());
      `);
      await new ModeracaoIa1794873600000().up(manager);
      await new EvidenciaDenuncia1794873600001().up(manager);
      await manager.query('INSERT INTO usuarios(id) VALUES ($1), ($2), ($3)', [autor, denunciado, terceiro]);
      await manager.query(
        'INSERT INTO startups(id,usuario_id,descricao_curta,logo_url) VALUES ($1,$2,$3,$4)',
        [startup, autor, 'Descrição original', 'https://res.cloudinary.com/test/image/upload/logo.png']);
      await manager.query("INSERT INTO investidores(id,usuario_id,bio) VALUES ($1,$2,'Bio original')", [investidor, denunciado]);
      await manager.query('INSERT INTO conversas VALUES ($1,$2,$3)', [conversa, startup, investidor]);
      await manager.query(`INSERT INTO mensagens(id,conversa_id,remetente_usuario_id,conteudo)
        SELECT id,$1,$2,'Versão denunciada' FROM generate_series(1,11) AS id`, [conversa, denunciado]);
      await manager.query(`INSERT INTO avaliacoes(id,conversa_id,avaliador_usuario_id,nota,comentario)
        VALUES (1,$1,$2,4,'Comentário original')`, [conversa, denunciado]);
    });
    t.diagnostic('Schema de teste preservado: ' + schema);
    t.mock.method(db, 'transaction', (isolation, executar) => transacao(isolation, async manager => {
      await manager.query(`SET LOCAL search_path TO ${schema}`);
      const [{ pid }] = await manager.query('SELECT pg_backend_pid() AS pid');
      pids.add(pid);
      return executar(manager);
    }));
    t.mock.method(db, 'query', (sql, params, runner) => {
      if (runner) return buscar(sql, params, runner);
      return transacao(async manager => {
        await manager.query(`SET LOCAL search_path TO ${schema}`);
        return manager.query(sql, params);
      });
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = id => ({
        authorization: 'Bearer ' + jwt.sign({ tipoPerfil: 'startup' }, authConfig.secret, { subject: id }),
        'content-type': 'application/json',
      });
      const post = (id, payload) => fetch(base + '/denuncias', {
        method: 'POST', headers: headers(id), body: JSON.stringify(payload),
      });
      const chat = { ...mensagem, alvoId: '1' };
      assert.equal((await post(terceiro, chat)).status, 404);
      assert.equal((await post(autor, { ...chat, alvoId: '999' })).status, 404);
      pids.clear();
      const service = new DenunciaService();
      const resultados = await Promise.allSettled([service.criar(autor, chat), service.criar(autor, chat)]);
      assert.equal(pids.size, 2);
      const criada = resultados.find(result => result.status === 'fulfilled');
      const recusada = resultados.find(result => result.status === 'rejected');
      assert.ok(criada);
      assert.equal(recusada.reason.statusCode, 409);
      assert.equal((await buscar(`SELECT count(*)::int AS total FROM ${schema}.denuncias`))[0].total, 1);
      await buscar(`UPDATE ${schema}.mensagens SET conteudo='Versão posterior' WHERE id=1`);
      const [persistida] = await buscar(
        `SELECT denunciado_usuario_id, evidencia_snapshot FROM ${schema}.denuncias WHERE id=$1`, [criada.value.id]);
      assert.equal(persistida.denunciado_usuario_id, denunciado);
      assert.equal(persistida.evidencia_snapshot.conteudo, 'Versão denunciada');

      const avaliacao = { tipoAlvo: 'avaliacao', alvoId: '1', motivo: 'Abuso' };
      assert.equal((await post(autor, avaliacao)).status, 404);
      assert.equal((await post(terceiro, avaliacao)).status, 404);
      const avaliacaoCriada = await post(denunciado, avaliacao);
      assert.equal(avaliacaoCriada.status, 201);
      const perfil = { tipoAlvo: 'startup', alvoId: startup, campoAlvo: 'descricaoCurta', motivo: 'Abuso' };
      assert.equal((await post(terceiro, { ...perfil, campoAlvo: 'senhaHash' })).status, 400);
      assert.equal((await post(terceiro, { ...perfil, alvoId: randomUUID() })).status, 404);
      assert.equal((await post(terceiro, { ...perfil, campoAlvo: 'logoUrl' })).status, 503);
      const perfilCriado = await post(terceiro, perfil);
      assert.equal(perfilCriado.status, 201);
      const investidorCriado = await post(terceiro, { ...perfil, tipoAlvo: 'investidor', alvoId: investidor, campoAlvo: 'bio' });
      assert.equal(investidorCriado.status, 201);
      for (const [response, esperado] of [
        [avaliacaoCriada, { nota: 4, comentario: 'Comentário original' }],
        [perfilCriado, { descricaoCurta: 'Descrição original' }],
        [investidorCriado, { bio: 'Bio original' }],
      ]) {
        const { id } = await response.json();
        const [{ evidencia_snapshot }] = await buscar(
          `SELECT evidencia_snapshot FROM ${schema}.denuncias WHERE id=$1`, [id]);
        for (const [campo, valor] of Object.entries(esperado)) assert.equal(evidencia_snapshot[campo], valor);
      }

      const minhas = await fetch(base + '/minhas-denuncias', { headers: headers(autor) });
      assert.equal(minhas.status, 200);
      assert.deepEqual((await minhas.json()).items, [JSON.parse(JSON.stringify(criada.value))]);
      for (let id = 2; id <= 10; id++)
        assert.equal((await post(autor, { ...chat, alvoId: String(id) })).status, 201);
      assert.equal((await post(autor, { ...chat, alvoId: '11' })).status, 429);
      assert.equal((await post(denunciado, { ...chat, alvoId: '11' })).status, 201);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await db.destroy();
  }
});
