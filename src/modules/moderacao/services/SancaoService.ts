import { EntityManager } from 'typeorm';
import { LogAuditoria } from '@modules/auditoria/entities/LogAuditoria';
import { AppDataSource as db } from '@shared/database/data-source';
import { AcaoAuditoria } from '@shared/enums';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import { Sancao } from '../entities/Sancao';

type TipoSancao = Sancao['tipo'];
const tiposPermitidos = new Set<TipoSancao>(['advertencia', 'restricao_chat', 'suspensao', 'banimento']);
const vigente = `s.usuario_id=$1 AND s.revogada_em IS NULL AND s.inicio_em <= statement_timestamp()
  AND (s.fim_em IS NULL OR s.fim_em > statement_timestamp())`;
const prioridade = `CASE s.tipo WHEN 'banimento' THEN 1 WHEN 'suspensao' THEN 2
  WHEN 'restricao_chat' THEN 3 ELSE 4 END`;
const resumo = `s.id, s.tipo, s.motivo, s.inicio_em AS "inicioEm", s.fim_em AS "fimEm"`;

export interface AplicacaoSancao {
  tipo: TipoSancao;
  justificativa: string;
  fimEm: Date | null;
}

export function validarJustificativa(valor: unknown): string {
  if (typeof valor !== 'string' || !valor.trim() || valor.includes('\0') ||
      Array.from(valor.trim()).length > 2000)
    throw new AppError('Informe uma justificativa de até 2000 caracteres.');
  return valor.trim();
}

export function validarAplicacaoSancao(payload: unknown): AplicacaoSancao {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(campo => campo !== 'tipo' && campo !== 'justificativa' && campo !== 'fimEm'))
    throw new AppError('Dados da sanção inválidos.');
  const { tipo, justificativa, fimEm } = payload as Record<string, unknown>;
  if (!tiposPermitidos.has(tipo as TipoSancao)) throw new AppError('Tipo de sanção inválido.');
  const temporaria = tipo === 'restricao_chat' || tipo === 'suspensao';
  if (!temporaria && fimEm != null) throw new AppError('Este tipo de sanção não possui término.');
  if (temporaria && (typeof fimEm !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(fimEm) ||
      fimEm.startsWith('0000') || !Number.isFinite(Date.parse(fimEm)) ||
      new Date(fimEm.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !== fimEm.slice(0, 10)))
    throw new AppError('Informe o término em ISO 8601 com fuso horário.');

  return { tipo: tipo as TipoSancao, justificativa: validarJustificativa(justificativa), fimEm: temporaria ? new Date(fimEm as string) : null };
}

export class SancaoService {
  async verificarAcesso(usuarioId: string, incluiChat = false): Promise<void> {
    const [bloqueio] = await db.query(
      `SELECT s.tipo FROM sancoes s WHERE ${vigente}
       AND (s.tipo IN ('suspensao','banimento') OR ($2 AND s.tipo='restricao_chat'))
       ORDER BY ${prioridade} LIMIT 1`, [usuarioId, incluiChat]);
    if (bloqueio?.tipo === 'banimento') throw new AppError('A conta está banida.', 403);
    if (bloqueio?.tipo === 'suspensao') throw new AppError('A conta está suspensa.', 403);
    if (bloqueio?.tipo === 'restricao_chat') throw new AppError('O envio de mensagens está restrito.', 403);
  }

  async minhasVigentes(usuarioId: string, query: Record<string, unknown>) {
    const pagina = query.page ?? '1';
    if (typeof pagina !== 'string' || !/^[1-9]\d*$/.test(pagina) || Number(pagina) > 100000)
      throw new AppError('Paginação inválida.');
    const page = Number(pagina);
    const size = 20;
    const items = await db.query(
      `SELECT s.id, s.tipo, s.inicio_em AS "inicioEm", s.fim_em AS "fimEm" FROM sancoes s WHERE ${vigente}
       ORDER BY ${prioridade}, s.inicio_em DESC, s.id DESC LIMIT $2 OFFSET $3`,
      [usuarioId, size + 1, (page - 1) * size],
    );
    return { items: items.slice(0, size), page, size, hasMore: items.length > size };
  }

  async daDenuncia(manager: EntityManager, denunciaId: string) {
    return manager.query(
      `SELECT ${resumo}, s.admin_usuario_id AS "adminUsuarioId", s.revogada_em AS "revogadaEm",
         s.revogada_por_usuario_id AS "revogadaPorUsuarioId", s.justificativa_revogacao AS "justificativaRevogacao"
       FROM sancoes s WHERE s.denuncia_id=$1 ORDER BY s.inicio_em DESC, s.id DESC`, [denunciaId],
    );
  }

  async aplicar(manager: EntityManager, adminId: string, denunciaId: string, usuarioId: string, dados: AplicacaoSancao) {
    const [{ agora }] = await manager.query('SELECT statement_timestamp() AS agora') as { agora: Date }[];
    if (dados.fimEm && dados.fimEm <= agora) throw new AppError('O término da sanção deve estar no futuro.');
    const sancao = await manager.getRepository(Sancao).save({
      usuario: { id: usuarioId }, denuncia: { id: denunciaId }, adminUsuario: { id: adminId },
      tipo: dados.tipo, motivo: dados.justificativa, inicioEm: agora, fimEm: dados.fimEm ?? undefined,
    });
    await this.auditar(manager, adminId, sancao.id, AcaoAuditoria.APLICACAO_SANCAO, {
      denunciaId, usuarioId, tipo: dados.tipo, justificativa: dados.justificativa,
      inicioEm: agora, fimEm: dados.fimEm,
    });
    return { id: sancao.id, tipo: dados.tipo, motivo: dados.justificativa, inicioEm: agora, fimEm: dados.fimEm };
  }

  async revogar(id: string, adminId: string, payload: unknown) {
    if (!isUuid(id)) throw new AppError('Identificador inválido.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(campo => campo !== 'justificativa'))
      throw new AppError('Dados da revogação inválidos.');
    const justificativa = validarJustificativa((payload as Record<string, unknown>).justificativa);
    return db.transaction('READ COMMITTED', async manager => {
      const [sancao] = await manager.query(
        `SELECT id, tipo, usuario_id AS "usuarioId", denuncia_id AS "denunciaId", revogada_em AS "revogadaEm"
         FROM sancoes WHERE id=$1 FOR UPDATE`, [id]);
      if (!sancao) throw new AppError('Sanção não encontrada.', 404);
      if (sancao.revogadaEm) throw new AppError('A sanção já foi revogada.', 409);
      const [{ agora }] = await manager.query('SELECT statement_timestamp() AS agora') as { agora: Date }[];
      await manager.getRepository(Sancao).update(sancao.id, {
        revogadaEm: agora, revogadaPorUsuario: { id: adminId }, justificativaRevogacao: justificativa,
      });
      await this.auditar(manager, adminId, sancao.id, AcaoAuditoria.REVOGACAO_SANCAO, {
        denunciaId: sancao.denunciaId, usuarioId: sancao.usuarioId, tipo: sancao.tipo, justificativa,
      });
      return { id: sancao.id, revogadaEm: agora, revogadaPorUsuarioId: adminId };
    });
  }

  private async auditar(manager: EntityManager, adminId: string, id: string, acao: AcaoAuditoria, detalhes: Record<string, unknown>) {
    await manager.getRepository(LogAuditoria).save({
      adminUsuario: { id: adminId }, entidadeTipo: 'sancao', entidadeId: id, acao, detalhes,
    });
  }
}

export const sancoesService = new SancaoService();
