import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TipoPerfil } from '@shared/enums';

@Entity({ name: 'usuarios' })
export class Usuario {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 150 })
  nome!: string;

  @Column({ type: 'varchar', length: 150, unique: true })
  email!: string;

  @Column({ name: 'senha_hash', type: 'varchar', length: 255 })
  senhaHash!: string;

  @Column({
    name: 'tipo_perfil',
    type: 'enum',
    enum: TipoPerfil,
    enumName: 'tipo_perfil_enum',
  })
  tipoPerfil!: TipoPerfil;

  @Column({ type: 'boolean', default: true })
  ativo!: boolean;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl?: string;

  @CreateDateColumn({ name: 'criado_em', type: 'timestamptz' })
  criadoEm!: Date;

  @UpdateDateColumn({ name: 'atualizado_em', type: 'timestamptz' })
  atualizadoEm!: Date;
}