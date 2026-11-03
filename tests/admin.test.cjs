require("ts-node/register/transpile-only");
require("tsconfig-paths/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { AppDataSource: db } = require("../src/shared/database/data-source");
const { Usuario } = require("../src/modules/usuarios/entities/Usuario");
const { Startup } = require("../src/modules/startups/entities/Startup");
const {
  Investidor,
} = require("../src/modules/investidores/entities/Investidor");
const {
  LogAuditoria,
} = require("../src/modules/auditoria/entities/LogAuditoria");
const { authConfig } = require("../src/shared/config/auth");
const {
  validateDecision,
} = require("../src/modules/admin/routes/admin.routes");
test("decisões aceitam apenas aprovação e rejeição com motivo", () => {
  assert.throws(() => validateDecision({ status: "admin" }));
  assert.throws(() => validateDecision({ status: "rejeitado", motivo: " " }));
  assert.throws(() =>
    validateDecision({ status: "rejeitado", motivo: "a".repeat(2001) }),
  );
  assert.deepEqual(
    validateDecision({ status: "rejeitado", motivo: " Teste " }),
    { status: "rejeitado", motivo: "Teste" },
  );
});
test(
  "admin local: RBAC, decisões concorrentes, edição e auditoria atômica",
  { skip: process.env.ADMIN_DB_TEST !== "1", timeout: 180000 },
  async () => {
    process.env.NODE_ENV = "production";
    assert.equal(db.options.synchronize, false);
    assert.ok(["localhost", "127.0.0.1"].includes(db.options.host));
    await db.initialize();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    let server;
    let fixtureId;
    try {
      const repo = db.getRepository(Usuario);
      for (let n = 0; n < 3; n++)
        await repo.save(
          repo.create({
            id: ids[n],
            nome: "Teste temporário admin",
            email: ids[n] + "@admin-test.invalid",
            senhaHash: "not-a-valid-password-hash",
            tipoPerfil: n === 0 ? "admin" : n === 1 ? "startup" : "investidor",
            avatarUrl:
              n === 2 ? "https://example.com/investor-fixture.png" : undefined,
            ativo: true,
          }),
        );
      const startupRepo = db.getRepository(Startup);
      const sample = (await startupRepo.find({ take: 1 }))[0];
      assert.ok(
        sample,
        "É necessário um perfil local para copiar os campos obrigatórios.",
      );
      fixtureId = randomUUID();
      await startupRepo.save(
        startupRepo.create({
          ...sample,
          id: fixtureId,
          usuario: { id: ids[1] },
          nomeFantasia: "Fixture temporária admin",
          statusModeracao: "pendente",
        }),
      );
      const investorRepo = db.getRepository(Investidor);
      const investor = await investorRepo.save(
        investorRepo.create({
          nome: "Fixture investidor admin",
          usuario: { id: ids[2] },
          tipoInvestidor: "anjo_mentor",
          statusModeracao: "pendente",
        }),
      );
      const { Reuniao } = require("../src/modules/reunioes/entities/Reuniao");
      const meeting = await db.getRepository(Reuniao).save({
        startup: { id: fixtureId },
        investidor: { id: investor.id },
        dataHoraAgendada: new Date("2026-12-01T15:00:00Z"),
        status: "agendada",
        notas: "Fixture temporária admin",
        linkReuniao: "https://example.com/reuniao-teste",
      });
      const app = require("../src/App").default;
      server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const base = "http://127.0.0.1:" + server.address().port;
      const token = (n, role) =>
        jwt.sign({ tipoPerfil: role }, authConfig.secret, {
          subject: ids[n],
          expiresIn: "5m",
        });
      const adminToken = token(0, "admin");
      async function request(path, body, method = "GET", t = adminToken) {
        const res = await fetch(base + "/admin/" + path, {
          method,
          headers: {
            Authorization: "Bearer " + t,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, data: await res.json() };
      }
      assert.equal(
        (await request("metricas", null, "GET", token(1, "startup"))).status,
        403,
      );
      assert.equal(
        (await request("metricas", null, "GET", token(1, "admin"))).status,
        403,
        "Uma alegação admin no JWT não substitui a permissão no banco.",
      );
      await repo.update(ids[0], { ativo: false });
      assert.equal((await request("metricas")).status, 403);
      await repo.update(ids[0], { ativo: true });
      const discovery = async () => {
        const response = await fetch(base + "/startups", {
          headers: { Authorization: "Bearer " + token(2, "investidor") },
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      assert.ok(
        !(await discovery()).some((row) => row.id === fixtureId),
        "Pendentes não aparecem em Explorar",
      );
      await startupRepo.update(fixtureId, { statusModeracao: "aprovado" });
      assert.ok(
        (await discovery()).some((row) => row.id === fixtureId),
        "Aprovadas aparecem em Explorar",
      );
      await repo.update(ids[1], { ativo: false });
      assert.ok(
        !(await discovery()).some((row) => row.id === fixtureId),
        "Conta inativa não aparece em Explorar",
      );
      await repo.update(ids[1], { ativo: true });
      for (const status of ["rejeitado", "suspenso"]) {
        await startupRepo.update(fixtureId, { statusModeracao: status });
        assert.ok(!(await discovery()).some((row) => row.id === fixtureId));
      }
      await startupRepo.update(fixtureId, { statusModeracao: "pendente" });
      async function api(path, n, role, body) {
        const response = await fetch(base + path, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer " + token(n, role),
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, data: await response.json() };
      }
      const interestPath = "/startups/" + fixtureId + "/interesse";
      assert.equal((await api(interestPath, 2, "investidor", {})).status, 403);
      await investorRepo.update(investor.id, { statusModeracao: "aprovado" });
      assert.equal((await api(interestPath, 2, "investidor", {})).status, 404);
      await startupRepo.update(fixtureId, { statusModeracao: "aprovado" });
      assert.equal(
        (
          await api("/mensagens", 2, "investidor", {
            destinatarioId: ids[1],
            conteudo: "Sem interesse",
          })
        ).status,
        403,
      );
      assert.equal((await api(interestPath, 1, "startup", {})).status, 403);
      const interests = await Promise.all([
        api(interestPath, 2, "investidor", {}),
        api(interestPath, 2, "investidor", {}),
      ]);
      assert.deepEqual(
        interests.map((r) => r.status),
        [200, 200],
      );
      assert.equal(interests[0].data.usuarioId, ids[1]);
      const events = await db.query(
        "SELECT count(*)::int AS total FROM funil_interacoes WHERE startup_id=$1 AND investidor_id=$2 AND tipo_evento='interesse_demonstrado'",
        [fixtureId, investor.id],
      );
      assert.equal(events[0].total, 1);
      const registered = await api("/startups/interesses", 2, "investidor");
      assert.equal(registered.data.length, 1);
      assert.equal(registered.data[0].startupId, fixtureId);
      const first = await api("/mensagens", 2, "investidor", {
        destinatarioId: ids[1],
        conteudo: "Primeiro contato de teste",
      });
      assert.equal(first.status, 201);
      const inbox = await api("/mensagens/conversas", 1, "startup");
      assert.equal(inbox.data.length, 1);
      assert.equal(inbox.data[0].usuarioId, ids[2]);
      assert.equal(inbox.data[0].naoLidas, 1);
      assert.equal(
        inbox.data[0].avatarUrl,
        "https://example.com/investor-fixture.png",
      );
      assert.equal(inbox.data[0].logoUrl, null);
      const investorInbox = await api("/mensagens/conversas", 2, "investidor");
      assert.equal(investorInbox.data[0].logoUrl, sample.logoUrl ?? null);
      assert.equal(investorInbox.data[0].avatarUrl, null);
      assert.equal(
        (await api("/mensagens/" + ids[2], 1, "startup")).data.length,
        1,
      );
      assert.equal(
        (
          await api("/mensagens", 1, "startup", {
            destinatarioId: ids[2],
            conteudo: "Resposta da startup de teste",
          })
        ).status,
        201,
      );
      const history = await api("/mensagens/" + ids[1], 2, "investidor");
      assert.equal(history.data.length, 2);
      assert.equal(history.data[1].conteudo, "Resposta da startup de teste");
      await startupRepo.update(fixtureId, { statusModeracao: "suspenso" });
      assert.equal(
        (
          await api("/mensagens", 2, "investidor", {
            destinatarioId: ids[1],
            conteudo: "Bloqueado",
          })
        ).status,
        403,
      );
      await startupRepo.update(fixtureId, { statusModeracao: "pendente" });
      await investorRepo.update(investor.id, { statusModeracao: "pendente" });
      const metric = await request("metricas");
      assert.equal(metric.status, 200);
      assert.equal(typeof metric.data.usuarios, "number");
      const list = await request("cadastros?q=Fixture");
      assert.equal(list.status, 200);
      assert.ok(list.data.items.some((row) => row.id === fixtureId));
      const mentors = await request("cadastros?grupo=investidores&tipo=mentor");
      assert.equal(mentors.status, 200);
      assert.ok(mentors.data.items.some((row) => row.id === investor.id));
      const meetings = await request("reunioes?q=Fixture&status=agendada");
      assert.equal(meetings.status, 200);
      assert.ok(meetings.data.items.some((row) => row.id === meeting.id));
      const page1 = await request("cadastros?size=1&page=1");
      const page2 = await request("cadastros?size=1&page=2");
      assert.equal(page1.data.items.length, 1);
      assert.notEqual(page1.data.items[0].id, page2.data.items[0].id);
      const detail = await request("cadastros/startup/" + fixtureId);
      assert.equal(detail.status, 200);
      assert.ok(!JSON.stringify(detail.data).includes("senhaHash"));
      assert.equal(
        (
          await request(
            "cadastros/startup/" + fixtureId + "/decisao",
            { status: "rejeitado", motivo: " " },
            "POST",
          )
        ).status,
        400,
      );
      const results = await Promise.all([
        request(
          "cadastros/startup/" + fixtureId + "/decisao",
          { status: "aprovado" },
          "POST",
        ),
        request(
          "cadastros/startup/" + fixtureId + "/decisao",
          { status: "rejeitado", motivo: "Teste de concorrência" },
          "POST",
        ),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      let audit = await db
        .getRepository(LogAuditoria)
        .find({ where: { entidadeId: fixtureId } });
      assert.equal(audit.length, 1);
      assert.equal(audit[0].detalhes.statusAnterior, "pendente");
      const edited = await request(
        "startups/" + fixtureId,
        { descricaoCurta: "Edição administrativa de teste" },
        "PATCH",
      );
      assert.equal(edited.status, 200);
      assert.equal(
        (await startupRepo.findOneBy({ id: fixtureId })).descricaoCurta,
        "Edição administrativa de teste",
      );
      assert.equal(
        (
          await request(
            "startups/" + fixtureId,
            { statusModeracao: "aprovado" },
            "PATCH",
          )
        ).status,
        400,
      );
      assert.equal(
        (await request("usuarios/" + ids[1], { tipoPerfil: "admin" }, "PATCH"))
          .status,
        400,
      );
      const logs = await request("auditoria?q=" + fixtureId);
      assert.equal(logs.status, 200);
      assert.equal(logs.data.total, 2);
      assert.equal(logs.data.items[0].ator, "Teste temporário admin");
      assert.equal((await request("cadastros?grupo=investidores")).status, 200);
      assert.equal(
        (await request("auditoria?de=2026-10-01&ate=2026-10-31")).status,
        200,
      );
      // A failing audit insert must roll back both the status and any edit.
      await startupRepo.update(fixtureId, { statusModeracao: "pendente" });
      const getRepo = db.getRepository.bind(db);
      const originalTransaction = db.transaction.bind(db);
      db.transaction = (work) =>
        originalTransaction(async (manager) => {
          const original = manager.getRepository.bind(manager);
          manager.getRepository = (entity) =>
            entity === LogAuditoria
              ? {
                  save: async () => {
                    throw Error("Falha de auditoria simulada");
                  },
                }
              : original(entity);
          return work(manager);
        });
      try {
        assert.equal(
          (
            await request(
              "cadastros/startup/" + fixtureId + "/decisao",
              { status: "aprovado" },
              "POST",
            )
          ).status,
          500,
        );
        assert.equal(
          (await getRepo(Startup).findOneBy({ id: fixtureId })).statusModeracao,
          "pendente",
        );
      } finally {
        db.transaction = originalTransaction;
      }
      const rejection = await request(
        "cadastros/startup/" + fixtureId + "/decisao",
        { status: "rejeitado", motivo: "Rejeição temporária de teste" },
        "POST",
      );
      assert.equal(rejection.status, 200);
      audit = await db
        .getRepository(LogAuditoria)
        .find({ where: { entidadeId: fixtureId } });
      assert.equal(audit.length, 3);
      console.log(
        "Verificados RBAC, concorrência, rollback, edição, rejeição e auditoria; fixtures removidas no finally.",
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (db.isInitialized) {
        await db.query("DELETE FROM log_auditoria WHERE admin_usuario_id=$1", [
          ids[0],
        ]);
        await db.query(
          "DELETE FROM mensagens WHERE remetente_usuario_id = ANY($1::uuid[])",
          [ids],
        );
        for (const id of ids) await db.getRepository(Usuario).delete(id);
        await db.destroy();
      }
    }
  },
);
