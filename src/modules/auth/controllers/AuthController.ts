import { Request, Response } from 'express';
import { AuthService } from '@modules/auth/services/AuthService';
import { AppError } from '@shared/errors/AppError';

export class AuthController {
  private authService: AuthService;

  constructor() {
    this.authService = new AuthService();
  }

  login = async (req: Request, res: Response): Promise<Response> => {
    try {
      const resultado = await this.authService.login(req.body);
      return res.status(200).json(resultado);
    } catch (error: any) {
      return this.handleError(res, error);
    }
  };

  forgotPassword = async (req: Request, res: Response): Promise<Response> => {
    try {
      return res.status(200).json(await this.authService.checkRecoveryEmail(req.body?.email));
    } catch (error: unknown) {
      return this.handleError(res, error);
    }
  };

  me = async (req: Request, res: Response): Promise<Response> => {
    try {
      const usuario = await this.authService.me(req.user!.id);
      return res.status(200).json(usuario);
    } catch (error: any) {
      return this.handleError(res, error);
    }
  };

  profile = async (req: Request, res: Response): Promise<Response> => {
    try {
      return res.status(200).json(await this.authService.profile(req.user!.id));
    } catch (error: unknown) {
      return this.handleError(res, error);
    }
  };

  private handleError(res: Response, error: unknown): Response {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error(error);
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
}
