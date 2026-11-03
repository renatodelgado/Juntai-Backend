import { Repository } from "typeorm";
import { AppDataSource } from "@shared/database/data-source";
import { Conversa } from "@modules/conversas/entities/Conversa";

export interface ConversaResumo {
  conversaId: string;
  usuarioId: string; // o OUTRO participante (quem não está logado), pra abrir GET /mensagens/:usuarioId
  nome: string;
  avatarUrl: string | null;
  logoUrl: string | null;
  tipoPerfil: "startup" | "investidor";
  ultimaMensagem: string | null;
  ultimaMensagemEm: Date | null;
  enviadaPorMim: boolean | null;
  naoLidas: number;
}

export class ConversaRepository {
  private get repository(): Repository<Conversa> {
    return AppDataSource.getRepository(Conversa);
  }

  // Unique(['startup', 'investidor']) na entidade garante no máximo uma conversa por par.
  async buscarPorPar(
    startupId: string,
    investidorId: string,
  ): Promise<Conversa | null> {
    return this.repository.findOne({
      where: { startup: { id: startupId }, investidor: { id: investidorId } },
    });
  }

  async criar(startupId: string, investidorId: string): Promise<Conversa> {
    const conversa = this.repository.create({
      startup: { id: startupId },
      investidor: { id: investidorId },
    } as Partial<Conversa>);
    return this.repository.save(conversa);
  }

  async tocarUltimaMensagem(conversaId: string, quando: Date): Promise<void> {
    await this.repository.update(conversaId, { ultimaMensagemEm: quando });
  }

  // Lista as conversas do usuário (como startup ou como investidor), com a última mensagem
  // e a contagem de não lidas. Seleciona somente avatar_url do usuário investidor; o id/nome do outro participante
  // vêm de startups.usuario_id/nome_fantasia e investidores.usuario_id/nome, que já são públicos.
  async listarResumoPorUsuario(usuarioId: string): Promise<ConversaResumo[]> {
    const linhas: Array<{
      conversa_id: string;
      startup_nome: string;
      startup_logo_url: string | null;
      investidor_avatar_url: string | null;
      startup_usuario_id: string;
      investidor_nome: string;
      investidor_usuario_id: string;
      ultima_mensagem_em: Date | null;
      ultima_mensagem: string | null;
      ultima_mensagem_remetente_id: string | null;
      nao_lidas: number;
    }> = await AppDataSource.query(
      `SELECT
         c.id AS conversa_id,
         s.nome_fantasia AS startup_nome, s.logo_url AS startup_logo_url, iu.avatar_url AS investidor_avatar_url,
         s.usuario_id AS startup_usuario_id,
         i.nome AS investidor_nome,
         i.usuario_id AS investidor_usuario_id,
         c.ultima_mensagem_em,
         lm.conteudo AS ultima_mensagem,
         lm.remetente_usuario_id AS ultima_mensagem_remetente_id,
         (SELECT count(*)::int FROM mensagens m2
            WHERE m2.conversa_id = c.id AND m2.remetente_usuario_id <> $1 AND m2.lido_em IS NULL) AS nao_lidas
       FROM conversas c
       JOIN startups s ON s.id = c.startup_id
       JOIN investidores i ON i.id = c.investidor_id
       JOIN usuarios iu ON iu.id = i.usuario_id
       LEFT JOIN LATERAL (
         SELECT conteudo, remetente_usuario_id
         FROM mensagens m
         WHERE m.conversa_id = c.id
         ORDER BY enviado_em DESC
         LIMIT 1
       ) lm ON true
       WHERE s.usuario_id = $1 OR i.usuario_id = $1
       ORDER BY c.ultima_mensagem_em DESC NULLS LAST`,
      [usuarioId],
    );

    return linhas.map((row) => {
      const souStartup = row.startup_usuario_id === usuarioId;
      return {
        conversaId: row.conversa_id,
        usuarioId: souStartup
          ? row.investidor_usuario_id
          : row.startup_usuario_id,
        nome: souStartup ? row.investidor_nome : row.startup_nome,
        avatarUrl: souStartup ? row.investidor_avatar_url : null,
        logoUrl: souStartup ? null : row.startup_logo_url,
        tipoPerfil: souStartup ? ("investidor" as const) : ("startup" as const),
        ultimaMensagem: row.ultima_mensagem,
        ultimaMensagemEm: row.ultima_mensagem_em,
        enviadaPorMim:
          row.ultima_mensagem_remetente_id === null
            ? null
            : row.ultima_mensagem_remetente_id === usuarioId,
        naoLidas: Number(row.nao_lidas),
      };
    });
  }
}
