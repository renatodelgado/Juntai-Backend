import { discoveryRoutes } from './discovery.routes';
import { StartupInterestService } from "@modules/startups/services/StartupInterestService";
import { ensureRole } from "@shared/middlewares/ensureRole";
import { TipoPerfil } from "@shared/enums";
import { handleControllerError } from "@shared/http/handleControllerError";
import { Router } from "express";
import { StartupController } from "@modules/startups/controllers/StartupController";
import { ensureAuthenticated } from "@shared/middlewares/ensureAuthenticated";

const startupRoutes = Router();
const startupController = new StartupController();

startupRoutes.post("/", startupController.create);
startupRoutes.get("/", ensureAuthenticated, startupController.listar);
startupRoutes.use(discoveryRoutes);
const interests = new StartupInterestService();
startupRoutes.get(
  "/interesses",
  ensureAuthenticated,
  ensureRole(TipoPerfil.INVESTIDOR),
  async (req, res) => {
    try {
      res.json(await interests.list(req.user!.id));
    } catch (error) {
      handleControllerError(res, error);
    }
  },
);
startupRoutes.post(
  "/:id/interesse",
  ensureAuthenticated,
  ensureRole(TipoPerfil.INVESTIDOR),
  async (req, res) => {
    try {
      res.json(await interests.confirm(req.user!.id, String(req.params.id)));
    } catch (error) {
      handleControllerError(res, error);
    }
  },
);
startupRoutes.get("/:id", ensureAuthenticated, startupController.buscarPorId);
startupRoutes.patch("/:id", ensureAuthenticated, startupController.atualizar);

export { startupRoutes };
