import { MigrationInterface, QueryRunner } from 'typeorm';
export class FeedbackResultados1794787200001 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE avaliacoes
      ADD COLUMN resultado_interacao text NOT NULL DEFAULT 'em_analise',
      ADD COLUMN perspectiva_investimento text NOT NULL DEFAULT 'nao_definido',
      ADD CONSTRAINT avaliacoes_resultado CHECK (resultado_interacao IN ('em_analise','avancar','nao_seguir')),
      ADD CONSTRAINT avaliacoes_perspectiva CHECK (perspectiva_investimento IN ('nao_definido','em_negociacao','intencao','realizado','nao_se_aplica'))`);
  }
  async down(): Promise<void> {
    throw new Error('Reversão automática indisponível para preservar resultados e perspectivas registrados.');
  }
}
