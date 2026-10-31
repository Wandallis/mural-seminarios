import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('A variavel de ambiente DATABASE_URL e obrigatoria.');
}

const sslEnabled = process.env.DB_SSL === 'true';
const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';
const ssl = sslEnabled
  ? {
      rejectUnauthorized,
      ...(process.env.DB_SSL_CA
        ? { ca: readFileSync(process.env.DB_SSL_CA, 'utf8') }
        : {})
    }
  : false;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl
});

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seminars (
      id BIGSERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      presenter TEXT NOT NULL DEFAULT '',
      presenters TEXT[] NOT NULL DEFAULT '{}',
      description TEXT NOT NULL DEFAULT '',
      location VARCHAR(200) NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      slides_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id BIGSERIAL PRIMARY KEY,
      seminar_id BIGINT NOT NULL REFERENCES seminars(id) ON DELETE CASCADE,
      participant_name VARCHAR(200) NOT NULL,
      email VARCHAR(320) NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (seminar_id, email)
    );

    CREATE TABLE IF NOT EXISTS seminar_presenters (
      id BIGSERIAL PRIMARY KEY,
      seminar_id BIGINT NOT NULL REFERENCES seminars(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL,
      is_present BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (seminar_id, name)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS seminar_presenters_name_idx
      ON seminar_presenters(seminar_id, LOWER(name));
    ALTER TABLE seminars ALTER COLUMN presenter TYPE TEXT;
    ALTER TABLE seminars ALTER COLUMN presenter SET DEFAULT '';
    ALTER TABLE seminars ADD COLUMN IF NOT EXISTS presenters TEXT[] NOT NULL DEFAULT '{}';
    UPDATE seminars
    SET presenters = ARRAY[presenter]
    WHERE cardinality(presenters) = 0 AND presenter <> '';

    INSERT INTO seminar_presenters (seminar_id, name)
    SELECT s.id, TRIM(names.name)
    FROM seminars s
    CROSS JOIN LATERAL UNNEST(s.presenters) AS names(name)
    WHERE TRIM(names.name) <> ''
    ON CONFLICT DO NOTHING;

    ALTER TABLE attendance ALTER COLUMN participant_name DROP NOT NULL;
    ALTER TABLE attendance ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS attendee_token UUID;

    CREATE INDEX IF NOT EXISTS seminars_starts_at_idx ON seminars(starts_at);
    CREATE INDEX IF NOT EXISTS attendance_seminar_id_idx ON attendance(seminar_id);
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_seminar_token_idx
      ON attendance(seminar_id, attendee_token)
      WHERE attendee_token IS NOT NULL;
  `);
}

pool.on('error', (error) => {
  console.error('Erro inesperado no pool do PostgreSQL:', error);
});
