import { AppDataSource as db } from '@shared/database/data-source';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import { campoVisivel } from '@modules/moderacao/services/OcultacaoPerfil';

const nomeInvestidor = campoVisivel('investidor', 'i.id', 'nome', 'i.nome');
const nomeStartup = campoVisivel('startup', 's.id', 'nomeFantasia', 's.nome_fantasia');

export function validarContexto(tipo: string, id: string) {
  if (!['conversa', 'reuniao'].includes(tipo) || !(tipo === 'conversa' ? isUuid(id) : /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n))
    throw new AppError('Contexto de avaliação inválido.', 400);
}
export function validarNota(nota: unknown, comentario: unknown) {
  if (!Number.isInteger(nota) || (nota as number) < 1 || (nota as number) > 5)
    throw new AppError('Informe uma nota inteira entre 1 e 5.', 400);
  if (comentario !== undefined && comentario !== null && typeof comentario !== 'string')
    throw new AppError('Comentário inválido.', 400);
  const texto = typeof comentario === 'string' ? comentario.trim() : '';
  if (texto.length > 2000) throw new AppError('O comentário pode ter no máximo 2000 caracteres.', 400);
  return { nota: nota as number, comentario: texto || null };
}
export const resultadosInteracao = ['em_analise', 'avancar', 'nao_seguir'] as const;
export const perspectivasInvestimento = ['nao_definido', 'em_negociacao', 'intencao', 'realizado', 'nao_se_aplica'] as const;
export interface FeedbackInput {
  nota?: unknown;
  comentario?: unknown;
  resultadoInteracao?: unknown;
  perspectivaInvestimento?: unknown;
}
export function validarMetricas(body: FeedbackInput) {
  const validar = (valor: unknown, opcoes: readonly string[], campo: string) => {
    if (valor === undefined) return null; // Preserve existing metrics for older clients.
    if (typeof valor !== 'string' || !opcoes.includes(valor)) throw new AppError(`${campo} inválido.`, 400);
    return valor;
  };
  return {
    resultado: validar(body?.resultadoInteracao, resultadosInteracao, 'Resultado da interação'),
    perspectiva: validar(body?.perspectivaInvestimento, perspectivasInvestimento, 'Perspectiva de investimento'),
  };
}
export class AvaliacaoService {
  async contexto(usuarioId: string, tipo: string, id: string) {
    validarContexto(tipo, id);
    const tabela = tipo === 'conversa' ? 'conversas' : 'reunioes';
    const [ctx] = await db.query(`SELECT c.id, s.usuario_id AS startup, i.usuario_id AS investidor,
      CASE WHEN s.usuario_id=$2 THEN ${nomeInvestidor} ELSE ${nomeStartup} END AS nome,
      ${tipo === 'reuniao' ? "c.status='realizada'" : `(EXISTS (SELECT 1 FROM mensagens m WHERE m.conversa_id=c.id AND m.remetente_usuario_id=s.usuario_id)
        AND EXISTS (SELECT 1 FROM mensagens m WHERE m.conversa_id=c.id AND m.remetente_usuario_id=i.usuario_id))`} AS elegivel
      FROM ${tabela} c JOIN startups s ON s.id=c.startup_id JOIN investidores i ON i.id=c.investidor_id
      JOIN usuarios u ON u.id=$2 AND u.ativo=true
      WHERE c.id=$1 AND (s.usuario_id=$2 OR i.usuario_id=$2)`, [id, usuarioId]);
    if (!ctx) throw new AppError('Interação não encontrada ou acesso não permitido.', 404);
    return ctx;
  }
  async consultar(usuarioId: string, tipo: string, id: string) {
    const ctx = await this.contexto(usuarioId, tipo, id);
    const coluna = tipo === 'conversa' ? 'conversa_id' : 'reuniao_id';
    const outroUsuarioId = ctx.startup === usuarioId ? ctx.investidor : ctx.startup;
    // One snapshot: expose only the other participant's investment declaration, never their private review.
    const [state] = await db.query(`SELECT
      (SELECT row_to_json(minha) FROM (
        SELECT id::text, nota, CASE WHEN NOT comentario_ocultado_por_moderacao THEN comentario END AS comentario,
          resultado_interacao AS "resultadoInteracao",
          perspectiva_investimento AS "perspectivaInvestimento", criado_em AS "criadoEm", atualizado_em AS "atualizadoEm"
        FROM avaliacoes WHERE ${coluna}=$1 AND avaliador_usuario_id=$2
      ) minha) AS avaliacao,
      EXISTS(SELECT 1 FROM avaliacoes WHERE ${coluna}=$1 AND avaliador_usuario_id=$3
        AND avaliado_usuario_id=$2 AND perspectiva_investimento='realizado') AS "investimentoInformadoPeloOutro"`, [id, usuarioId, outroUsuarioId]);
    return {
      elegivel: ctx.elegivel, nome: ctx.nome, avaliacao: state.avaliacao,
      investimentoInformadoPeloOutro: state.investimentoInformadoPeloOutro,
      investimentoConfirmado: state.avaliacao?.perspectivaInvestimento === 'realizado' && state.investimentoInformadoPeloOutro,
    };
  }
  async salvar(usuarioId: string, tipo: string, id: string, body: FeedbackInput) {
    const valor = validarNota(body?.nota, body?.comentario);
    const metricas = validarMetricas(body);
    const ctx = await this.contexto(usuarioId, tipo, id);
    if (!ctx.elegivel) throw new AppError('Aguarde a troca de mensagens ou a conclusão da reunião para avaliar.', 409);
    const avaliado = ctx.startup === usuarioId ? ctx.investidor : ctx.startup;
    if (avaliado === usuarioId) throw new AppError('Não é possível avaliar a si mesmo.', 400);
    const coluna = tipo === 'conversa' ? 'conversa_id' : 'reuniao_id';
    await db.query(`INSERT INTO avaliacoes (${coluna}, avaliador_usuario_id, avaliado_usuario_id, nota, comentario, resultado_interacao, perspectiva_investimento)
      VALUES ($1,$2,$3,$4,$5,COALESCE($6,'em_analise'),COALESCE($7,'nao_definido'))
      ON CONFLICT (${coluna}, avaliador_usuario_id) WHERE ${coluna} IS NOT NULL
      DO UPDATE SET nota=EXCLUDED.nota,
        comentario=CASE WHEN avaliacoes.comentario_ocultado_por_moderacao THEN avaliacoes.comentario ELSE EXCLUDED.comentario END,
        resultado_interacao=COALESCE($6,avaliacoes.resultado_interacao),
        perspectiva_investimento=COALESCE($7,avaliacoes.perspectiva_investimento), atualizado_em=now()`,
      [id, usuarioId, avaliado, valor.nota, valor.comentario, metricas.resultado, metricas.perspectiva]);
    return this.consultar(usuarioId, tipo, id);
  }
  async adiar(usuarioId: string, tipo: string, id: string) {
    const ctx = await this.contexto(usuarioId, tipo, id);
    if (!ctx.elegivel) throw new AppError('Interação ainda não disponível para avaliação.', 409);
    await db.query(`INSERT INTO avaliacao_adiamentos (usuario_id, tipo, contexto_id, adiado_ate)
      VALUES ($1,$2,$3,now()+interval '24 hours') ON CONFLICT (usuario_id,tipo,contexto_id)
      DO UPDATE SET adiado_ate=EXCLUDED.adiado_ate`, [usuarioId,tipo,id]);
  }
  async pendentes(usuarioId: string) {
    return db.query(`SELECT r.id::text, 'reuniao' AS tipo,
      CASE WHEN s.usuario_id=$1 THEN ${nomeInvestidor} ELSE ${nomeStartup} END AS nome
      FROM reunioes r JOIN startups s ON s.id=r.startup_id JOIN investidores i ON i.id=r.investidor_id
      JOIN usuarios u ON u.id=$1 AND u.ativo=true
      WHERE r.status='realizada' AND (s.usuario_id=$1 OR i.usuario_id=$1)
      AND NOT EXISTS (SELECT 1 FROM avaliacoes a WHERE a.reuniao_id=r.id AND a.avaliador_usuario_id=$1)
      AND NOT EXISTS (SELECT 1 FROM avaliacao_adiamentos d WHERE d.usuario_id=$1 AND d.tipo='reuniao'
        AND d.contexto_id=r.id::text AND d.adiado_ate>now()) ORDER BY r.data_hora_agendada DESC LIMIT 20`, [usuarioId]);
  }
}
