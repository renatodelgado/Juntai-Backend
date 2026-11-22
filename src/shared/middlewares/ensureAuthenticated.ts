import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authConfig } from '@shared/config/auth';
import { AppDataSource } from '@shared/database/data-source';
import { TipoPerfil } from '@shared/enums';

interface TokenPayload {
  sub: string;
  tipoPerfil: TipoPerfil;
  sessionVersion?: number;
}

export async function ensureAuthenticated(req: Request, res: Response, next: NextFunction): Promise<void> {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ message: 'Token não informado ou inválido.' });
    return;
  }
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, authConfig.secret) as unknown as TokenPayload;
    if (typeof payload.sub !== 'string' || !Object.values(TipoPerfil).includes(payload.tipoPerfil) ||
      (payload.sessionVersion !== undefined && (!Number.isSafeInteger(payload.sessionVersion) || payload.sessionVersion < 0)))
      throw new Error('Invalid token payload');
  } catch {
    res.status(401).json({ message: 'Token inválido ou expirado.' });
    return;
  }
  try {
    const rows: { tipo_perfil: TipoPerfil; session_version: number; ativo: boolean }[] = await AppDataSource.query(
      'SELECT tipo_perfil, session_version, ativo FROM usuarios WHERE id::text = $1', [payload.sub],
    );
    const account = rows[0];
    if (!account?.ativo || account.tipo_perfil !== payload.tipoPerfil || account.session_version !== (payload.sessionVersion ?? 0)) {
      res.status(401).json({ message: 'Sessão inválida ou expirada.' });
      return;
    }
    req.user = { id: payload.sub, tipoPerfil: account.tipo_perfil };
    next();
  } catch {
    res.status(503).json({ message: 'Não foi possível validar a sessão. Tente novamente.' });
  }
}
