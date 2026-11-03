require("ts-node/register/transpile-only");
require("tsconfig-paths/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { v2: cloudinary } = require("cloudinary");
const { AppDataSource: db } = require("../src/shared/database/data-source");
const { Usuario } = require("../src/modules/usuarios/entities/Usuario");
const {
  Investidor,
} = require("../src/modules/investidores/entities/Investidor");
const { authConfig } = require("../src/shared/config/auth");
test(
  "avatar opcional: upload autenticado, retorno no perfil, remoção e validações",
  { skip: process.env.AVATAR_DB_TEST !== "1", timeout: 120000 },
  async () => {
    assert.equal(db.options.synchronize, false);
    assert.ok(["localhost", "127.0.0.1"].includes(db.options.host));
    await db.initialize();
    const id = randomUUID();
    let server;
    const original = cloudinary.uploader.upload_stream;
    const priorUrl = process.env.CLOUDINARY_URL;
    try {
      const repo = db.getRepository(Usuario);
      await repo.save(
        repo.create({
          id,
          nome: "Fixture avatar",
          email: id + "@avatar-test.invalid",
          senhaHash: "not-a-valid-password-hash",
          tipoPerfil: "investidor",
          ativo: true,
        }),
      );
      await db.getRepository(Investidor).save({
        nome: "Fixture avatar",
        usuario: { id },
        tipoInvestidor: "mentor",
        statusModeracao: "pendente",
      });
      process.env.CLOUDINARY_URL = priorUrl || "cloudinary://test:test@demo";
      cloudinary.uploader.upload_stream = (_options, done) => ({
        end: () =>
          done(null, {
            secure_url:
              "https://res.cloudinary.com/demo/image/upload/avatar-test.png",
            public_id: "avatar-test",
          }),
      });
      const app = require("../src/App").default;
      server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const base = "http://127.0.0.1:" + server.address().port;
      const token = (role) =>
        jwt.sign({ tipoPerfil: role }, authConfig.secret, {
          subject: id,
          expiresIn: "5m",
        });
      async function request(
        path,
        method = "GET",
        body,
        role = "investidor",
        mime = "image/png",
      ) {
        const r = await fetch(base + path, {
          method,
          headers: {
            Authorization: "Bearer " + token(role),
            "Content-Type": mime,
          },
          ...(body ? { body } : {}),
        });
        return {
          status: r.status,
          data: r.status === 204 ? null : await r.json(),
        };
      }
      const path = "/uploads/investidor/avatar";
      const png = Buffer.from("89504e470d0a1a0a", "hex");
      assert.equal((await request("/auth/profile")).data.avatarUrl, null);
      assert.equal((await request(path, "POST", png, "startup")).status, 403);
      assert.equal(
        (await request(path, "POST", Buffer.from("invalid"))).status,
        415,
      );
      assert.equal(
        (await request(path, "POST", Buffer.alloc(2 * 1024 * 1024 + 1))).status,
        413,
      );
      const uploaded = await request(path, "POST", png);
      assert.equal(uploaded.status, 201);
      const profile = await request("/auth/profile");
      assert.equal(profile.data.avatarUrl, uploaded.data.url);
      assert.ok(!JSON.stringify(profile.data).includes("senhaHash"));
      assert.equal((await repo.findOneBy({ id })).avatarUrl, uploaded.data.url);
      assert.equal((await request(path, "DELETE")).status, 204);
      assert.equal((await request("/auth/profile")).data.avatarUrl, null);
      await repo.update(id, { ativo: false });
      assert.equal((await request(path, "POST", png)).status, 403);
    } finally {
      cloudinary.uploader.upload_stream = original;
      if (priorUrl === undefined) delete process.env.CLOUDINARY_URL;
      else process.env.CLOUDINARY_URL = priorUrl;
      if (server) await new Promise((resolve) => server.close(resolve));
      await db.getRepository(Usuario).delete(id);
      await db.destroy();
    }
  },
);
