import { avatarRoutes } from "@modules/uploads/routes/avatar.routes";
import { adminRoutes } from "@modules/admin/routes/admin.routes";
import "reflect-metadata";
import express, { Application } from "express";
import cors from "cors";
import { investidorRoutes } from "@modules/investidores/routes/investidor.routes";
import { startupRoutes } from "@modules/startups/routes/startup.routes";
import { uploadRoutes } from "@modules/uploads/routes/upload.routes";
import { authRoutes } from "@modules/auth/routes/auth.routes";
import { mensagemRoutes } from "@modules/mensagens/routes/mensagem.routes";
import { reuniaoRoutes } from "@modules/reunioes/routes/reuniao.routes";

class App {
  public express: Application;

  constructor() {
    this.express = express();
    this.middlewares();
    this.routes();
  }

  private middlewares(): void {
    this.express.use(cors({
      origin: process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
        : true,
    }));
    this.express.use(express.json());
  }

  private routes(): void {
    this.express.get("/health", (_req, res) => { res.json({ status: "ok" }); });
    this.express.get("/", (req, res) => {
      res.send("Juntai-Backend está no ar 🚀");
    });

    this.express.use("/uploads", avatarRoutes);
    this.express.use("/uploads", uploadRoutes);
    this.express.use("/auth", authRoutes);
    this.express.use("/admin", adminRoutes);
    this.express.use("/investidores", investidorRoutes);
    this.express.use("/startups", startupRoutes);
    this.express.use("/mensagens", mensagemRoutes);
    this.express.use("/reunioes", reuniaoRoutes);
  }
}

export default new App().express;
