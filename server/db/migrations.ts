import { Kysely, sql } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

// Migrations live in code (not files) so the compiled image carries them and the
// order is explicit. Append new entries; never edit a released one.
const migrations: Record<string, Migration> = {
  '0001_init': {
    async up(db: Kysely<any>) {
      await sql`
        create table users (
          id uuid primary key default gen_random_uuid(),
          username text not null unique,
          display_name text not null default '',
          password_hash text not null,
          role text not null check (role in ('admin', 'member')),
          disabled boolean not null default false,
          created_at timestamptz not null default now()
        );

        create table sessions (
          id text primary key,
          user_id uuid not null references users(id) on delete cascade,
          created_at timestamptz not null default now(),
          expires_at timestamptz not null
        );
        create index sessions_user_idx on sessions(user_id);

        create table api_tokens (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references users(id) on delete cascade,
          name text not null,
          token_hash text not null unique,
          prefix text not null,
          created_at timestamptz not null default now(),
          last_used_at timestamptz,
          revoked_at timestamptz
        );

        create table test_types (
          id uuid primary key default gen_random_uuid(),
          slug text not null unique,
          name text not null,
          description text not null default '',
          tags text[] not null default '{}',
          current_version integer not null default 1,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references users(id) on delete set null
        );

        create table test_type_versions (
          test_type_id uuid not null references test_types(id) on delete cascade,
          version integer not null,
          definition jsonb not null,
          note text not null default '',
          created_at timestamptz not null default now(),
          created_by uuid references users(id) on delete set null,
          primary key (test_type_id, version)
        );

        create table runs (
          id uuid primary key default gen_random_uuid(),
          seq bigint generated always as identity unique,
          test_type_id uuid not null references test_types(id) on delete restrict,
          type_version integer not null,
          external_id text,
          run_at timestamptz not null default now(),
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          source text not null default '',
          submitted_by uuid references users(id) on delete set null,
          token_id uuid references api_tokens(id) on delete set null,
          params jsonb not null default '{}',
          results jsonb not null default '{}',
          status text not null check (status in ('pass', 'fail', 'error', 'info')),
          status_auto boolean not null default false,
          notes text not null default '',
          conclusion text not null default '',
          links jsonb not null default '{}',
          unique (test_type_id, external_id),
          foreign key (test_type_id, type_version) references test_type_versions(test_type_id, version)
        );
        create index runs_type_time_idx on runs(test_type_id, run_at, seq);
        create index runs_time_idx on runs(run_at desc, seq desc);
        create index runs_params_idx on runs using gin (params jsonb_path_ops);

        create table edits (
          id bigint generated always as identity primary key,
          entity_type text not null check (entity_type in ('run', 'set', 'test_type')),
          entity_id uuid not null,
          field text not null,
          old_value text,
          new_value text,
          edited_by uuid references users(id) on delete set null,
          edited_at timestamptz not null default now()
        );
        create index edits_entity_idx on edits(entity_type, entity_id, edited_at);

        create table sets (
          id uuid primary key default gen_random_uuid(),
          slug text not null unique,
          name text not null,
          description text not null default '',
          conclusion text not null default '',
          baseline_run_id uuid references runs(id) on delete set null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references users(id) on delete set null
        );

        create table set_runs (
          set_id uuid not null references sets(id) on delete cascade,
          run_id uuid not null references runs(id) on delete cascade,
          added_at timestamptz not null default now(),
          primary key (set_id, run_id)
        );
        create index set_runs_run_idx on set_runs(run_id);

        create table attachments (
          id uuid primary key default gen_random_uuid(),
          run_id uuid not null references runs(id) on delete cascade,
          filename text not null,
          content_type text not null,
          size_bytes integer not null,
          sha256 text not null,
          data bytea not null,
          created_at timestamptz not null default now(),
          uploaded_by uuid references users(id) on delete set null,
          unique (run_id, filename)
        );
      `.execute(db);
    },
    async down(db: Kysely<any>) {
      await sql`
        drop table if exists attachments, set_runs, sets, edits, runs, test_type_versions,
          test_types, api_tokens, sessions, users cascade
      `.execute(db);
    },
  },
  // Pinned baselines: named reference groups per test type (e.g. "vLLM-ROCm 0.23.0"),
  // one member run per combination of the match keys (e.g. one per model).
  '0002_baselines': {
    async up(db: Kysely<any>) {
      await sql`
        create table baselines (
          id uuid primary key default gen_random_uuid(),
          test_type_id uuid not null references test_types(id) on delete cascade,
          slug text not null,
          name text not null,
          description text not null default '',
          match_keys text[] not null default '{}',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references users(id) on delete set null,
          unique (test_type_id, slug)
        );

        create table baseline_runs (
          baseline_id uuid not null references baselines(id) on delete cascade,
          run_id uuid not null references runs(id) on delete cascade,
          added_at timestamptz not null default now(),
          primary key (baseline_id, run_id)
        );
        create index baseline_runs_run_idx on baseline_runs(run_id);
      `.execute(db);
    },
    async down(db: Kysely<any>) {
      await sql`drop table if exists baseline_runs, baselines`.execute(db);
    },
  },
};

class CodeMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export async function migrateToLatest(db: Kysely<any>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new CodeMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
