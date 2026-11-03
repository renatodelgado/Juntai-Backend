import { Router, raw, type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { ensureAuthenticated } from '@shared/middlewares/ensureAuthenticated';
import { ensureRole } from '@shared/middlewares/ensureRole';
import { TipoPerfil } from '@shared/enums';
import { AppDataSource } from '@shared/database/data-source';
import { Startup } from '@modules/startups/entities/Startup';

export const uploadRoutes = Router();
const requests = new Map<string, { count: number; expires: number }>();
uploadRoutes.post('/startup/:kind', ensureAuthenticated, ensureRole(TipoPerfil.STARTUP), (req, res, next) => {
  const now = Date.now();
  for (const [key, value] of requests) if (value.expires < now) requests.delete(key);
  const key = req.user!.id;
  const current = requests.get(key) ?? { count: 0, expires: now + 600000 };
  if (++current.count > 20) return res.status(429).json({ message: 'Upload limit reached. Try again later.' });
  requests.set(key, current);
  next();
}, raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const kind = req.params.kind;
  const file = req.body;
  if (!['logo', 'apresentacao'].includes(String(kind)) || !Buffer.isBuffer(file) || !file.length)
    return res.status(400).json({ message: 'Invalid upload.' });
  const mime = req.get('content-type')?.split(';')[0];
  let extension = '';
  if (kind === 'logo') {
    if (file.length > 2 * 1024 * 1024) return res.status(413).json({ message: 'Logo must be at most 2 MB.' });
    if (mime === 'image/png' && file.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) extension = 'png';
    if (mime === 'image/jpeg' && file.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) extension = 'jpg';
    if (mime === 'image/webp' && file.toString('ascii', 0, 4) === 'RIFF' && file.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  } else {
    const name = req.get('x-file-name') ?? '';
    if (/\.pdf$/i.test(name) && file.toString('ascii', 0, 5) === '%PDF-') extension = 'pdf';
    if (/\.ppt$/i.test(name) && file.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) extension = 'ppt';
    if (/\.pptx$/i.test(name) && file.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) && file.includes(Buffer.from('ppt/presentation.xml'))) extension = 'pptx';
  }
  if (!extension) return res.status(415).json({ message: 'Unsupported file. Use PNG, JPG, WebP for logos or PDF, PPT, PPTX for presentations.' });
  if (!process.env.CLOUDINARY_URL) return res.status(503).json({ message: 'Upload service is not configured.' });
  cloudinary.config({ secure: true });
  let uploaded: { public_id: string; resource_type: 'image' | 'raw' } | undefined;
  let stage: 'database' | 'provider' = 'database';
  try {
    const repo = AppDataSource.getRepository(Startup);
    const startup = await repo.findOne({ select: { id: true }, where: { usuario: { id: req.user!.id, ativo: true } } });
    if (!startup) return res.status(403).json({ message: 'Startup not found or inactive.' });
    stage = 'provider';
    const url = await new Promise<string>((resolve, reject) => {
      cloudinary.uploader.upload_stream({
        resource_type: kind === 'logo' ? 'image' : 'raw',
        public_id: 'juntai/startups/' + kind + '/' + randomUUID() + (kind === 'logo' ? '' : '.' + extension),
        overwrite: false,
      }, (error, result) => {
        if (error || !result?.secure_url) reject(error ?? new Error('Upload failed'));
        else { uploaded = { public_id: result.public_id, resource_type: kind === 'logo' ? 'image' : 'raw' }; resolve(result.secure_url); }
      }).end(file);
    });
    stage = 'database';
    await repo.update(startup.id, kind === 'logo' ? { logoUrl: url } : { apresentacaoUrl: url });
    return res.status(201).json({ url });
  } catch (error) {
    const failure = error as { code?: string; http_code?: number; name?: string };
    console.error('Startup upload failed', { stage, code: failure?.code, httpCode: failure?.http_code, name: failure?.name });
    if (uploaded) await cloudinary.uploader.destroy(uploaded.public_id, { resource_type: uploaded.resource_type }).catch(() => {});
    if (stage === 'database')
      return res.status(500).json({ code: 'UPLOAD_DATABASE_FAILED', retryable: false, message: 'Não foi possível salvar a apresentação ou o logo no banco.' });
    const retryable = ![400, 401, 403].includes(failure?.http_code ?? 0);
    return res.status(502).json({ code: 'UPLOAD_PROVIDER_FAILED', retryable, message: retryable ? 'O serviço de upload falhou temporariamente. Tente novamente.' : 'O serviço de upload recusou o envio. Confira a configuração do backend.' });
  }
});
const uploadError: ErrorRequestHandler = (error, _req, res, _next) => {
  return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ message: 'Invalid file or file larger than 10 MB.' });
};
uploadRoutes.use(uploadError);
