import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '@shared/database/data-source';
import { authConfig } from '@shared/config/auth';

// Azure ingress appends the direct sender as the rightmost forwarded address.
// Enable the ingress option only when direct access to the container is prohibited.
export async function recoveryRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const forwarded = req.header('x-forwarded-for')?.split(',').pop()?.trim();
    const address = process.env.RECOVERY_TRUST_AZURE_INGRESS === 'true' && forwarded && isIP(forwarded)
      ? forwarded : req.socket.remoteAddress || 'unknown';
    const key = createHmac('sha256', authConfig.secret).update(address).digest('hex');
    const rows: { attempts: number }[] = await AppDataSource.query(`
      INSERT INTO password_recovery_limits (key_hash, window_start, attempts)
      VALUES ($1, now(), 1)
      ON CONFLICT (key_hash) DO UPDATE SET
        attempts = CASE WHEN password_recovery_limits.window_start < now() - interval '15 minutes' THEN 1 ELSE password_recovery_limits.attempts + 1 END,
        window_start = CASE WHEN password_recovery_limits.window_start < now() - interval '15 minutes' THEN now() ELSE password_recovery_limits.window_start END
      RETURNING attempts`, [key]);
    if (rows[0].attempts > 20) {
      res.status(429).json({ message: 'Muitas tentativas. Aguarde e tente novamente.' });
      return;
    }
    next();
  } catch {
    res.status(503).json({ message: 'Serviço temporariamente indisponível.' });
  }
}
