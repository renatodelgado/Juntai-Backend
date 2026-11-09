import { Router, Request, Response, NextFunction } from "express";
import { AppDataSource as db } from "@shared/database/data-source";
import { ensureAuthenticated } from "@shared/middlewares/ensureAuthenticated";
import { Usuario } from "@modules/usuarios/entities/Usuario";
import { Startup } from "@modules/startups/entities/Startup";
import { Investidor } from "@modules/investidores/entities/Investidor";
import { LogAuditoria } from "@modules/auditoria/entities/LogAuditoria";
import { AcaoAuditoria, StatusModeracao, TipoPerfil } from "@shared/enums";
import { AppError } from "@shared/errors/AppError";

export const adminRoutes = Router();
export async function ensureAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.user || req.user.tipoPerfil !== TipoPerfil.ADMIN)
      return void res
        .status(403)
        .json({ message: "Acesso restrito à administração." });
    const actor = await db
      .getRepository(Usuario)
      .findOneBy({ id: req.user!.id });
    if (!actor?.ativo || actor.tipoPerfil !== TipoPerfil.ADMIN)
      return void res
        .status(403)
        .json({ message: "Acesso administrativo revogado." });
    next();
  } catch {
    res
      .status(500)
      .json({ message: "Não foi possível confirmar sua permissão." });
  }
}
adminRoutes.use(ensureAuthenticated, ensureAdmin);
const handler =
  (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      const status =
        error instanceof AppError
          ? error.statusCode
          : (error as { code?: string })?.code === "23505"
            ? 409
            : 500;
      res
        .status(status)
        .json({
          message:
            error instanceof AppError
              ? error.message
              : status === 409
                ? "Este e-mail já está em uso."
                : "Não foi possível concluir a operação administrativa.",
        });
    }
  };
export function validateDecision(body: Record<string, unknown>) {
  if (!["aprovado", "rejeitado"].includes(String(body.status)))
    throw new AppError("Decisão inválida.");
  if (
    body.status === "rejeitado" &&
    (typeof body.motivo !== "string" ||
      !body.motivo.trim() ||
      body.motivo.length > 2000)
  )
    throw new AppError("Informe um motivo de rejeição de até 2000 caracteres.");
  return {
    status: body.status as StatusModeracao,
    motivo: body.status === "rejeitado" ? String(body.motivo).trim() : null,
  };
}
const uuid = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new AppError("Identificador inválido.");
  return value;
};
function pagination(req: Request) {
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  const size = Math.max(1, Math.min(50, Number(req.query.size) || 15));
  if (!Number.isInteger(page) || !Number.isInteger(size))
    throw new AppError("Paginação inválida.");
  return { page, size, offset: (page - 1) * size };
}
const profiles = `SELECT s.id, s.nome_fantasia AS nome, 'startup'::text AS tipo, u.email, s.criado_em AS "criadoEm", s.status_moderacao::text AS status, u.ativo, NULL::text AS "tipoInvestidor", u.nome AS responsavel, s.segmento::text AS segmento FROM startups s JOIN usuarios u ON u.id=s.usuario_id
UNION ALL SELECT i.id, i.nome, CASE WHEN i.tipo_investidor='mentor' THEN 'mentor' ELSE 'investidor' END, u.email, i.criado_em, i.status_moderacao::text, u.ativo, i.tipo_investidor::text, u.nome, NULL::text FROM investidores i JOIN usuarios u ON u.id=i.usuario_id`;
adminRoutes.get(
  "/metricas",
  handler(async () => {
    const [stats] =
      await db.query(`SELECT (SELECT count(*)::int FROM usuarios) AS usuarios,
    (SELECT count(*)::int FROM startups) AS startups,
    (SELECT count(*)::int FROM investidores) AS investidores,
    (SELECT count(*)::int FROM investidores WHERE tipo_investidor IN ('mentor','anjo_mentor')) AS mentores,
    (SELECT count(*)::int FROM (
      SELECT DISTINCT investidor_id, startup_id FROM funil_interacoes
      WHERE tipo_evento='interesse_demonstrado'
    ) pares) AS matches,
    (SELECT count(*)::int FROM conversas c
      WHERE EXISTS (SELECT 1 FROM mensagens m WHERE m.conversa_id=c.id)) AS conversas,
    (SELECT count(*)::int FROM reunioes) AS reunioes,
    (SELECT count(*)::int FROM startups WHERE status_moderacao='pendente') +
    (SELECT count(*)::int FROM investidores WHERE status_moderacao='pendente') AS pendentes`);
    return stats;
  }),
);
adminRoutes.get(
  "/cadastros",
  handler(async (req) => {
    const { page, size, offset } = pagination(req);
    const search = String(req.query.q || "").slice(0, 150);
    const type = String(req.query.tipo || "");
    const status = String(req.query.status || "");
    if (req.query.grupo && req.query.grupo !== "investidores")
      throw new AppError("Grupo inválido.");
    if (type && !["startup", "investidor", "mentor"].includes(type))
      throw new AppError("Tipo inválido.");
    if (
      status &&
      !Object.values(StatusModeracao).includes(status as StatusModeracao)
    )
      throw new AppError("Status inválido.");
    const where =
      "($1='' OR nome ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%') AND ($2='' OR tipo=$2 OR ($2='mentor' AND \"tipoInvestidor\"='anjo_mentor')) AND ($3='' OR status=$3)" +
      (req.query.grupo === "investidores"
        ? " AND tipo IN ('investidor','mentor')"
        : "");
    const params = [search, type, status];
    const [{ total }] = await db.query(
      `SELECT count(*)::int AS total FROM (${profiles}) p WHERE ${where}`,
      params,
    );
    const sort =
      req.query.sort === "nome"
        ? "nome ASC, id ASC"
        : '"criadoEm" DESC, id ASC';
    const items = await db.query(
      `SELECT * FROM (${profiles}) p WHERE ${where} ORDER BY ${sort} LIMIT $4 OFFSET $5`,
      [...params, size, offset],
    );
    return { items, total, page, size };
  }),
);
adminRoutes.get(
  "/usuarios",
  handler(async (req) => {
    const { page, size, offset } = pagination(req);
    const q = String(req.query.q || "").slice(0, 150);
    const role = String(req.query.tipo || "");
    const active = String(req.query.status || "");
    if (role && !Object.values(TipoPerfil).includes(role as TipoPerfil))
      throw new AppError("Tipo inválido.");
    if (active && !["ativo", "inativo"].includes(active))
      throw new AppError("Status inválido.");
    const where =
      "($1='' OR nome ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%') AND ($2='' OR tipo_perfil::text=$2) AND ($3='' OR ativo=($3='ativo'))";
    const params = [q, role, active];
    const [{ total }] = await db.query(
      `SELECT count(*)::int AS total FROM usuarios WHERE ${where}`,
      params,
    );
    const items = await db.query(
      `SELECT id,nome,email,tipo_perfil AS tipo,criado_em AS "criadoEm", CASE WHEN ativo THEN 'ativo' ELSE 'inativo' END AS status,ativo FROM usuarios WHERE ${where} ORDER BY ${req.query.sort === "nome" ? "nome ASC,id ASC" : "criado_em DESC,id ASC"} LIMIT $4 OFFSET $5`,
      [...params, size, offset],
    );
    return { items, total, page, size };
  }),
);
async function profile(kind: string, id: string) {
  if (!["startup", "investidor", "mentor"].includes(kind))
    throw new AppError("Tipo inválido.");
  const item =
    kind === "startup"
      ? await db
          .getRepository(Startup)
          .findOne({ where: { id: uuid(id) }, relations: { usuario: true } })
      : await db
          .getRepository(Investidor)
          .findOne({ where: { id: uuid(id) }, relations: { usuario: true } });
  if (!item) throw new AppError("Cadastro não encontrado.", 404);
  const { usuario, ...fields } = item;
  return {
    ...fields,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      ativo: usuario.ativo,
    },
  };
}
adminRoutes.get(
  "/cadastros/:tipo/:id",
  handler(async (req) => {
    const detail = await profile(
      String(req.params.tipo),
      String(req.params.id),
    );
    const history = await db.query(
      `SELECT a.id, a.acao, a.criado_em AS "criadoEm", a.detalhes, u.nome AS ator FROM log_auditoria a LEFT JOIN usuarios u ON u.id=a.admin_usuario_id WHERE a.entidade_id=$1 ORDER BY a.criado_em DESC,a.id DESC LIMIT 100`,
      [detail.id],
    );
    return { ...detail, historico: history };
  }),
);
adminRoutes.post(
  "/cadastros/:tipo/:id/decisao",
  handler(async (req) => {
    const kind = String(req.params.tipo);
    if (!["startup", "investidor", "mentor"].includes(kind))
      throw new AppError("Tipo inválido.");
    const id = uuid(req.params.id);
    const decision = validateDecision(req.body || {});
    return db.transaction(async (manager) => {
      const entity = kind === "startup" ? Startup : Investidor;
      // Query through a common property set while retaining entity-specific repositories.
      const repo = manager.getRepository(entity as typeof Startup);
      const item = await repo.findOne({
        where: { id },
        lock: { mode: "pessimistic_write" },
      });
      if (!item) throw new AppError("Cadastro não encontrado.", 404);
      if (item.statusModeracao !== StatusModeracao.PENDENTE)
        throw new AppError(
          "Este cadastro já foi analisado. Atualize a lista.",
          409,
        );
      const anterior = item.statusModeracao;
      item.statusModeracao = decision.status;
      await repo.save(item);
      await manager.getRepository(LogAuditoria).save({
        adminUsuario: { id: req.user!.id },
        acao:
          decision.status === StatusModeracao.APROVADO
            ? AcaoAuditoria.APROVACAO_CADASTRO
            : AcaoAuditoria.REJEICAO_CADASTRO,
        entidadeTipo: kind === "startup" ? "startup" : "investidor",
        entidadeId: id,
        detalhes: {
          statusAnterior: anterior,
          statusNovo: decision.status,
          motivo: decision.motivo,
          resultado: "sucesso",
        },
      });
      return { id, status: decision.status };
    });
  }),
);
adminRoutes.patch(
  "/:recurso/:id",
  handler(async (req) => {
    const resource = String(req.params.recurso);
    if (!["usuarios", "startups", "investidores"].includes(resource))
      throw new AppError("Recurso inválido.");
    const id = uuid(req.params.id);
    const body = req.body || {};
    const allowed: Record<string, number> =
      resource === "usuarios"
        ? { nome: 150, email: 150 }
        : resource === "startups"
          ? { nomeFantasia: 150, descricaoCurta: 300 }
          : { nome: 150, tituloProfissional: 150, bio: 5000 };
    if (
      !Object.keys(body).length ||
      Object.keys(body).some(
        (key) => !Object.prototype.hasOwnProperty.call(allowed, key),
      )
    )
      throw new AppError("Campos de edição não permitidos.");
    for (const [key, value] of Object.entries(body)) {
      const max = (allowed as Record<string, number>)[key];
      if (
        typeof value !== "string" ||
        value.trim().length > max ||
        (["nome", "nomeFantasia", "email"].includes(key) && !value.trim())
      )
        throw new AppError("Confira os campos de edição.");
    }
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))
      throw new AppError("E-mail inválido.");
    return db.transaction(async (manager) => {
      const entity =
        resource === "usuarios"
          ? Usuario
          : resource === "startups"
            ? Startup
            : Investidor;
      const repo = manager.getRepository(entity as typeof Usuario);
      const item = await repo.findOne({
        where: { id },
        lock: { mode: "pessimistic_write" },
      });
      if (!item) throw new AppError("Registro não encontrado.", 404);
      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        const newValue =
          key === "email"
            ? String(value).trim().toLowerCase()
            : String(value).trim();
        const record = item as unknown as Record<string, unknown>;
        if (record[key] !== newValue) {
          changes[key] = { antes: record[key], depois: newValue };
          record[key] = newValue;
        }
      }
      if (!Object.keys(changes).length) return { id, alterado: false };
      await repo.save(item);
      await manager
        .getRepository(LogAuditoria)
        .save({
          adminUsuario: { id: req.user!.id },
          acao: AcaoAuditoria.EDICAO_CONTEUDO,
          entidadeTipo: resource,
          entidadeId: id,
          detalhes: { alteracoes: changes, resultado: "sucesso" },
        });
      return { id, alterado: true };
    });
  }),
);
adminRoutes.get(
  "/auditoria",
  handler(async (req) => {
    const { page, size, offset } = pagination(req);
    const q = String(req.query.q || "").slice(0, 150);
    const action = String(req.query.acao || "");
    const resource = String(req.query.recurso || "");
    const actor = String(req.query.ator || "").slice(0, 150);
    const dates = [String(req.query.de || ""), String(req.query.ate || "")];
    for (const date of dates)
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new AppError("Data inválida.");
    if (
      action &&
      !Object.values(AcaoAuditoria).includes(action as AcaoAuditoria)
    )
      throw new AppError("Ação inválida.");
    const params = [q, action, resource, actor, ...dates];
    const where =
      "($1='' OR a.entidade_id::text ILIKE '%'||$1||'%' OR a.detalhes::text ILIKE '%'||$1||'%') AND ($2='' OR a.acao::text=$2) AND ($3='' OR a.entidade_tipo=$3) AND ($4='' OR u.nome ILIKE '%'||$4||'%') AND ($5='' OR a.criado_em >= NULLIF($5,'')::date) AND ($6='' OR a.criado_em < NULLIF($6,'')::date + interval '1 day')";
    const from =
      "FROM log_auditoria a LEFT JOIN usuarios u ON u.id=a.admin_usuario_id";
    const [{ total }] = await db.query(
      `SELECT count(*)::int AS total ${from} WHERE ${where}`,
      params,
    );
    const items = await db.query(
      `SELECT a.id,a.acao,a.entidade_tipo AS recurso,a.entidade_id AS "entidadeId",a.detalhes,a.criado_em AS "criadoEm",u.nome AS ator ${from} WHERE ${where} ORDER BY a.criado_em DESC,a.id DESC LIMIT $7 OFFSET $8`,
      [...params, size, offset],
    );
    return { items, total, page, size };
  }),
);
adminRoutes.get(
  "/reunioes",
  handler(async (req) => {
    const { page, size, offset } = pagination(req);
    const q = String(req.query.q || "").slice(0, 150);
    const status = String(req.query.status || "");
    if (
      status &&
      !["agendada", "realizada", "cancelada", "no_show"].includes(status)
    )
      throw new AppError("Status de reunião inválido.");
    const from =
      "FROM reunioes r JOIN startups s ON s.id=r.startup_id JOIN investidores i ON i.id=r.investidor_id";
    const where =
      "($1='' OR s.nome_fantasia ILIKE '%'||$1||'%' OR i.nome ILIKE '%'||$1||'%') AND ($2='' OR r.status::text=$2)";
    const [{ total }] = await db.query(
      `SELECT count(*)::int AS total ${from} WHERE ${where}`,
      [q, status],
    );
    const items = await db.query(
      `SELECT r.id, s.nome_fantasia AS startup, i.nome AS investidor, r.data_hora_agendada AS "dataHoraAgendada", r.status, r.link_reuniao AS "linkReuniao", r.notas, r.criado_em AS "criadoEm" ${from} WHERE ${where} ORDER BY r.data_hora_agendada DESC,r.id DESC LIMIT $3 OFFSET $4`,
      [q, status, size, offset],
    );
    return { items, total, page, size };
  }),
);
