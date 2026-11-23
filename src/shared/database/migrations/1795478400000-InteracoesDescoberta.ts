import { MigrationInterface, QueryRunner } from 'typeorm';

export class InteracoesDescoberta1795478400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE interacoes_descoberta (
      id uuid PRIMARY KEY,
      investidor_id uuid NOT NULL REFERENCES investidores(id) ON DELETE CASCADE,
      startup_id uuid NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
      tipo varchar(30) NOT NULL CHECK (tipo IN ('perfil_aberto','tempo_perfil','salvou','removeu_salvo')),
      segundos integer CHECK (segundos BETWEEN 10 AND 300),
      ocorrido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((tipo = 'tempo_perfil') = (segundos IS NOT NULL))
    )`);
    await q.query('CREATE INDEX interacoes_descoberta_investidor_data ON interacoes_descoberta (investidor_id, ocorrido_em DESC)');
    await q.query(`CREATE TABLE startups_salvas (
      investidor_id uuid NOT NULL REFERENCES investidores(id) ON DELETE CASCADE,
      startup_id uuid NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
      criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (investidor_id, startup_id)
    )`);
  }
  async down(): Promise<void> { throw new Error('Rollback requer plano explícito de preservação das interações.'); }
}
