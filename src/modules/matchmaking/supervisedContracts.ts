import { AppError } from '@shared/errors/AppError';
import { DisponibilidadeInvestidor, MetricaCrescimento, PeriodoComparacao, PerfilRisco, Regiao, Segmento } from '@shared/enums';
import { Profile, investorFeatures, startupFeatures, project, validateRulesRequest } from './contracts';

export class SupervisedContractError extends AppError {
  constructor() { super('Contrato supervisionado inválido ou inconsistente.', 502); }
}
const invalid = (): never => { throw new SupervisedContractError(); };
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: any, max = 2000) => typeof v === 'string' && v.length > 0 && v.length <= max;
const strings = (v: any) => Array.isArray(v) && v.length <= 100 && v.every(s => text(s));
export const supervisedInvestorFeatures = [...investorFeatures, 'estado'];
export const supervisedStartupFeatures = [...startupFeatures, 'estado'];
export function supervisedProfile(profile: Profile, investor: boolean) {
  return { ...project(profile, investor ? supervisedInvestorFeatures : supervisedStartupFeatures), usuario: { id: profile.usuario.id, ativo: profile.usuario.ativo } };
}
export function validateSupervisedRequest(payload: Profile) {
  try { validateRulesRequest(payload); } catch { invalid(); }
  if (!payload.startups.length || Object.keys(payload).some(k => !['investidor','startups','limite'].includes(k))) invalid();
  for (const [investor, profiles, keys] of [[true, [payload.investidor], supervisedInvestorFeatures], [false, payload.startups, supervisedStartupFeatures]] as const) {
    for (const p of profiles) {
      if (Object.keys(p).some(k => ![...keys, 'id', 'usuario'].includes(k)) || Object.keys(p.usuario).some(k => !['id','ativo'].includes(k)) || p.usuario.ativo !== true || (!investor && p.statusModeracao !== 'aprovado')) invalid();
      const money = (v: any, growth = false) => (typeof v === 'number' || typeof v === 'string') && Number.isFinite(Number(v)) && (growth ? /^-?\d{1,4}(\.\d{1,2})?$/.test(String(v)) : /^\d{1,12}(\.\d{1,2})?$/.test(String(v)));
      for (const k of ['ticketMinimo','ticketMaximo','capitalProcurado','faturamentoMensal']) if (k in p && !money(p[k])) invalid();
      if ('taxaCrescimentoPct' in p && !money(p.taxaCrescimentoPct, true)) invalid();
      for (const k of ['anosExperiencia','numeroAproximadoInvestimentos','tamanhoEquipe','numeroClientes']) if (k in p && (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > (k === 'numeroClientes' ? 2147483647 : 32767))) invalid();
      if (p.ticketMinimo != null && p.ticketMaximo != null && Number(p.ticketMinimo) > Number(p.ticketMaximo)) invalid();
      for (const [k, values] of Object.entries({ perfilRisco: PerfilRisco, disponibilidade: DisponibilidadeInvestidor, metricaCrescimento: MetricaCrescimento, periodoComparacaoCrescimento: PeriodoComparacao })) if (k in p && !Object.values(values).includes(p[k])) invalid();
      for (const k of ['buscaInvestimento','jaAtuouComStartups']) if (k in p && typeof p[k] !== 'boolean') invalid();
      for (const [k, values] of Object.entries({ setoresAtuacao: Segmento, regioesCrescimento: Regiao })) if (k in p && (!Array.isArray(p[k]) || !p[k].every((v: any) => Object.values(values).includes(v)))) invalid();
      if ('estado' in p && (typeof p.estado !== 'string' || !/^[A-Z]{2}$/.test(p.estado))) invalid();
    }
  }
}
export function validateSupervisedResponse(result: Profile, payload: Profile) {
  if (!object(result) || result.investidorId !== payload.investidor.id || result.modelo !== 'xgboost' || !text(result.versaoModelo, 100) || result.versaoContrato !== 'supervised-v1' || result.versaoFeatures !== 'profiles-rules-v1' || result.versaoTarget !== 'first-interest-v1' || result.experimental !== true || result.origemTreinamento !== 'sintetica' || result.janelaInteresseDias !== 30 || !strings(result.avisos) || !Array.isArray(result.excluidas) || result.excluidas.length !== 0 || !Array.isArray(result.recomendacoes) || result.recomendacoes.length !== Math.min(payload.limite,payload.startups.length)) invalid();
  const allowed = new Set(payload.startups.map((s: Profile) => s.id));
  const seen = new Set();
  let previous: Profile | null = null;
  for (const [index, r] of result.recomendacoes.entries()) {
    if (!object(r) || !allowed.has(r.startupId) || seen.has(r.startupId) || r.posicao !== index + 1 || typeof r.probabilidadeInteresse !== 'number' || !Number.isFinite(r.probabilidadeInteresse) || r.probabilidadeInteresse < 0 || r.probabilidadeInteresse > 1 || !strings(r.avisos)) invalid();
    for (const k of ['modelo','versaoModelo','versaoContrato','versaoFeatures','versaoTarget']) if (r[k] !== result[k]) invalid();
    if (previous && (previous.probabilidadeInteresse < r.probabilidadeInteresse || (previous.probabilidadeInteresse === r.probabilidadeInteresse && previous.startupId > r.startupId))) invalid();
    previous = r; seen.add(r.startupId);
  }
}
export function projectSupervisedResponse(result: Profile): Profile {
  const keys = ['modelo','versaoModelo','versaoContrato','versaoFeatures','versaoTarget'];
  return { ...Object.fromEntries(keys.map(k => [k,result[k]])), investidorId: result.investidorId,
    experimental: true, origemTreinamento: 'sintetica', janelaInteresseDias: 30, avisos: result.avisos,
    recomendacoes: result.recomendacoes.map((r: Profile) => Object.fromEntries([...keys,'startupId','posicao','probabilidadeInteresse','avisos'].map(k => [k,r[k]]))) };
}
