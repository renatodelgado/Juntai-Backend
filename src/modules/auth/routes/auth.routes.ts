import { Router } from 'express';
import { AuthController } from '@modules/auth/controllers/AuthController';
import { ensureAuthenticated } from '@shared/middlewares/ensureAuthenticated';
import { recoveryRateLimit } from './recoveryRateLimit';

const authRoutes = Router();
const authController = new AuthController();

authRoutes.post('/login', authController.login);
authRoutes.post('/forgot-password', recoveryRateLimit, authController.forgotPassword);
authRoutes.post('/reset-password', recoveryRateLimit, authController.resetPassword);
authRoutes.get('/me', ensureAuthenticated, authController.me);
authRoutes.get('/profile', ensureAuthenticated, authController.profile);

export { authRoutes };
