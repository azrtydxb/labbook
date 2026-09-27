import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.js';

// int8 (seq, counts) as JS numbers: every value here stays far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Database = Kysely<DB>;

export function createDb(connectionString: string, max = 10): Database {
  const pool = new pg.Pool({ connectionString, max });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
