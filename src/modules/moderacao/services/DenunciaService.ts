import { randomUUID } from 'node:crypto';
import { AppDataSource } from '@shared/database/data-source';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import { Denuncia } from '../entities/Denuncia';
import { AlvoDenunciaService, validarAlvo } from './AlvoDenunciaService';
import { EvidenciaService } from './EvidenciaService';

const limiteDiario = 10;
const camposCriacao = new Set(['tipoAlvo', 'alvoId', 'campoAlvo', 'motivo', 'descricao']);
const selecaoPublica = `id, tipo_alvo AS "tipoAlvo", alvo_id AS "alvoId", campo_alvo AS "campoAlvo",
  motivo, status, criada_em AS "criadaEm", analisada_em AS "analisadaEm"`;

function texto(valor: unknown, campo: string, maximo: number): string {
  if (typeof valor !== 'string' || !valor.trim() || valor.includes('\0') || Array.from(valor.trim()).length > maximo)
    throw new AppError(`${campo} deve conter de 1 a ${maximo} caracteres.`);
  return valor.trim();
}

function inteiro(valor: unknown, padrao: number, maximo: number): number {
  if (valor === undefined) return padrao;
  if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor) || Number(valor) > maximo)
    throw new AppError('Paginação inválida.');
  return Number(valor);
}

export class DenunciaService {
  constructor(
    private readonly alvos = new AlvoDenunciaService(),
    private readonly evidencias = new EvidenciaService(),
  ) {}

  async criar(usuarioId: string, payload: unknown) {
    if (!isUuid(usuarioId)) throw new AppError('Usuário inválido.', 401);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(campo => !camposCriacao.has(campo)))
      throw new AppError('Dados da denúncia inválidos.');

    const body = payload as Record<string, unknown>;
    const alvo = validarAlvo(body);
    const motivo = texto(body.motivo, 'Motivo', 100);
    const descricao = body.descricao == null ? undefined : texto(body.descricao, 'Descrição', 2000);
    const id = randomUUID();

    try {
      return await AppDataSource.transaction('READ COMMITTED', async manager => {
        const [usuario] = await manager.query('SELECT ativo FROM usuarios WHERE id=$1', [usuarioId]);
        if (!usuario?.ativo) throw new AppError('Usuário não encontrado ou inativo.', 401);
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('denuncias:' || $1::uuid::text, 0))", [usuarioId]);

        const [duplicada] = await manager.query(
          `SELECT 1 FROM denuncias WHERE denunciante_usuario_id=$1 AND tipo_alvo=$2 AND alvo_id=$3
           AND COALESCE(campo_alvo,'')=COALESCE($4,'') AND status IN ('pendente','em_analise') LIMIT 1`,
          [usuarioId, alvo.tipoAlvo, alvo.alvoId, alvo.campoAlvo]);
        if (duplicada) throw new AppError('Já existe uma denúncia aberta para este alvo e campo.', 409);

        const [quota] = await manager.query(
          `SELECT count(*)::int AS total FROM denuncias
           WHERE denunciante_usuario_id=$1 AND criada_em >= statement_timestamp() - interval '24 hours'`, [usuarioId]);
        if (quota.total >= limiteDiario) throw new AppError('Limite diário de denúncias atingido.', 429);

        const { denunciadoId, snapshot, midia } = await this.alvos.buscar(manager, usuarioId, alvo);
        const evidenciaRef = midia ? await this.evidencias.preservar(id, midia) : undefined;
        try {
          const denuncia = await manager.getRepository(Denuncia).save({
            id,
            denuncianteUsuario: { id: usuarioId },
            denunciadoUsuario: { id: denunciadoId },
            ...alvo,
            campoAlvo: alvo.campoAlvo ?? undefined,
            motivo,
            descricao,
            status: 'pendente',
            evidenciaRef,
            evidenciaSnapshot: midia ? undefined : snapshot,
          });
          return { id, ...alvo, motivo, status: denuncia.status, criadaEm: denuncia.criadaEm, analisadaEm: null };
        } catch (error) {
          if (midia) await this.evidencias.descartar(id, midia);
          throw error;
        }
      });
    } catch (error) {
      const falha = error as { code?: string; constraint?: string };
      if (falha.code === '23505' && falha.constraint === 'denuncias_abertas_unicas')
        throw new AppError('Já existe uma denúncia aberta para este alvo e campo.', 409);
      if (error instanceof AppError) throw error;
      // Erros de persistência podem incluir os parâmetros privados da consulta.
      console.error('Falha ao registrar denúncia', { id, codigo: falha.code });
      throw new AppError('Não foi possível registrar a denúncia.', 500);
    }
  }

  async listarMinhas(usuarioId: string, query: Record<string, unknown>) {
    if (!isUuid(usuarioId)) throw new AppError('Usuário inválido.', 401);
    const page = inteiro(query.page, 1, 100000);
    const size = inteiro(query.size, 15, 50);
    const [usuario] = await AppDataSource.query('SELECT ativo FROM usuarios WHERE id=$1', [usuarioId]);
    if (!usuario?.ativo) throw new AppError('Usuário não encontrado ou inativo.', 401);
    const items = await AppDataSource.query(
      `SELECT ${selecaoPublica} FROM denuncias WHERE denunciante_usuario_id=$1
       ORDER BY criada_em DESC, id DESC LIMIT $2 OFFSET $3`, [usuarioId, size + 1, (page - 1) * size]);
    return { items: items.slice(0, size), page, size, hasMore: items.length > size };
  }
}
