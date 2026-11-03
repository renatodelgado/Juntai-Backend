import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import { Segmento, Estagio, Regiao, ModeloNegocio, AreaAjuda, NecessidadeAdicional, TipoInvestidor, StatusModeracao } from '@shared/enums';

export type Profile = Record<string, any>;
const investorKeys = ['tipoInvestidor', 'segmentosInteresse', 'estagiosInteresse', 'regioesInteresse', 'modelosInteresse', 'areasAjuda'];
const startupKeys = ['statusModeracao', 'segmento', 'segmentosSecundarios', 'estagio', 'regioesAtuacao', 'modeloNegocio', 'necessidadesAdicionais'];
export const investorFeatures = [...investorKeys, 'perfilRisco', 'ticketMinimo', 'ticketMaximo', 'jaAtuouComStartups', 'numeroAproximadoInvestimentos', 'anosExperiencia', 'setoresAtuacao', 'disponibilidade'];
export const startupFeatures = [...startupKeys, 'capitalProcurado', 'faturamentoMensal', 'numeroClientes', 'tamanhoEquipe', 'taxaCrescimentoPct', 'metricaCrescimento', 'periodoComparacaoCrescimento', 'buscaInvestimento', 'regioesCrescimento'];
export function project(profile: Profile, keys: string[]) {
  return Object.fromEntries(['id', ...keys].filter(k => profile[k] != null).map(k => [k, profile[k]]));
}
export function rulesProfile(profile: Profile, investor: boolean) {
  return { ...project(profile, investor ? investorKeys : startupKeys), usuario: { id: profile.usuario.id, ativo: profile.usuario.ativo } };
}
function invalid(): never { throw new AppError('Dados de recomendação inválidos.', 502); }
function object(v: any): boolean { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function unit(v: any): boolean { return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1); }
export function validateRulesRequest(payload: Profile): void {
  if (!object(payload) || !Array.isArray(payload.startups) || payload.startups.length > 10000 || !Number.isInteger(payload.limite) || payload.limite < 1 || payload.limite > 1000) invalid();
  const arrays: Record<string, object> = { segmentosInteresse: Segmento, estagiosInteresse: Estagio, regioesInteresse: Regiao, modelosInteresse: ModeloNegocio, areasAjuda: AreaAjuda, segmentosSecundarios: Segmento, regioesAtuacao: Regiao, necessidadesAdicionais: NecessidadeAdicional };
  for (const p of [payload.investidor, ...payload.startups]) {
    if (!object(p) || !isUuid(p.id) || !object(p.usuario) || !isUuid(p.usuario.id) || typeof p.usuario.ativo !== 'boolean' || p.id === p.usuario.id) invalid();
    for (const [key, values] of Object.entries(arrays)) if (key in p && (!Array.isArray(p[key]) || !p[key].every((v: any) => Object.values(values).includes(v)))) invalid();
    for (const [key, values] of Object.entries({ tipoInvestidor: TipoInvestidor, segmento: Segmento, estagio: Estagio, modeloNegocio: ModeloNegocio, statusModeracao: StatusModeracao })) if (key in p && !Object.values(values).includes(p[key])) invalid();
  }
  if (new Set(payload.startups.map((s: Profile) => s.id)).size !== payload.startups.length) invalid();
}
export function validateRulesResponse(value: any, payload: Profile): void {
  if (!object(value) || value.investidorId !== payload.investidor.id || typeof value.versaoAlgoritmo !== 'string' || !value.versaoAlgoritmo || value.versaoAlgoritmo.length > 100 || !Array.isArray(value.recomendacoes) || value.recomendacoes.length > payload.limite || !Array.isArray(value.excluidas)) invalid();
  const allowed = new Set(payload.startups.map((s: Profile) => s.id));
  const seen = new Set();
  const criteria = ['segmento', 'estagio', 'regiao', 'modelo', 'ajuda'];
  if (!object(value.pesos) || Object.keys(value.pesos).length !== 5 || !criteria.every(k => typeof value.pesos[k] === 'number' && Number.isFinite(value.pesos[k]) && value.pesos[k] > 0)) invalid();
  for (const [index, r] of value.recomendacoes.entries()) {
    if (!object(r) || !allowed.has(r.startupId) || seen.has(r.startupId) || r.posicao !== index + 1 || !unit(r.score) || !unit(r.scoreRanking) || r.cobertura === null || !unit(r.cobertura) || !object(r.criterios) || Object.keys(r.criterios).length !== 5 || !Array.isArray(r.avisos) || !r.avisos.every((v: any) => typeof v === 'string') || !Array.isArray(r.justificativas) || !Number.isInteger(r.criteriosAvaliados) || r.criteriosAvaliados < 0 || r.criteriosAvaliados > 5) invalid();
    if (!object(r.elegibilidade) || r.elegibilidade.estado !== 'elegivel') invalid();
    for (const key of ['verificadas', 'impedimentos', 'pendencias']) if (!Array.isArray(r.elegibilidade[key]) || !r.elegibilidade[key].every((v: any) => typeof v === 'string')) invalid();
    for (const j of r.justificativas) if (!object(j) || !criteria.includes(j.criterio) || typeof j.descricao !== 'string' || !Array.isArray(j.evidencias) || !j.evidencias.every((v: any) => typeof v === 'string')) invalid();
    for (const k of criteria) {
      const c = r.criterios[k];
      if (!object(c) || !['compativel', 'parcial', 'incompativel', 'insuficiente'].includes(c.estado) || !unit(c.score) || c.cobertura === null || !unit(c.cobertura) || typeof c.avaliacaoParcial !== 'boolean' || !Array.isArray(c.evidencias) || !c.evidencias.every((v: any) => typeof v === 'string')) invalid();
    }
    seen.add(r.startupId);
  }
  for (const r of value.excluidas) if (!object(r) || !allowed.has(r.startupId) || seen.has(r.startupId)) invalid(); else seen.add(r.startupId);
}
