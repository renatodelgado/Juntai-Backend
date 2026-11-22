import { MigrationInterface, QueryRunner } from 'typeorm';

export class PasswordRecovery1795000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE usuarios ADD COLUMN session_version integer NOT NULL DEFAULT 0');
    await q.query(`CREATE TABLE password_recovery_tokens (
      token_hash char(64) PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query('CREATE INDEX password_recovery_user_idx ON password_recovery_tokens(user_id)');
    await q.query('CREATE TABLE password_recovery_limits (key_hash char(64) PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL)');
  }
  async down(): Promise<void> {
    throw new Error('Reversão automática indisponível para preservar a segurança dos tokens.');
  }
}
