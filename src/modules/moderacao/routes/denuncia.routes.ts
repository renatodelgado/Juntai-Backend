import { Router } from 'express';
import { ensureAuthenticated } from '@shared/middlewares/ensureAuthenticated';
import { handleControllerError } from '@shared/http/handleControllerError';
import { DenunciaService } from '../services/DenunciaService';

export const denunciaRoutes = Router();
const service = new DenunciaService();
const tentativas = new Map<string, { total: number; expiraEm: number }>();
const janela = 10 * 60 * 1000;
const limite = 30;
let limparEm = 0;

denunciaRoutes.post('/denuncias', ensureAuthenticated, async (req, res) => {
  const agora = Date.now();
  if (agora >= limparEm) {
    for (const [id, registro] of tentativas)
      if (registro.expiraEm <= agora) tentativas.delete(id);
    limparEm = agora + janela;
  }
  const id = req.user!.id;
  const anterior = tentativas.get(id);
  const registro = anterior && anterior.expiraEm > agora ? anterior : { total: 0, expiraEm: agora + janela };
  if (++registro.total > limite) {
    res.set('Retry-After', String(Math.ceil((registro.expiraEm - agora) / 1000)));
    return res.status(429).json({ message: 'Limite de tentativas atingido. Tente novamente mais tarde.' });
  }
  tentativas.set(id, registro);
  try {
    res.set('Cache-Control', 'no-store');
    return res.status(201).json(await service.criar(id, req.body));
  } catch (error) {
    return handleControllerError(res, error);
  }
});

denunciaRoutes.get('/minhas-denuncias', ensureAuthenticated, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json(await service.listarMinhas(req.user!.id, req.query));
  } catch (error) {
    return handleControllerError(res, error);
  }
});
