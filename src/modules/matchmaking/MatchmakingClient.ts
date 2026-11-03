import { AppError } from '@shared/errors/AppError';
import { Profile, validateRulesRequest, validateRulesResponse } from './contracts';
import { projectSupervisedResponse, SupervisedContractError, validateSupervisedRequest, validateSupervisedResponse } from './supervisedContracts';

export class MatchmakingClient {
  constructor(private transport: typeof fetch = fetch) {}
  async rules(payload: Profile) {
    validateRulesRequest(payload);
    const result = await this.post('/match/rules', payload);
    validateRulesResponse(result, payload);
    return { investidorId: result.investidorId, versaoAlgoritmo: result.versaoAlgoritmo,
      pesos: result.pesos, tipoInvestidor: result.tipoInvestidor, excluidas: result.excluidas,
      recomendacoes: result.recomendacoes.map((r: Profile) => projectResult(r)) };
  }
  async supervised(payload: Profile) {
    validateSupervisedRequest(payload);
    let result;
    try { result = await this.post('/match/supervised', payload); }
    catch (error) {
      if (error instanceof AppError && error.statusCode === 502) throw new SupervisedContractError();
      throw error;
    }
    validateSupervisedResponse(result, payload);
    return projectSupervisedResponse(result);
  }
  private async post(endpoint: string, payload: Profile) {
    let base: URL;
    try { base = new URL(process.env.MATCHMAKING_API_URL || 'http://127.0.0.1:8000'); }
    catch { throw new AppError('Serviço de recomendação indisponível.', 503); }
    const timeout = Number(process.env.MATCHMAKING_TIMEOUT_MS || 5000);
    if (!['http:', 'https:'].includes(base.protocol) || !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new AppError('Serviço de recomendação indisponível.', 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.transport(new URL(endpoint, base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) throw new AppError('Serviço de recomendação indisponível.', response.status >= 500 || (endpoint === '/match/supervised' && response.status === 404) ? 503 : 502);
      let result;
      try { result = await response.json(); }
      catch { throw new AppError('Resposta inválida do recomendador.', controller.signal.aborted ? 504 : 502); }
      // Nunca propagar propriedades extras de um serviço interno ao navegador.
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Serviço de recomendação indisponível.', controller.signal.aborted ? 504 : 503);
    } finally { clearTimeout(timer); }
  }
}

function projectResult(r: Profile) {
  const select = (value: Profile, fields: string[]) => Object.fromEntries(fields.filter(k => k in value).map(k => [k, value[k]]));
  return {
    ...select(r, ['startupId', 'posicao', 'score', 'scoreRanking', 'cobertura', 'criteriosAvaliados', 'avisos']),
    criterios: Object.fromEntries(['segmento', 'estagio', 'regiao', 'modelo', 'ajuda'].map(k => [k, select(r.criterios[k], ['estado', 'score', 'cobertura', 'avaliacaoParcial', 'evidencias', 'aviso'])])),
    justificativas: r.justificativas.map((j: Profile) => select(j, ['criterio', 'descricao', 'evidencias'])),
    elegibilidade: select(r.elegibilidade, ['estado', 'verificadas', 'impedimentos', 'pendencias']),
  };
}
