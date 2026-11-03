import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import path from 'path';

// Aponta para todas as entities dentro de src/modules/<qualquer_modulo>/entities/*.ts
// Ex.: src/modules/alunos/entities/Aluno.ts será carregado automaticamente.
const entitiesGlob = path.join(__dirname, '..', '..', 'modules', '**', 'entities', '*.{ts,js}');
const migrationsGlob = path.join(__dirname, 'migrations', '*.{ts,js}');

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  // O esquema existente é atualizado pelas migrations; sincronizar pode remover
  // colunas legadas e enums compartilhados. Habilite apenas em banco descartável.
  synchronize: process.env.NODE_ENV !== 'production' && process.env.DB_SYNCHRONIZE === 'true',
  logging: process.env.NODE_ENV !== 'production',

  entities: [entitiesGlob],
  migrations: [migrationsGlob],
});

export default AppDataSource;