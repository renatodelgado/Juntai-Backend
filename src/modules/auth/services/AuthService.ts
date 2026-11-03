import { Usuario } from "@modules/usuarios/entities/Usuario";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { authConfig } from "@shared/config/auth";
import { AppError } from "@shared/errors/AppError";
import { TipoPerfil } from "@shared/enums";
import { UsuarioRepository } from "@modules/usuarios/repositories/UsuarioRepository";
import { AppDataSource } from "@shared/database/data-source";
import { Startup } from "@modules/startups/entities/Startup";
import { Investidor } from "@modules/investidores/entities/Investidor";

interface LoginDTO {
  email: string;
  senha: string;
}

export interface UsuarioAutenticado {
  id: string;
  nome: string;
  email: string;
  tipoPerfil: TipoPerfil;
}

interface LoginResponse {
  token: string;
  usuario: UsuarioAutenticado;
}

// Hash descartável: garante que o bcrypt.compare rode mesmo quando o e-mail não existe,
// evitando que o tempo de resposta revele quais e-mails estão cadastrados.
const HASH_DESCARTAVEL = bcrypt.hashSync("senha-descartavel", 10);

export class AuthService {
  private usuarioRepository: UsuarioRepository;

  constructor() {
    this.usuarioRepository = new UsuarioRepository();
  }

  async login({ email, senha }: LoginDTO): Promise<LoginResponse> {
    if (!email || !senha) {
      throw new AppError("E-mail e senha são obrigatórios.", 400);
    }

    const usuario = await this.usuarioRepository.findByEmail(email);
    const senhaConfere = await bcrypt.compare(
      senha,
      usuario?.senhaHash ?? HASH_DESCARTAVEL,
    );

    if (!usuario || !senhaConfere) {
      throw new AppError("E-mail ou senha inválidos.", 401);
    }

    if (!usuario.ativo) {
      throw new AppError(
        "Usuário inativo. Entre em contato com a administração.",
        403,
      );
    }

    const token = jwt.sign(
      { tipoPerfil: usuario.tipoPerfil },
      authConfig.secret,
      {
        subject: usuario.id,
        expiresIn: authConfig.expiresIn as SignOptions["expiresIn"],
      },
    );

    return {
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        tipoPerfil: usuario.tipoPerfil,
      },
    };
  }

  // Fluxo temporário: consulta o cadastro, sem gerar código ou alterar a senha.
  async checkRecoveryEmail(
    value: unknown,
  ): Promise<{ emailFound: true; codeSent: false }> {
    if (
      typeof value !== "string" ||
      value.trim().length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ) {
      throw new AppError("Informe um e-mail válido.", 400);
    }
    const usuario = await this.usuarioRepository.findByEmail(
      value.trim().toLowerCase(),
    );
    if (!usuario) {
      throw new AppError(
        "O e-mail digitado não está na nossa base de dados.",
        404,
      );
    }
    return { emailFound: true, codeSent: false };
  }

  async me(usuarioId: string): Promise<UsuarioAutenticado> {
    const usuario = await this.usuarioRepository.findById(usuarioId);

    if (!usuario || !usuario.ativo) {
      throw new AppError("Usuário não encontrado ou inativo.", 401);
    }

    return {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      tipoPerfil: usuario.tipoPerfil,
    };
  }

  async profile(usuarioId: string): Promise<Startup | Investidor> {
    const usuario = await this.me(usuarioId);
    const where = { usuario: { id: usuario.id } };
    const profile =
      usuario.tipoPerfil === TipoPerfil.STARTUP
        ? await AppDataSource.getRepository(Startup).findOne({ where })
        : usuario.tipoPerfil === TipoPerfil.INVESTIDOR
          ? await AppDataSource.getRepository(Investidor).findOne({ where })
          : null;
    if (!profile) throw new AppError("Perfil nao encontrado.", 404);
    if (usuario.tipoPerfil === TipoPerfil.INVESTIDOR) {
      const account = await AppDataSource.getRepository(Usuario).findOne({
        select: { id: true, avatarUrl: true },
        where: { id: usuario.id },
      });
      return Object.assign(profile, { avatarUrl: account?.avatarUrl ?? null });
    }
    return profile;
  }
}
