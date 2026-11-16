import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Reuniao } from '@modules/reunioes/entities/Reuniao';
import { Conversa } from '@modules/conversas/entities/Conversa';
import { Usuario } from '@modules/usuarios/entities/Usuario';

@Entity({ name: 'avaliacoes' })
export class Avaliacao {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @ManyToOne(() => Reuniao, { nullable: true })
  @JoinColumn({ name: 'reuniao_id' })
  reuniao?: Reuniao;

  @ManyToOne(() => Conversa, { nullable: true })
  @JoinColumn({ name: 'conversa_id' })
  conversa?: Conversa;

  @Column({ name: 'atualizado_em', type: 'timestamptz', default: () => 'now()' })
  atualizadoEm!: Date;

  @ManyToOne(() => Usuario)
  @JoinColumn({ name: 'avaliador_usuario_id' })
  avaliador!: Usuario;

  @ManyToOne(() => Usuario)
  @JoinColumn({ name: 'avaliado_usuario_id' })
  avaliado!: Usuario;

  @Column({ type: 'smallint' })
  nota!: number; // 1 a 5 - validar no service/DTO antes de salvar

  @Column({ type: 'text', nullable: true })
  comentario?: string;

  @Column({ name: 'resultado_interacao', type: 'text', default: 'em_analise' })
  resultadoInteracao!: 'em_analise' | 'avancar' | 'nao_seguir';

  @Column({ name: 'perspectiva_investimento', type: 'text', default: 'nao_definido' })
  perspectivaInvestimento!: 'nao_definido' | 'em_negociacao' | 'intencao' | 'realizado' | 'nao_se_aplica';

  @CreateDateColumn({ name: 'criado_em', type: 'timestamptz' })
  criadoEm!: Date;
}
