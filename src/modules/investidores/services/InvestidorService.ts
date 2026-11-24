import { filtrarPerfil, filtrarPerfis } from '@modules/moderacao/services/OcultacaoPerfil';
import bcrypt from 'bcrypt';
import { AppDataSource } from '@shared/database/data-source';
import { Usuario } from '@modules/usuarios/entities/Usuario';
import { Investidor } from '@modules/investidores/entities/Investidor';
import { comUsuarioPublico, UsuarioPublico } from '@modules/usuarios/mappers/usuarioPublico';
import { InvestidorRepository } from '@modules/investidores/repositories/InvestidorRepository';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import {
  TipoPerfil,
  TipoInvestidor,
  PerfilRisco,
  Segmento,
  Estagio,
  ModeloNegocio,
  AreaAjuda,
  DisponibilidadeInvestidor,
} from '@shared/enums';
import { resolverRegiao, resolverRegioes } from '@shared/enums/legacyRegiao';

interface CreateInvestidorDTO {
  // dados da conta (Usuario)
  nome: string;
  email: string;
  senha: string;
  avatarUrl?: string;

  // identidade / apresentação
  tituloProfissional?: string;
  linkedinUrl?: string;
  bio?: string;

  // localização
  estado?: string;
  cidade?: string;

  // perfil de atuação
  tipoInvestidor: TipoInvestidor;
  areasAjuda?: AreaAjuda[];
  disponibilidade?: DisponibilidadeInvestidor;

  // experiência prévia
  jaAtuouComStartups?: boolean;
  numeroAproximadoInvestimentos?: number;
  descricaoExperiencia?: string;
  setoresAtuacao?: Segmento[];
  anosExperiencia?: number;

  // critérios de investimento
  ticketMinimo?: number;
  ticketMaximo?: number;
  perfilRisco?: PerfilRisco;
  segmentosInteresse?: Segmento[];
  estagiosInteresse?: Estagio[];
  // Aceita o enum atual de Regiao ou valores do contrato antigo do frontend
  // (ver resolverRegioes), incluindo "nacional", que não existe mais como enum único.
  regioesInteresse?: string[];
  modelosInteresse?: ModeloNegocio[];
  // status_moderacao NÃO entra aqui de propósito: todo investidor nasce "pendente",
  // quem muda isso é o fluxo de aprovação do admin (RF08), nunca o próprio cadastro.
}

interface UpdateInvestidorDTO {
  nome?: string;
  tituloProfissional?: string;
  linkedinUrl?: string;
  bio?: string;
  estado?: string;
  cidade?: string;
  tipoInvestidor?: TipoInvestidor;
  areasAjuda?: AreaAjuda[];
  disponibilidade?: DisponibilidadeInvestidor;
  jaAtuouComStartups?: boolean;
  numeroAproximadoInvestimentos?: number;
  descricaoExperiencia?: string;
  setoresAtuacao?: Segmento[];
  anosExperiencia?: number;
  ticketMinimo?: number;
  ticketMaximo?: number;
  perfilRisco?: PerfilRisco;
  segmentosInteresse?: Segmento[];
  estagiosInteresse?: Estagio[];
  regioesInteresse?: string[];
  regiao?: string;
  modelosInteresse?: ModeloNegocio[];
  // email, senha (da conta) e statusModeracao não entram aqui de propósito:
  // conta se edita em outro endpoint (ainda não existe) e moderação é só o admin quem muda.
}

// Campos que o próprio dono pode alterar. Allowlist explícita: mesmo que o corpo da
// requisição traga outras chaves (ex.: statusModeracao), elas são sempre ignoradas aqui.
const CAMPOS_EDITAVEIS_INVESTIDOR: (keyof UpdateInvestidorDTO)[] = [
  'nome', 'tituloProfissional', 'linkedinUrl', 'bio', 'estado', 'cidade', 'tipoInvestidor',
  'areasAjuda', 'disponibilidade', 'jaAtuouComStartups', 'numeroAproximadoInvestimentos',
  'descricaoExperiencia', 'setoresAtuacao', 'anosExperiencia', 'ticketMinimo', 'ticketMaximo',
  'perfilRisco', 'segmentosInteresse', 'estagiosInteresse', 'modelosInteresse',
];

export type InvestidorResponse = Omit<Investidor, 'usuario'> & { usuario: UsuarioPublico };

export class InvestidorService {
  private investidorRepository = new InvestidorRepository();

  async create(data: CreateInvestidorDTO): Promise<InvestidorResponse> {
    const usuarioRepo = AppDataSource.getRepository(Usuario);

    const emailExiste = await usuarioRepo.findOne({ where: { email: data.email } });
    if (emailExiste) {
      throw new Error('E-mail já cadastrado.');
    }

    // Falha cedo (antes de criar usuário/hash de senha) se alguma região não for reconhecida.
    const regioesInteresse = resolverRegioes(data.regioesInteresse ?? []);

    const senhaHash = await bcrypt.hash(data.senha, 10);

    return AppDataSource.transaction(async (manager) => {
      const usuario = manager.create(Usuario, {
        nome: data.nome,
        email: data.email,
        senhaHash,
        tipoPerfil: TipoPerfil.INVESTIDOR,
        avatarUrl: data.avatarUrl,
      });
      const usuarioSalvo = await manager.save(usuario);

      const investidor = manager.create(Investidor, {
        usuario: usuarioSalvo,
        nome: data.nome,

        tituloProfissional: data.tituloProfissional,
        linkedinUrl: data.linkedinUrl,
        bio: data.bio,

        estado: data.estado,
        cidade: data.cidade,

        tipoInvestidor: data.tipoInvestidor,
        areasAjuda: data.areasAjuda ?? [],
        disponibilidade: data.disponibilidade,

        jaAtuouComStartups: data.jaAtuouComStartups ?? false,
        numeroAproximadoInvestimentos: data.numeroAproximadoInvestimentos,
        descricaoExperiencia: data.descricaoExperiencia,
        setoresAtuacao: data.setoresAtuacao ?? [],
        anosExperiencia: data.anosExperiencia,

        ticketMinimo: data.ticketMinimo,
        ticketMaximo: data.ticketMaximo,
        perfilRisco: data.perfilRisco,
        segmentosInteresse: data.segmentosInteresse ?? [],
        estagiosInteresse: data.estagiosInteresse ?? [],
        regioesInteresse,
        modelosInteresse: data.modelosInteresse ?? [],
      });

      return comUsuarioPublico(await manager.save(investidor));
    });
  }

  // Lista e detalhe nunca carregam o Usuario (ver InvestidorRepository), então o retorno
  // não tem o campo "usuario" nem chance de vazar senha_hash.
  async listar(): Promise<Investidor[]> {
    return filtrarPerfis('investidor', await this.investidorRepository.listarTodas());
  }

  async buscarPorId(id: string): Promise<Investidor> {
    if (!isUuid(id)) {
      throw new AppError('Id inválido.', 400);
    }
    const investidor = await this.investidorRepository.findById(id);
    if (!investidor) {
      throw new AppError('Investidor não encontrado.', 404);
    }
    return filtrarPerfil('investidor', investidor);
  }

  async atualizar(usuarioId: string, investidorId: string, dados: UpdateInvestidorDTO): Promise<Investidor> {
    if (!isUuid(investidorId)) {
      throw new AppError('Id inválido.', 400);
    }

    const meuInvestidor = await this.investidorRepository.findByUsuarioId(usuarioId);
    if (!meuInvestidor || meuInvestidor.id !== investidorId) {
      throw new AppError('Você só pode editar o seu próprio perfil de investidor.', 403);
    }

    for (const campo of CAMPOS_EDITAVEIS_INVESTIDOR) {
      const valor = dados[campo];
      if (valor !== undefined) {
        (meuInvestidor as unknown as Record<string, unknown>)[campo] = valor;
      }
    }
    if (dados.regioesInteresse?.length) {
      meuInvestidor.regioesInteresse = resolverRegioes(dados.regioesInteresse);
    } else if (dados.regiao) {
      meuInvestidor.regioesInteresse = resolverRegiao(dados.regiao);
    }

    return filtrarPerfil('investidor', await this.investidorRepository.salvar(meuInvestidor));
  }
}
