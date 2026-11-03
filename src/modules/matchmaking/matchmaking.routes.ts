import { Router } from 'express';
import { ensureAuthenticated } from '@shared/middlewares/ensureAuthenticated';
import { ensureRole } from '@shared/middlewares/ensureRole';
import { TipoPerfil } from '@shared/enums';
import { handleControllerError } from '@shared/http/handleControllerError';
import { AppError } from '@shared/errors/AppError';
import { integer, MatchmakingService } from './MatchmakingService';

export function matchmakingRoutes(service = new MatchmakingService()) {
  const router = Router();
  const auth = [ensureAuthenticated, ensureRole(TipoPerfil.INVESTIDOR)];
  router.get('/recomendacoes', ...auth, async (req, res) => {
    try {
      if (Object.keys(req.query).some(k => k !== 'limite')) throw new AppError('Parâmetro inválido.', 400);
      res.json(await service.recommend(req.user!.id, integer(String(req.query.limite ?? '24'), 1, 1000)));
    } catch (error) { handleControllerError(res, error); }
  });
  router.get('/discovery', ...auth, async (req, res) => {
    try {
      const allowed = ['page', 'size', 'q', 'segment', 'stage', 'location', 'model', 'investment', 'min', 'max', 'saved', 'ids', 'sort'];
      if (Object.entries(req.query).some(([k, v]) => !allowed.includes(k) || typeof v !== 'string' || v.length > 40000)) throw new AppError('Filtros inválidos.', 400);
      res.json(await service.discovery(req.user!.id, req.query as Record<string, string>));
    } catch (error) { handleControllerError(res, error); }
  });
  router.post('/exposicoes', ...auth, async (req, res) => {
    try {
      if (!req.body || typeof req.body.contexto !== 'string' || Object.keys(req.body).some(k => k !== 'contexto')) throw new AppError('Confirmação de exposição inválida.', 400);
      res.json(await service.confirmExposure(req.user!.id, req.body.contexto));
    } catch (error) { handleControllerError(res, error); }
  });
  return router;
}
