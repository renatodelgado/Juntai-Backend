import { Router, raw, type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { ensureAuthenticated } from "@shared/middlewares/ensureAuthenticated";
import { ensureRole } from "@shared/middlewares/ensureRole";
import { TipoPerfil } from "@shared/enums";
import { AppDataSource } from "@shared/database/data-source";
import { Usuario } from "@modules/usuarios/entities/Usuario";
import { Investidor } from "@modules/investidores/entities/Investidor";

export const avatarRoutes = Router();
const requests = new Map<string, { count: number; expires: number }>();
const guards = [ensureAuthenticated, ensureRole(TipoPerfil.INVESTIDOR)];
async function owner(id: string) {
  const user = await AppDataSource.getRepository(Usuario).findOne({
    select: { id: true },
    where: { id, ativo: true, tipoPerfil: TipoPerfil.INVESTIDOR },
  });
  const profile =
    user &&
    (await AppDataSource.getRepository(Investidor).findOne({
      select: { id: true },
      where: { usuario: { id } },
    }));
  return Boolean(user && profile);
}
avatarRoutes.post(
  "/investidor/avatar",
  ...guards,
  (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of requests)
      if (value.expires < now) requests.delete(key);
    const current = requests.get(req.user!.id) ?? {
      count: 0,
      expires: now + 600000,
    };
    requests.set(req.user!.id, current);
    if (++current.count > 20)
      return res.status(429).json({
        message: "Limite de uploads atingido. Tente novamente mais tarde.",
      });
    next();
  },
  raw({ type: "*/*", limit: "2mb" }),
  async (req, res) => {
    const file = req.body;
    const mime = req.get("content-type")?.split(";")[0];
    if (!Buffer.isBuffer(file) || !file.length)
      return res.status(400).json({ message: "Selecione uma foto." });
    const valid =
      (mime === "image/png" &&
        file.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
      (mime === "image/jpeg" &&
        file.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) ||
      (mime === "image/webp" &&
        file.toString("ascii", 0, 4) === "RIFF" &&
        file.toString("ascii", 8, 12) === "WEBP");
    if (!valid)
      return res
        .status(415)
        .json({ message: "Use uma foto PNG, JPG ou WebP de até 2 MB." });
    let publicId: string | undefined;
    try {
      if (!(await owner(req.user!.id)))
        return res
          .status(403)
          .json({ message: "Perfil de investidor não encontrado ou inativo." });
      if (!process.env.CLOUDINARY_URL)
        return res
          .status(503)
          .json({ message: "Serviço de upload não configurado." });
      cloudinary.config({ secure: true });
      const url = await new Promise<string>((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            {
              resource_type: "image",
              public_id: "juntai/investidores/avatar/" + randomUUID(),
              overwrite: false,
            },
            (error, result) => {
              if (error || !result?.secure_url)
                return reject(error ?? new Error("Upload failed"));
              publicId = result.public_id;
              resolve(result.secure_url);
            },
          )
          .end(file);
      });
      await AppDataSource.getRepository(Usuario).update(req.user!.id, {
        avatarUrl: url,
      });
      return res.status(201).json({ url });
    } catch {
      if (publicId) await cloudinary.uploader.destroy(publicId).catch(() => {});
      return res
        .status(502)
        .json({ message: "Não foi possível enviar a foto. Tente novamente." });
    }
  },
);
avatarRoutes.delete("/investidor/avatar", ...guards, async (req, res) => {
  try {
    if (!(await owner(req.user!.id)))
      return res
        .status(403)
        .json({ message: "Perfil de investidor não encontrado ou inativo." });
    await AppDataSource.query(
      "UPDATE usuarios SET avatar_url=NULL WHERE id=$1",
      [req.user!.id],
    );
    return res.status(204).send();
  } catch {
    return res
      .status(500)
      .json({ message: "Não foi possível remover a foto. Tente novamente." });
  }
});
const uploadError: ErrorRequestHandler = (error, _req, res, _next) => {
  res
    .status(error.type === "entity.too.large" ? 413 : 400)
    .json({ message: "Use uma foto PNG, JPG ou WebP de até 2 MB." });
};
avatarRoutes.use(uploadError);
