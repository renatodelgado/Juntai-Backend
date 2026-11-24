import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { authConfig } from '@shared/config/auth';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';

export type Context = { exposureId: string; investorId: string; startupId: string; investorRevision: string; startupRevision: string; origin: 'discovery' | 'rules' | 'supervised'; position: number | null; version: string | null };
export function issueContext(context: Omit<Context, 'exposureId'>) {
  return jwt.sign({ ...context, exposureId: randomUUID() }, authConfig.secret, { algorithm: 'HS256', audience: 'card-exposure', issuer: 'juntai-backend', expiresIn: '15m' });
}
export function readContext(token: unknown): Context {
  try {
    if (typeof token !== 'string' || token.length > 4096) throw new Error();
    const value = jwt.verify(token, authConfig.secret, { algorithms: ['HS256'], audience: 'card-exposure', issuer: 'juntai-backend' }) as Context;
    if (![value.exposureId, value.investorId, value.startupId].every(isUuid) || !['discovery', 'rules', 'supervised'].includes(value.origin) || typeof value.investorRevision !== 'string' || typeof value.startupRevision !== 'string' || !(value.position === null || (Number.isInteger(value.position) && value.position > 0)) || !(value.version === null || (typeof value.version === 'string' && value.version.length <= 100))) throw new Error();
    if (value.origin === 'supervised' && (!value.version || value.position === null)) throw new Error();
    return value;
  } catch { throw new AppError('Contexto de exposição inválido ou expirado.', 400); }
}
