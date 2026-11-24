import { Router } from 'express';
import { AuthController } from '@modules/auth/controllers/AuthController';
import { ensureAuthenticated } from '@shared/middlewares/ensureAuthenticated';

const authRoutes = Router();
const authController = new AuthController();

authRoutes.post('/login', authController.login);
authRoutes.post('/forgot-password', authController.forgotPassword);
authRoutes.get('/me', ensureAuthenticated, authController.me);
authRoutes.get('/profile', ensureAuthenticated, authController.profile);

export { authRoutes };
