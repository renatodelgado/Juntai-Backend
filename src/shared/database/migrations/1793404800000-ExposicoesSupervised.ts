import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExposicoesSupervised1793404800000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw new Error('Migration exige transação explícita.');
    const constraints = await q.query(`SELECT conname, convalidated, pg_get_expr(conbin,conrelid) AS expression
      FROM pg_constraint WHERE conrelid='public.exposicoes_startups'::regclass
      AND contype='c' AND conname='exposicoes_startups_origem_recomendacao_check'`);
    const normalize = (value: string) => value.replace(/\s+|[()]/g,'').replace(/::charactervarying(?:\[\])?|::text(?:\[\])?/g,'');
    if (constraints.length !== 1 || !constraints[0].convalidated || normalize(constraints[0].expression) !== "origem_recomendacao=ANYARRAY['discovery','rules']") {
      throw new Error('CHECK de origem diverge do estado validado; operação interrompida.');
    }
    await q.query('ALTER TABLE public.exposicoes_startups DROP CONSTRAINT exposicoes_startups_origem_recomendacao_check');
    await q.query("ALTER TABLE public.exposicoes_startups ADD CONSTRAINT exposicoes_startups_origem_recomendacao_check CHECK (origem_recomendacao IN ('discovery','rules','supervised'))");
  }
  async down(_q: QueryRunner): Promise<void> {
    throw new Error('Rollback requer plano explícito de preservação das exposições supervisionadas.');
  }
}
