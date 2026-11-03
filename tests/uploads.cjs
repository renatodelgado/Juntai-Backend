const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const express = require(path.join(root, 'node_modules/express'));
const jwt = require(path.join(root, 'node_modules/jsonwebtoken'));
const updates = [], destroyed = [];
let owner = true, failSave = false, providerError = null;
const repo = { findOne: async options => { assert.deepEqual(options.select, { id: true }); return owner ? { id: 'startup-test' } : null; },
  update: async (id, data) => { if (failSave) throw new Error('DB error'); updates.push({ id, data }); } };
const cloud = { config() {}, uploader: {
  upload_stream: (options, callback) => ({ end: () => providerError ? callback(providerError) : callback(null, { public_id: options.public_id, secure_url: 'https://res.cloudinary.com/test/' + options.public_id }) }),
  destroy: async id => destroyed.push(id),
} };
function load(relative) {
  const file = path.join(root, 'src', relative);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)((name) => {
    if (name === 'express') return express;
    if (name === 'jsonwebtoken') return jwt;
    if (name === 'cloudinary') return { v2: cloud };
    if (name === '@shared/config/auth') return { authConfig: { secret: 'test-only-secret' } };
    if (name === '@shared/database/data-source') return { AppDataSource: { getRepository: () => repo } };
    if (name === '@modules/startups/entities/Startup') return { Startup: class Startup {} };
    if (name.startsWith('@shared/')) return load(name.replace('@shared/', 'shared/') + (name.endsWith('/enums') ? '/index.ts' : '.ts'));
    return require(name);
  }, module, module.exports);
  return module.exports;
}
process.env.CLOUDINARY_URL = 'cloudinary://test:test@test';
const app = express(); app.use('/uploads', load('modules/uploads/routes/upload.routes.ts').uploadRoutes);
(async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/uploads/startup/';
  const token = jwt.sign({ tipoPerfil: 'startup' }, 'test-only-secret', { subject: 'user-test', expiresIn: '1h' });
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'image/png' };
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  try {
    assert.equal((await fetch(base+'logo', { method: 'POST', body: png })).status, 401);
    assert.equal((await fetch(base+'logo', { method: 'POST', headers: { ...headers, Authorization: 'Bearer invalid' }, body: png })).status, 401);
    const investor = jwt.sign({ tipoPerfil: 'investidor' }, 'test-only-secret', { subject: 'other' });
    assert.equal((await fetch(base+'logo', { method: 'POST', headers: { ...headers, Authorization: 'Bearer '+investor }, body: png })).status, 403);
    owner = false;
    assert.equal((await fetch(base+'logo', { method: 'POST', headers, body: png })).status, 403);
    owner = true;
    assert.equal((await fetch(base+'logo', { method: 'POST', headers, body: 'fake' })).status, 415);
    assert.equal((await fetch(base+'logo', { method: 'POST', headers, body: Buffer.alloc(2*1024*1024+1) })).status, 413);
    assert.equal((await fetch(base+'logo', { method: 'POST', headers, body: png })).status, 201);
    assert.ok(updates[0].data.logoUrl.startsWith('https://'));
    const pdfHeaders = { ...headers, 'Content-Type': 'application/pdf', 'X-File-Name': 'pitch.pdf' };
    assert.equal((await fetch(base+'apresentacao', { method: 'POST', headers: pdfHeaders, body: '%PDF-1.4' })).status, 201);
    assert.ok(updates[1].data.apresentacaoUrl.endsWith('.pdf'));
    assert.equal((await fetch(base+'apresentacao', { method: 'POST', headers: pdfHeaders, body: 'fake' })).status, 415);
    providerError = { http_code: 499, name: 'TimeoutError' };
    const temporary = await fetch(base+'apresentacao', { method: 'POST', headers: pdfHeaders, body: '%PDF-1.4' });
    assert.equal(temporary.status, 502);
    assert.equal((await temporary.json()).retryable, true);
    providerError = { http_code: 401 };
    const permanent = await fetch(base+'apresentacao', { method: 'POST', headers: pdfHeaders, body: '%PDF-1.4' });
    assert.equal(permanent.status, 502);
    assert.equal((await permanent.json()).retryable, false);
    providerError = null;
    failSave = true;
    const databaseFailure = await fetch(base+'logo', { method: 'POST', headers, body: png });
    assert.equal(databaseFailure.status, 500);
    assert.equal((await databaseFailure.json()).code, 'UPLOAD_DATABASE_FAILED');
    assert.equal(destroyed.length, 1);
    console.log('Backend: autenticacao, papel, propriedade, formatos, limite, URLs e limpeza verificados.');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
