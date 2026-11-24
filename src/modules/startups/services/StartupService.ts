import { filtrarPerfil, filtrarPerfis } from '@modules/moderacao/services/OcultacaoPerfil';
import bcrypt from 'bcrypt';
import { AppDataSource } from '@shared/database/data-source';
import { Usuario } from '@modules/usuarios/entities/Usuario';
import { Startup } from '@modules/startups/entities/Startup';
import { comUsuarioPublico, UsuarioPublico } from '@modules/usuarios/mappers/usuarioPublico';
import { StartupRepository } from '@modules/startups/repositories/StartupRepository';
import { AppError } from '@shared/errors/AppError';
import { isUuid } from '@shared/validation/isUuid';
import {
  TipoPerfil,
  Segmento,
  Estagio,
  Regiao,
  ModeloNegocio,
  MetricaCrescimento,
  PeriodoComparacao,
  NecessidadeAdicional,
} from '@shared/enums';
import { resolverRegiao, resolverRegioes } from '@shared/enums/legacyRegiao';

interface CreateStartupDTO {
  // dados da conta (Usuario)
  nome: string;
  email: string;
  senha: string;
  avatarUrl?: string;

  // identidade / apresentação
  nomeFantasia: string;
  logoUrl?: string;
  apresentacaoUrl?: string;
  descricaoCurta?: string;
  siteUrl?: string;
  linksSociais?: { linkedin?: string; instagram?: string; outros?: string[] };
  videoApresentacaoUrl?: string;

  // classificação
  segmento: Segmento;
  segmentosSecundarios?: Segmento[];
  estagio: Estagio;
  modeloNegocio: ModeloNegocio;

  // localização
  estado?: string;
  cidade?: string;
  // Contrato atual: array com as 5 regiões do Brasil. "regiao" (um valor só) é o campo
  // antigo que o Juntai-Frontend ainda envia; os dois passam por resolverRegiao/resolverRegioes
  // (ver @shared/enums/legacyRegiao), que também traduz valores do enum antigo (recife,
  // porto_digital, nacional). Remover o campo "regiao" quando o frontend for atualizado.
  regioesAtuacao?: string[];
  regiao?: string;
  regioesCrescimento?: string[];
  mercadoAlvo?: string;

  // métricas de evolução
  metricaCrescimento?: MetricaCrescimento;
  periodoComparacaoCrescimento?: PeriodoComparacao;
  taxaCrescimentoPct?: number;
  descricaoEvolucao?: string;
  numeroClientes?: number;
  faturamentoMensal?: number;
  tamanhoEquipe?: number;

  // captação
  buscaInvestimento?: boolean;
  capitalProcurado?: number;
  finalidadeInvestimento?: string;
  necessidadesAdicionais?: NecessidadeAdicional[];

  descricaoPitch?: string;
  canvasJson?: Record<string, unknown>;
  // status_moderacao NÃO entra aqui de propósito: toda startup nasce "pendente",
  // quem muda isso é o fluxo de aprovação do admin (RF08), nunca o próprio cadastro.
}

interface UpdateStartupDTO {
  nomeFantasia?: string;
  logoUrl?: string;
  descricaoCurta?: string;
  siteUrl?: string;
  linksSociais?: { linkedin?: string; instagram?: string; outros?: string[] };
  videoApresentacaoUrl?: string;
  segmento?: Segmento;
  segmentosSecundarios?: Segmento[];
  estagio?: Estagio;
  modeloNegocio?: ModeloNegocio;
  estado?: string;
  cidade?: string;
  regioesAtuacao?: string[];
  regiao?: string;
  regioesCrescimento?: string[];
  mercadoAlvo?: string;
  metricaCrescimento?: MetricaCrescimento;
  periodoComparacaoCrescimento?: PeriodoComparacao;
  taxaCrescimentoPct?: number;
  descricaoEvolucao?: string;
  numeroClientes?: number;
  faturamentoMensal?: number;
  tamanhoEquipe?: number;
  buscaInvestimento?: boolean;
  capitalProcurado?: number;
  finalidadeInvestimento?: string;
  necessidadesAdicionais?: NecessidadeAdicional[];
  descricaoPitch?: string;
  canvasJson?: Record<string, unknown>;
  // nome, email, senha (da conta) e statusModeracao não entram aqui de propósito:
  // conta se edita em outro endpoint (ainda não existe) e moderação é só o admin quem muda.
}

// Campos que o próprio dono pode alterar. Allowlist explícita: mesmo que o corpo da
// requisição traga outras chaves (ex.: statusModeracao), elas são sempre ignoradas aqui.
const CAMPOS_EDITAVEIS_STARTUP: (keyof UpdateStartupDTO)[] = [
  'nomeFantasia', 'logoUrl', 'descricaoCurta', 'siteUrl', 'linksSociais', 'videoApresentacaoUrl',
  'segmento', 'segmentosSecundarios', 'estagio', 'modeloNegocio', 'estado', 'cidade', 'mercadoAlvo',
  'metricaCrescimento', 'periodoComparacaoCrescimento', 'taxaCrescimentoPct', 'descricaoEvolucao',
  'numeroClientes', 'faturamentoMensal', 'tamanhoEquipe', 'buscaInvestimento', 'capitalProcurado',
  'finalidadeInvestimento', 'necessidadesAdicionais', 'descricaoPitch', 'canvasJson',
];

export type StartupResponse = Omit<Startup, 'usuario'> & { usuario: UsuarioPublico };

export class StartupService {
  private startupRepository = new StartupRepository();

  async create(data: CreateStartupDTO): Promise<StartupResponse> {
    const usuarioRepo = AppDataSource.getRepository(Usuario);

    const emailExiste = await usuarioRepo.findOne({ where: { email: data.email } });
    if (emailExiste) {
      throw new Error('E-mail já cadastrado.');
    }

    // Falha cedo (antes de criar usuário/hash de senha) se alguma região não for reconhecida.
    const regioesAtuacao = data.regioesAtuacao?.length
      ? resolverRegioes(data.regioesAtuacao)
      : data.regiao
        ? resolverRegiao(data.regiao)
        : [];
    const regioesCrescimento = data.regioesCrescimento?.length ? resolverRegioes(data.regioesCrescimento) : [];

    const senhaHash = await bcrypt.hash(data.senha, 10);

    return AppDataSource.transaction(async (manager) => {
      const usuario = manager.create(Usuario, {
        nome: data.nome,
        email: data.email,
        senhaHash,
        tipoPerfil: TipoPerfil.STARTUP,
        avatarUrl: data.avatarUrl,
      });
      const usuarioSalvo = await manager.save(usuario);

      const startup = manager.create(Startup, {
        usuario: usuarioSalvo,

        nomeFantasia: data.nomeFantasia,
        logoUrl: data.logoUrl,
        apresentacaoUrl: data.apresentacaoUrl,
        descricaoCurta: data.descricaoCurta,
        siteUrl: data.siteUrl,
        linksSociais: data.linksSociais,
        videoApresentacaoUrl: data.videoApresentacaoUrl,

        segmento: data.segmento,
        segmentosSecundarios: data.segmentosSecundarios,
        estagio: data.estagio,
        modeloNegocio: data.modeloNegocio,

        estado: data.estado,
        cidade: data.cidade,
        regioesAtuacao,
        regioesCrescimento,
        mercadoAlvo: data.mercadoAlvo,

        metricaCrescimento: data.metricaCrescimento,
        periodoComparacaoCrescimento: data.periodoComparacaoCrescimento,
        taxaCrescimentoPct: data.taxaCrescimentoPct,
        descricaoEvolucao: data.descricaoEvolucao,
        numeroClientes: data.numeroClientes,
        faturamentoMensal: data.faturamentoMensal,
        tamanhoEquipe: data.tamanhoEquipe,

        buscaInvestimento: data.buscaInvestimento,
        capitalProcurado: data.capitalProcurado,
        finalidadeInvestimento: data.finalidadeInvestimento,
        necessidadesAdicionais: data.necessidadesAdicionais,

        descricaoPitch: data.descricaoPitch,
        canvasJson: data.canvasJson,
      } as Partial<Startup>);

      return comUsuarioPublico(await manager.save(startup));
    });
  }

  // Lista e detalhe nunca carregam o Usuario (ver StartupRepository), então o retorno
  // não tem o campo "usuario" nem chance de vazar senha_hash.
  async listar(): Promise<Startup[]> {
    return filtrarPerfis('startup', await this.startupRepository.listarAprovadas());
  }

  async buscarPorId(id: string): Promise<Startup> {
    if (!isUuid(id)) {
      throw new AppError('Id inválido.', 400);
    }
    const startup = await this.startupRepository.findById(id);
    if (!startup) {
      throw new AppError('Startup não encontrada.', 404);
    }
    return filtrarPerfil('startup', startup);
  }

  async atualizar(usuarioId: string, startupId: string, dados: UpdateStartupDTO): Promise<Startup> {
    if (!isUuid(startupId)) {
      throw new AppError('Id inválido.', 400);
    }

    const minhaStartup = await this.startupRepository.findByUsuarioId(usuarioId);
    if (!minhaStartup || minhaStartup.id !== startupId) {
      throw new AppError('Você só pode editar o seu próprio perfil de startup.', 403);
    }

    for (const campo of CAMPOS_EDITAVEIS_STARTUP) {
      const valor = dados[campo];
      if (valor !== undefined) {
        (minhaStartup as unknown as Record<string, unknown>)[campo] = valor;
      }
    }
    if (dados.regioesAtuacao?.length) {
      minhaStartup.regioesAtuacao = resolverRegioes(dados.regioesAtuacao);
    } else if (dados.regiao) {
      minhaStartup.regioesAtuacao = resolverRegiao(dados.regiao);
    }
    if (dados.regioesCrescimento?.length) {
      minhaStartup.regioesCrescimento = resolverRegioes(dados.regioesCrescimento);
    }

    return filtrarPerfil('startup', await this.startupRepository.salvar(minhaStartup));
  }
}
