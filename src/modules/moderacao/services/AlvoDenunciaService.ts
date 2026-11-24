import { EntityManager } from 'typeorm';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import { TipoAlvoModeracao } from '../entities/Denuncia';
import { campoVisivel } from './OcultacaoPerfil';

const camposStartup = {
  nomeFantasia: 'nome_fantasia',
  descricaoCurta: 'descricao_curta',
  descricaoPitch: 'descricao_pitch',
  siteUrl: 'site_url',
  linksSociais: 'links_sociais',
  videoApresentacaoUrl: 'video_apresentacao_url',
  logoUrl: 'logo_url',
  apresentacaoUrl: 'apresentacao_url',
};
const camposInvestidor = {
  nome: 'nome',
  tituloProfissional: 'titulo_profissional',
  bio: 'bio',
  descricaoExperiencia: 'descricao_experiencia',
  linkedinUrl: 'linkedin_url',
  avatarUrl: 'avatar_url',
};
export const camposPerfilDenuncia = { startup: camposStartup, investidor: camposInvestidor };

export interface AlvoDenuncia {
  tipoAlvo: TipoAlvoModeracao;
  alvoId: string;
  campoAlvo: string | null;
}

export interface MidiaDenunciada {
  url: string;
  pasta: string;
  tipo: 'image' | 'raw';
}

const midias: Partial<Record<string, Omit<MidiaDenunciada, 'url'>>> = {
  logoUrl: { pasta: 'juntai/startups/logo', tipo: 'image' },
  apresentacaoUrl: { pasta: 'juntai/startups/apresentacao', tipo: 'raw' },
  avatarUrl: { pasta: 'juntai/investidores/avatar', tipo: 'image' },
};

export function validarAlvo(body: Record<string, unknown>): AlvoDenuncia {
  const { tipoAlvo, alvoId, campoAlvo = null } = body;
  if (tipoAlvo !== 'mensagem' && tipoAlvo !== 'avaliacao' && tipoAlvo !== 'startup' && tipoAlvo !== 'investidor')
    throw new AppError('Tipo de alvo inválido.');

  const perfil = tipoAlvo === 'startup' || tipoAlvo === 'investidor';
  if (typeof alvoId !== 'string' || !(perfil
    ? isUuid(alvoId)
    : /^[1-9]\d{0,18}$/.test(alvoId) && BigInt(alvoId) <= 9223372036854775807n))
    throw new AppError('Identificador do alvo inválido.');

  const campos = tipoAlvo === 'startup' ? camposStartup : camposInvestidor;
  if (campoAlvo !== null && (!perfil || typeof campoAlvo !== 'string' || !Object.hasOwn(campos, campoAlvo)))
    throw new AppError('Campo do alvo inválido.');

  return { tipoAlvo, alvoId: alvoId.toLowerCase(), campoAlvo };
}

export class AlvoDenunciaService {
  async buscar(manager: EntityManager, usuarioId: string, alvo: AlvoDenuncia): Promise<{
    denunciadoId: string;
    snapshot: Record<string, unknown>;
    midia?: MidiaDenunciada;
  }> {
    const { tipoAlvo, alvoId, campoAlvo } = alvo;
    const parametros = [alvoId, usuarioId];
    if (tipoAlvo === 'mensagem') {
      const [row] = await manager.query(
        `SELECT m.remetente_usuario_id AS "denunciadoId",
           jsonb_build_object('conteudo', m.conteudo, 'enviadoEm', m.enviado_em) AS snapshot
         FROM mensagens m JOIN conversas c ON c.id=m.conversa_id
         JOIN startups s ON s.id=c.startup_id JOIN investidores i ON i.id=c.investidor_id
         WHERE m.id=$1 AND $2 IN (s.usuario_id,i.usuario_id) AND NOT m.ocultada_por_moderacao`, parametros);
      if (!row) throw new AppError('Alvo não encontrado ou acesso não permitido.', 404);
      return row;
    }

    if (tipoAlvo === 'avaliacao') {
      const [row] = await manager.query(
        `SELECT a.avaliador_usuario_id AS "denunciadoId",
           jsonb_build_object('nota', a.nota, 'comentario',
             CASE WHEN NOT a.comentario_ocultado_por_moderacao THEN a.comentario END,
             'atualizadoEm', a.atualizado_em) AS snapshot
         FROM avaliacoes a
         LEFT JOIN conversas c ON c.id=a.conversa_id
         LEFT JOIN reunioes r ON r.id=a.reuniao_id
         JOIN startups s ON s.id=COALESCE(c.startup_id,r.startup_id)
         JOIN investidores i ON i.id=COALESCE(c.investidor_id,r.investidor_id)
         WHERE a.id=$1 AND a.avaliador_usuario_id=$2 AND $2 IN (s.usuario_id,i.usuario_id)`, parametros);
      if (!row) throw new AppError('Alvo não encontrado ou acesso não permitido.', 404);
      return row;
    }

    const startup = tipoAlvo === 'startup';
    const tabela = startup ? 'startups' : 'investidores';
    const campos: Record<string, string> = startup ? camposStartup : camposInvestidor;
    const camposSelecionados = campoAlvo
      ? [[campoAlvo, campos[campoAlvo]]]
      : Object.entries(campos).filter(([campo]) => !Object.hasOwn(midias, campo));
    const colunas = camposSelecionados.map(([campo, coluna]) =>
      `${campoVisivel(tipoAlvo, 'p.id', campo, `${campo === 'avatarUrl' ? 'u' : 'p'}.${coluna}`)} AS "${campo}"`).join(', ');
    const condicaoAvatar = campoAlvo === 'avatarUrl'
      ? `AND (p.usuario_id=$2 OR EXISTS (
           SELECT 1 FROM conversas c JOIN startups s ON s.id=c.startup_id
           WHERE c.investidor_id=p.id AND s.usuario_id=$2
         ) OR EXISTS (
           SELECT 1 FROM funil_interacoes f JOIN startups s ON s.id=f.startup_id
           WHERE f.investidor_id=p.id AND s.usuario_id=$2
             AND f.tipo_evento='interesse_demonstrado'
             AND s.status_moderacao='aprovado' AND p.status_moderacao='aprovado'
             AND u.ativo AND u.tipo_perfil='investidor'
         ))`
      : '';
    const [row] = await manager.query(
      `SELECT p.usuario_id AS "denunciadoId", ${colunas}
       FROM ${tabela} p JOIN usuarios u ON u.id=p.usuario_id
       WHERE p.id=$1 ${condicaoAvatar}`, condicaoAvatar ? parametros : [alvoId]);
    if (!row || (campoAlvo && (row[campoAlvo] == null || row[campoAlvo] === '')))
      throw new AppError('Alvo não encontrado ou acesso não permitido.', 404);

    const { denunciadoId, ...snapshot } = row;
    if (campoAlvo && Object.hasOwn(midias, campoAlvo)) {
      return { denunciadoId, snapshot: {}, midia: { ...midias[campoAlvo]!, url: row[campoAlvo] } };
    }
    return { denunciadoId, snapshot };
  }
}
