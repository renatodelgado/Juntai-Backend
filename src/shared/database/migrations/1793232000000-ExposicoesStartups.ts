import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExposicoesStartups1793232000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE exposicoes_startups (
      id uuid PRIMARY KEY,
      investidor_id uuid NOT NULL REFERENCES investidores(id) ON DELETE CASCADE,
      startup_id uuid NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
      ocorrido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
      origem_recomendacao varchar(30) NOT NULL CHECK (origem_recomendacao IN ('discovery','rules')),
      posicao_ranking integer CHECK (posicao_ranking > 0),
      versao_recomendador varchar(100),
      snapshot_perfis jsonb NOT NULL,
      versao_contrato varchar(30) NOT NULL DEFAULT 'supervised-v1',
      semantica varchar(50) NOT NULL DEFAULT 'card_50pct_1000ms_ack',
      origem_dados varchar(10) NOT NULL DEFAULT 'real' CHECK (origem_dados IN ('real','sintetica'))
    )`);
    await q.query('CREATE INDEX exposicoes_par_data ON exposicoes_startups (investidor_id, startup_id, ocorrido_em)');
  }
  async down(q: QueryRunner): Promise<void> {
    // Reversão explícita recusada: rollback automático perderia histórico de ML.
    throw new Error('Rollback requer plano explícito de preservação das exposições.');
  }
}
