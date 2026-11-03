import { AppDataSource } from "@shared/database/data-source";
import { EntityManager } from "typeorm";
import { AppError } from "@shared/errors/AppError";
import { isUuid } from "@shared/validation/isUuid";

export class StartupInterestService {
  private async actor(manager: EntityManager, userId: string, lock = false) {
    if (!isUuid(userId)) throw new AppError("Usuário inválido.", 401);
    const [investor] = await manager.query(
      "SELECT i.id, i.status_moderacao AS status, u.ativo, u.tipo_perfil AS perfil FROM investidores i JOIN usuarios u ON u.id=i.usuario_id WHERE u.id=$1" +
        (lock ? " FOR UPDATE OF i,u" : ""),
      [userId],
    );
    if (
      !investor?.ativo ||
      investor.perfil !== "investidor" ||
      investor.status !== "aprovado"
    )
      throw new AppError(
        "Somente investidores aprovados podem confirmar interesse.",
        403,
      );
    return investor.id as string;
  }
  async list(userId: string) {
    const investorId = await this.actor(AppDataSource.manager, userId);
    return AppDataSource.query(
      `SELECT s.id AS "startupId", s.nome_fantasia AS "startupName", s.logo_url AS "logoUrl", u.id AS "usuarioId", MIN(e.ocorrido_em) AS "createdAt"
      FROM funil_interacoes e JOIN startups s ON s.id=e.startup_id JOIN usuarios u ON u.id=s.usuario_id
      WHERE e.investidor_id=$1 AND e.tipo_evento='interesse_demonstrado' AND s.status_moderacao='aprovado' AND u.ativo=true
      GROUP BY s.id,s.nome_fantasia,s.logo_url,u.id ORDER BY MIN(e.ocorrido_em) DESC`,
      [investorId],
    );
  }
  async confirm(userId: string, startupId: string) {
    if (!isUuid(startupId)) throw new AppError("Startup inválida.");
    return AppDataSource.transaction(async (manager) => {
      const investorId = await this.actor(manager, userId, true);
      const [startup] = await manager.query(
        "SELECT s.id,s.logo_url,s.nome_fantasia AS nome,s.status_moderacao AS status,u.id AS usuario_id,u.ativo FROM startups s JOIN usuarios u ON u.id=s.usuario_id WHERE s.id=$1 FOR SHARE OF s,u",
        [startupId],
      );
      if (!startup?.ativo || startup.status !== "aprovado")
        throw new AppError("Startup aprovada não encontrada.", 404);
      let [event] = await manager.query(
        "SELECT ocorrido_em FROM funil_interacoes WHERE startup_id=$1 AND investidor_id=$2 AND tipo_evento='interesse_demonstrado' ORDER BY ocorrido_em ASC LIMIT 1",
        [startupId, investorId],
      );
      if (!event)
        [event] = await manager.query(
          "INSERT INTO funil_interacoes (startup_id,investidor_id,tipo_evento) VALUES ($1,$2,'interesse_demonstrado') RETURNING ocorrido_em",
          [startupId, investorId],
        );
      return {
        startupId,
        startupName: startup.nome,
        logoUrl: startup.logo_url,
        usuarioId: startup.usuario_id,
        createdAt: event.ocorrido_em,
      };
    });
  }
}
