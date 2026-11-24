import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authConfig } from '@shared/config/auth';
import { TipoPerfil } from '@shared/enums';
import { isUuid } from '@shared/validation/isUuid';
import { handleControllerError } from '@shared/http/handleControllerError';
import { sancoesService } from '@modules/moderacao/services/SancaoService';

interface TokenPayload {
  sub: string;
  tipoPerfil: TipoPerfil;
}

export function ensureValidToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ message: 'Token não informado.' });
    return;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ message: 'Formato do token inválido. Use: Bearer <token>.' });
    return;
  }

  try {
    const { sub, tipoPerfil } = jwt.verify(token, authConfig.secret) as unknown as TokenPayload;
    if (typeof sub !== 'string' || !isUuid(sub) || !Object.values(TipoPerfil).includes(tipoPerfil))
      throw new Error('Identidade inválida.');
    req.user = { id: sub, tipoPerfil };
  } catch {
    res.status(401).json({ message: 'Token inválido ou expirado.' });
    return;
  }
  next();
}

export function ensureAuthenticated(req: Request, res: Response, next: NextFunction): void {
  ensureValidToken(req, res, () => {
    void sancoesService.verificarAcesso(req.user!.id).then(
      () => next(),
      error => handleControllerError(res, error),
    );
  });
}
