import { AppDataSource } from '@shared/database/data-source';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import { MatchmakingService } from './MatchmakingService';

export class DiscoveryInteractions {
  constructor(private db = AppDataSource, private matcher = new MatchmakingService(db)) {}
  async saved(userId: string) {
    const investor = await this.matcher.actor(userId);
    const rows = await this.db.query(`SELECT f.startup_id AS id FROM startups_salvas f
      JOIN startups s ON s.id=f.startup_id JOIN usuarios u ON u.id=s.usuario_id
      WHERE f.investidor_id=$1 AND s.status_moderacao='aprovado' AND u.ativo=true ORDER BY f.criado_em DESC`, [investor.id]);
    return rows.map((row: { id: string }) => row.id);
  }
  async record(userId: string, startupId: unknown, body: any) {
    if (typeof startupId !== 'string' || !isUuid(startupId) || !body || typeof body !== 'object' || Array.isArray(body) ||
      !isUuid(body.eventId) || !['perfil_aberto','tempo_perfil','salvou','removeu_salvo'].includes(body.tipo) ||
      Object.keys(body).some(k => !['eventId','tipo','segundos'].includes(k)) ||
      (body.tipo === 'tempo_perfil' ? !Number.isInteger(body.segundos) || body.segundos < 10 || body.segundos > 300 : body.segundos !== undefined))
      throw new AppError('Interação inválida.', 400);
    return this.db.transaction(async manager => {
      const investor = await this.matcher.actor(userId, manager, true);
      const [startup] = await manager.query(`SELECT s.id FROM startups s JOIN usuarios u ON u.id=s.usuario_id
        WHERE s.id=$1 AND s.status_moderacao='aprovado' AND u.ativo=true FOR SHARE OF s,u`, [startupId]);
      if (!startup) throw new AppError('Startup indisponível.', 404);
      const inserted = await manager.query(`INSERT INTO interacoes_descoberta (id, investidor_id, startup_id, tipo, segundos)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [body.eventId, investor.id, startupId, body.tipo, body.segundos ?? null]);
      if (inserted.length && body.tipo === 'salvou') await manager.query('INSERT INTO startups_salvas (investidor_id,startup_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [investor.id, startupId]);
      if (inserted.length && body.tipo === 'removeu_salvo') await manager.query('DELETE FROM startups_salvas WHERE investidor_id=$1 AND startup_id=$2', [investor.id, startupId]);
      return { ok: true };
    });
  }
}
