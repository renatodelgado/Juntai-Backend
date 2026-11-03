import { AppDataSource } from '@shared/database/data-source';
import { Investidor } from '@modules/investidores/entities/Investidor';
import { Startup } from '@modules/startups/entities/Startup';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import { EntityManager } from 'typeorm';
import { createHash } from 'crypto';
import { MatchmakingClient } from './MatchmakingClient';
import { Context, issueContext, readContext } from './ExposureContext';
import { investorFeatures, startupFeatures, project, rulesProfile, Profile } from './contracts';
import { SupervisedContractError, supervisedInvestorFeatures, supervisedStartupFeatures, supervisedProfile } from './supervisedContracts';

export function profileRevision(profile: Profile, investor: boolean, supervised = false): string {
  const keys = supervised ? (investor ? supervisedInvestorFeatures : supervisedStartupFeatures) : (investor ? investorFeatures : startupFeatures);
  return createHash('sha256').update(JSON.stringify({ updated: profile.atualizadoEm.toISOString(), features: project(profile, keys) })).digest('hex');
}

export class MatchmakingService {
  constructor(private db = AppDataSource, private client = new MatchmakingClient()) {}
  async actor(userId: string, manager: EntityManager = this.db.manager, lock = false) {
    if (!isUuid(userId)) throw new AppError('Usuário inválido.', 401);
    const query = manager.getRepository(Investidor).createQueryBuilder('i').innerJoinAndSelect('i.usuario', 'u').where('u.id = :userId', { userId });
    if (lock) query.setLock('pessimistic_read');
    const investor = await query.getOne();
    if (!investor || !investor.usuario.ativo || investor.usuario.tipoPerfil !== 'investidor' || investor.statusModeracao !== 'aprovado') throw new AppError('Somente investidores aprovados podem acessar recomendações.', 403);
    return investor;
  }
  private context(i: Investidor, s: Startup, origin: Context['origin'], position: number | null, version: string | null) {
    return issueContext({ investorId: i.id, startupId: s.id, investorRevision: profileRevision(i, true, origin === 'supervised'), startupRevision: profileRevision(s, false, origin === 'supervised'), origin, position, version });
  }
  async recommend(userId: string, limit: number) {
    const investor = await this.actor(userId);
    const startups = await this.db.getRepository(Startup).createQueryBuilder('s').innerJoinAndSelect('s.usuario', 'u')
      .where('s.statusModeracao = :status AND u.ativo = true', { status: 'aprovado' }).orderBy('s.id', 'ASC').getMany();
    return this.rankCandidates(investor, startups, limit);
  }
  private async rankCandidates(investor: Investidor, startups: Startup[], limit: number) {
    const strategy = process.env.MATCHMAKING_STRATEGY || 'rules';
    if (!['rules','supervised'].includes(strategy)) throw new AppError('Estratégia de recomendação inválida.', 500);
    if (strategy === 'rules') return this.rankRules(investor, startups, limit);
    try { return await this.rankSupervised(investor, startups, limit); }
    catch (error) {
      if (!(error instanceof AppError) || ![503,504].includes(error.statusCode)) {
        console.error({ event: 'matchmaking_supervised_contract_error', status: error instanceof AppError ? error.statusCode : 500 });
        throw error;
      }
      const motivo = error.statusCode === 504 ? 'timeout' : 'indisponibilidade';
      console.warn({ event: 'matchmaking_supervised_fallback', motivo, status: error.statusCode });
      return { ...await this.rankRules(investor, startups, limit), fallback: { de: 'supervised', motivo }, avisos: ['Nível 2 indisponível; recomendações calculadas pelo Nível 1A.'] };
    }
  }
  private async rankSupervised(investor: Investidor, startups: Startup[], limit: number) {
    const candidates = startups.filter(s => s.statusModeracao === 'aprovado' && s.usuario?.ativo === true && s.usuario.id !== s.id && (!s.usuario.tipoPerfil || s.usuario.tipoPerfil === 'startup'));
    const recommendations: Profile[] = [];
    let identity: Profile | null = null;
    const notices = new Set<string>();
    for (let offset = 0; offset < candidates.length; offset += 10000) {
      const result = await this.client.supervised({ investidor: supervisedProfile(investor, true), startups: candidates.slice(offset, offset + 10000).map(s => supervisedProfile(s, false)), limite: limit });
      const current = Object.fromEntries(['modelo','versaoModelo','versaoContrato','versaoFeatures','versaoTarget'].map(k => [k, result[k]]));
      if (identity && JSON.stringify(identity) !== JSON.stringify(current)) throw new SupervisedContractError();
      identity = current;
      result.avisos.forEach((s: string) => notices.add(s));
      recommendations.push(...result.recomendacoes);
    }
    recommendations.sort((a,b) => b.probabilidadeInteresse - a.probabilidadeInteresse || (a.startupId < b.startupId ? -1 : a.startupId > b.startupId ? 1 : 0));
    const byId = new Map(candidates.map(s => [s.id,s]));
    return { investidorId: investor.id, versaoAlgoritmo: identity?.versaoModelo ?? null, ...identity,
      origemRecomendacao: 'supervised', experimental: true, avisos: [...notices],
      recomendacoes: recommendations.slice(0,limit).map((r,index): Profile => ({ ...r, posicao: index+1, posicaoRanking: index+1,
        origemRecomendacao: 'supervised', contextoExposicao: this.context(investor,byId.get(r.startupId)!,'supervised',index+1,identity!.versaoModelo) })) };
  }
  private async rankRules(investor: Investidor, startups: Startup[], limit: number) {
    // /match/rules aceita até 10.000 candidatas. Top L de cada lote basta para o top L global.
    const recommendations: Profile[] = [];
    let version: string | null = null;
    for (let offset = 0; offset < startups.length; offset += 10000) {
      const batch = startups.slice(offset, offset + 10000);
      const result = await this.client.rules({ investidor: rulesProfile(investor, true), startups: batch.map(s => rulesProfile(s, false)), limite: limit });
      if (version !== null && version !== result.versaoAlgoritmo) throw new AppError('Versão do recomendador inconsistente.', 502);
      version = result.versaoAlgoritmo;
      recommendations.push(...result.recomendacoes);
    }
    recommendations.sort((a, b) => Number(a.scoreRanking === null) - Number(b.scoreRanking === null) || (b.scoreRanking ?? 0) - (a.scoreRanking ?? 0) || b.cobertura - a.cobertura || (a.startupId < b.startupId ? -1 : a.startupId > b.startupId ? 1 : 0));
    const byId = new Map(startups.map(s => [s.id, s]));
    return { investidorId: investor.id, versaoAlgoritmo: version, origemRecomendacao: 'rules', recomendacoes: recommendations.slice(0, limit).map((r, index): Profile => ({ ...r, posicao: index + 1, posicaoRanking: index + 1, origemRecomendacao: 'rules', contextoExposicao: this.context(investor, byId.get(r.startupId)!, 'rules', index + 1, version) })) };
  }
  async discovery(userId: string, params: Record<string, string>) {
    const investor = await this.actor(userId);
    const page = integer(params.page ?? '0', 0, 100000);
    const size = integer(params.size ?? '24', 1, 100);
    const query = this.db.getRepository(Startup).createQueryBuilder('s').innerJoin('s.usuario', 'u')
      .where('s.statusModeracao = :status AND u.ativo = true', { status: 'aprovado' });
    for (const [key, column] of Object.entries({ segment: 's.segmento', stage: 's.estagio', model: 's.modelo_negocio' })) if (params[key]) query.andWhere(`${column}::text = :${key}`, { [key]: params[key] });
    if (params.q) query.andWhere("concat_ws(' ',s.nome_fantasia,s.descricao_curta,s.descricao_pitch,s.mercado_alvo) ILIKE :q", { q: '%' + params.q + '%' });
    if (params.location) query.andWhere("concat_ws(' ',s.cidade,s.estado,array_to_string(s.regioes_atuacao, ' ')) ILIKE :location", { location: '%' + params.location + '%' });
    if (params.investment) {
      if (!['yes', 'no'].includes(params.investment)) throw new AppError('Filtro inválido.', 400);
      query.andWhere('s.busca_investimento = :investment', { investment: params.investment === 'yes' });
    }
    for (const key of ['min', 'max']) if (params[key]) {
      if (!/^\d+(\.\d{1,2})?$/.test(params[key]) || Number(params[key]) > 999999999999.99) throw new AppError('Faixa de investimento inválida.', 400);
      query.andWhere(`(s.capital_procurado IS NULL OR s.capital_procurado ${key === 'min' ? '>=' : '<='} :${key})`, { [key]: params[key] });
    }
    if (params.min && params.max && Number(params.min) > Number(params.max)) throw new AppError('Faixa de investimento inválida.', 400);
    if (params.saved) {
      const ids = (params.ids || '').split(',').filter(Boolean);
      if (ids.length > 1000 || ids.some(id => !isUuid(id))) throw new AppError('Filtro inválido.', 400);
      if (!ids.length) query.andWhere('false'); else query.andWhere('s.id IN (:...ids)', { ids });
    }
    const total = await query.getCount();
    let items: Profile[];
    if (params.sort === 'compatibility') {
      const candidates = await query.clone().innerJoinAndSelect('s.usuario', 'rankingUser').getMany();
      const all = await this.rankCandidates(investor, candidates, 1000);
      const permitted = new Map(candidates.map(s => [s.id, s]));
      const ranked = all.recomendacoes.filter(r => permitted.has(r.startupId));
      items = ranked.slice(page * size, (page + 1) * size).map(r => {
        const { usuario, ...publicStartup } = permitted.get(r.startupId)!;
        return { ...publicStartup, compatibility: r.origemRecomendacao === 'rules' && r.score != null ? r.score * 100 : undefined,
          probabilidadeInteresse: r.probabilidadeInteresse, posicaoRanking: r.posicaoRanking, origemRecomendacao: r.origemRecomendacao,
          versaoModelo: r.versaoModelo, avisos: r.avisos, contextoExposicao: r.contextoExposicao };
      });
      return { items, total: ranked.length, hasMore: (page + 1) * size < ranked.length, facets: await this.facets(query),
        origemRecomendacao: all.origemRecomendacao, ...('fallback' in all ? { fallback: all.fallback } : {}), ...('avisos' in all ? { avisos: all.avisos } : {}) };
    }
    const order = params.sort === 'name' ? 's.nomeFantasia' : params.sort === 'investment' ? 's.buscaInvestimento' : 's.criadoEm';
    const found = await query.orderBy(order, params.sort === 'name' ? 'ASC' : 'DESC').addOrderBy('s.id', 'ASC').skip(page * size).take(size).getMany();
    items = found.map(s => {
      const { usuario, ...publicStartup } = s;
      return { ...publicStartup, contextoExposicao: this.context(investor, s, 'discovery', null, null) };
    });
    return { items, total, hasMore: (page + 1) * size < total, facets: await this.facets(query) };
  }
  private async facets(query: any) {
    // Facetas preservam os filtros, mas não precisam da ordenação da listagem.
    const rows = await query.clone().orderBy().select('s.estado', 'estado').addSelect('s.segmento', 'segmento').addSelect('s.regioes_atuacao', 'regioes').distinct(true).getRawMany();
    return { locations: [...new Set(rows.map((r: any) => r.estado).filter(Boolean))].sort(), segments: new Set(rows.map((r: any) => r.segmento)).size, regions: new Set(rows.flatMap((r: any) => r.regioes || [])).size };
  }
  async confirmExposure(userId: string, token: unknown) {
    const context = readContext(token);
    return this.db.transaction(async manager => {
      const investor = await this.actor(userId, manager, true);
      if (investor.id !== context.investorId) throw new AppError('Contexto não pertence ao investidor.', 403);
      // Retry do mesmo contexto devolve a exposição original, sem novos snapshots.
      const [existing] = await manager.query('SELECT id, ocorrido_em FROM exposicoes_startups WHERE id=$1 AND investidor_id=$2', [context.exposureId, investor.id]);
      if (existing) return existing;
      const startup = await manager.getRepository(Startup).createQueryBuilder('s').innerJoinAndSelect('s.usuario', 'u').where('s.id = :id', { id: context.startupId }).setLock('pessimistic_read').getOne();
      if (!startup || !startup.usuario.ativo || startup.statusModeracao !== 'aprovado') throw new AppError('Startup indisponível.', 404);
      const supervised = context.origin === 'supervised';
      if (supervised && startup.usuario.tipoPerfil !== 'startup') throw new AppError('Startup indisponível.', 404);
      if (profileRevision(investor, true, supervised) !== context.investorRevision || profileRevision(startup, false, supervised) !== context.startupRevision) throw new AppError('Perfis alterados. Atualize a descoberta.', 409);
      const snapshot = { investidor: project(investor, supervised ? supervisedInvestorFeatures : investorFeatures), startup: project(startup, supervised ? supervisedStartupFeatures : startupFeatures) };
      const [saved] = await manager.query(`INSERT INTO exposicoes_startups (id,investidor_id,startup_id,origem_recomendacao,posicao_ranking,versao_recomendador,snapshot_perfis)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id,ocorrido_em`,
        [context.exposureId, investor.id, startup.id, context.origin, context.position, context.version, JSON.stringify(snapshot)]);
      if (saved) return saved;
      const [retry] = await manager.query('SELECT id, ocorrido_em FROM exposicoes_startups WHERE id=$1 AND investidor_id=$2', [context.exposureId, investor.id]);
      if (!retry) throw new AppError('Contexto de exposição inválido.', 409);
      return retry;
    });
  }
}
export function integer(value: string, min: number, max: number) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new AppError('Parâmetro numérico inválido.', 400);
  return Number(value);
}
