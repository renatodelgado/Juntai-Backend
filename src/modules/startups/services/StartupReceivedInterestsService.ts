import { AppDataSource as db } from '@shared/database/data-source';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';

export class StartupReceivedInterestsService {
  async list(userId: string) {
    if (!isUuid(userId)) throw new AppError('Usuário inválido.', 401);
    const [actor] = await db.query(`SELECT s.id FROM startups s JOIN usuarios u ON u.id=s.usuario_id
      WHERE u.id=$1 AND u.ativo=true AND u.tipo_perfil='startup' AND s.status_moderacao='aprovado'`, [userId]);
    if (!actor) throw new AppError('Somente startups aprovadas podem consultar seus interessados.', 403);
    // Project only public profile fields; the startup comes exclusively from the authenticated account.
    const items = await db.query(`SELECT i.id AS "investidorId", u.id AS "usuarioId", i.nome,
      u.avatar_url AS "avatarUrl", i.tipo_investidor AS "tipoInvestidor", i.titulo_profissional AS "tituloProfissional",
      i.bio, i.cidade, i.estado, i.linkedin_url AS "linkedinUrl", i.descricao_experiencia AS "descricaoExperiencia",
      i.anos_experiencia AS "anosExperiencia", COALESCE(i.areas_ajuda::text[],'{}'::text[]) AS "areasAjuda", COALESCE(i.segmentos_interesse::text[],'{}'::text[]) AS "segmentosInteresse",
      COALESCE(i.estagios_interesse::text[],'{}'::text[]) AS "estagiosInteresse", e.interessado_em AS "interessadoEm",
      CASE WHEN cm.iniciada THEN c.id ELSE NULL END AS "conversaId",
      cm.iniciada AS "conversaIniciada", (cm.iniciada AND cm.respondeu) AS "podeAvaliarConversa",
      agenda.id::text AS "reuniaoAgendadaId", agenda.data_hora_agendada AS "reuniaoAgendadaEm",
      agendadas.total AS "reunioesAgendadas", realizada.id::text AS "reuniaoRealizadaId",
      CASE WHEN agenda.id IS NOT NULL THEN 'reuniao_agendada' WHEN realizada.id IS NOT NULL THEN 'em_acompanhamento'
        WHEN cm.iniciada THEN 'em_conversa' ELSE 'novo_interesse' END AS situacao
      FROM (SELECT investidor_id, MIN(ocorrido_em) AS interessado_em FROM funil_interacoes
        WHERE startup_id=$1 AND tipo_evento='interesse_demonstrado' GROUP BY investidor_id) e
      JOIN investidores i ON i.id=e.investidor_id AND i.status_moderacao='aprovado'
      JOIN usuarios u ON u.id=i.usuario_id AND u.ativo=true AND u.tipo_perfil='investidor'
      LEFT JOIN conversas c ON c.startup_id=$1 AND c.investidor_id=i.id
      CROSS JOIN LATERAL (SELECT
        EXISTS(SELECT 1 FROM mensagens m WHERE m.conversa_id=c.id AND m.remetente_usuario_id=u.id) AS iniciada,
        EXISTS(SELECT 1 FROM mensagens m WHERE m.conversa_id=c.id AND m.remetente_usuario_id=$2) AS respondeu) cm
      LEFT JOIN LATERAL (SELECT r.id,r.data_hora_agendada FROM reunioes r WHERE r.startup_id=$1 AND r.investidor_id=i.id
        AND r.status='agendada' ORDER BY (r.data_hora_agendada>=now()) DESC,
        CASE WHEN r.data_hora_agendada>=now() THEN r.data_hora_agendada END ASC, r.data_hora_agendada DESC,r.id DESC LIMIT 1) agenda ON true
      CROSS JOIN LATERAL (SELECT count(*)::int AS total FROM reunioes r WHERE r.startup_id=$1 AND r.investidor_id=i.id AND r.status='agendada') agendadas
      LEFT JOIN LATERAL (SELECT r.id FROM reunioes r WHERE r.startup_id=$1 AND r.investidor_id=i.id
        AND r.status='realizada' ORDER BY r.data_hora_agendada DESC,r.id DESC LIMIT 1) realizada ON true
      ORDER BY e.interessado_em DESC, i.id`, [actor.id, userId]);
    return {
      items,
      resumo: {
        interessados: items.length,
        conversasIniciadas: items.filter((item: { conversaIniciada: boolean }) => item.conversaIniciada).length,
        reunioesAgendadas: items.reduce((sum: number, item: { reunioesAgendadas: number }) => sum + item.reunioesAgendadas, 0),
      },
    };
  }
}
