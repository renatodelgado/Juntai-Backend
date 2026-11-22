import { createHash, createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { AppDataSource } from '@shared/database/data-source';
import { AppError } from '@shared/errors/AppError';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function config() {
  const endpoint = process.env.ACS_EMAIL_ENDPOINT;
  const key = process.env.ACS_EMAIL_ACCESS_KEY;
  const sender = process.env.ACS_EMAIL_SENDER;
  const frontend = process.env.PASSWORD_RESET_FRONTEND_URL;
  if (!endpoint || !key || !sender || !frontend)
    throw new AppError('Recuperação de senha temporariamente indisponível.', 503);
  const url = new URL(endpoint);
  const front = new URL(frontend);
  if (url.protocol !== 'https:' || front.protocol !== 'https:' || front.username || front.password || front.search || front.hash)
    throw new Error('Configuração de recuperação inválida');
  return { url, key, sender, front };
}

async function send(email: string, token: string, c: ReturnType<typeof config>) {
  c.front.hash = token;
  const path = '/emails:send?api-version=2023-03-31';
  const body = JSON.stringify({ senderAddress: c.sender, recipients: { to: [{ address: email }] }, content: { subject: 'Redefinição de senha - Juntaí!', plainText: `Para redefinir sua senha, acesse ${c.front.toString()}\nO link expira em 30 minutos. Se você não solicitou, ignore esta mensagem.` } });
  const date = new Date().toUTCString();
  const digest = createHash('sha256').update(body).digest('base64');
  const signature = createHmac('sha256', Buffer.from(c.key, 'base64')).update(`POST\n${path}\n${date};${c.url.host};${digest}`).digest('base64');
  const response = await fetch(new URL(path, c.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ms-date': date, 'x-ms-content-sha256': digest, Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}` }, body, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`ACS email rejected request (${response.status})`);
}

export async function requestPasswordRecovery(value: unknown): Promise<void> {
  if (typeof value !== 'string' || value.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))
    throw new AppError('Informe um e-mail válido.', 400);
  const settings = config();
  // Match the response floor for existing and nonexistent accounts; ACS times out after 10 s.
  const started = Date.now();
  const email = value.trim().toLowerCase();
  const token = randomBytes(32).toString('hex');
  const user = await AppDataSource.transaction(async (manager) => {
    const rows = await manager.query('SELECT id FROM usuarios WHERE lower(email) = $1 AND ativo = true FOR UPDATE', [email]);
    if (!rows.length) return null;
    const recent = await manager.query("SELECT 1 FROM password_recovery_tokens WHERE user_id = $1 AND created_at > now() - interval '1 minute'", [rows[0].id]);
    if (recent.length) return null;
    await manager.query('DELETE FROM password_recovery_tokens WHERE user_id = $1 OR expires_at < now()', [rows[0].id]);
    await manager.query("INSERT INTO password_recovery_tokens(token_hash,user_id,expires_at) VALUES ($1,$2,now() + interval '30 minutes')", [hash(token), rows[0].id]);
    return rows[0].id;
  });
  if (user) {
    try { await send(email, token, settings); }
    catch { console.error('Falha ao solicitar envio de recuperação via ACS.'); }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, 11000 - (Date.now() - started))));
}

export async function resetPassword(token: unknown, password: unknown): Promise<void> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72)
    throw new AppError('Link inválido ou senha fora dos requisitos.', 400);
  const passwordHash = await bcrypt.hash(password, 10);
  const changed = await AppDataSource.transaction(async (manager) => {
    const rows = await manager.query('WITH consumed AS (DELETE FROM password_recovery_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id) SELECT user_id FROM consumed', [hash(token)]);
    if (!rows.length) return false;
    const users = await manager.query('WITH updated AS (UPDATE usuarios SET senha_hash = $1, session_version = session_version + 1, atualizado_em = now() WHERE id = $2 AND ativo = true RETURNING id) SELECT id FROM updated', [passwordHash, rows[0].user_id]);
    await manager.query('DELETE FROM password_recovery_tokens WHERE user_id = $1', [rows[0].user_id]);
    return users.length > 0;
  });
  if (!changed) throw new AppError('Link inválido ou expirado.', 400);
}
