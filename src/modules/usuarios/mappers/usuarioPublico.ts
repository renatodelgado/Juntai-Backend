import { Usuario } from '@modules/usuarios/entities/Usuario';

export type UsuarioPublico = Omit<Usuario, 'senhaHash'>;

/**
 * Devolve o usuário sem o hash da senha. Use em toda resposta HTTP que inclua um Usuario.
 */
export function toUsuarioPublico(usuario: Usuario): UsuarioPublico {
  const { senhaHash: _senhaHash, ...publico } = usuario;
  return publico;
}

/**
 * Para entidades que carregam a relação `usuario` (Startup, Investidor):
 * mantém todos os campos e troca o usuário pela versão pública.
 */
export function comUsuarioPublico<T extends { usuario: Usuario }>(
  entidade: T,
): Omit<T, 'usuario'> & { usuario: UsuarioPublico } {
  return { ...entidade, usuario: toUsuarioPublico(entidade.usuario) };
}
