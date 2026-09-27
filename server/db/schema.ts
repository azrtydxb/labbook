import type { ColumnType, Generated } from 'kysely';
import type { RunStatus, Scalar, TypeDefinition } from '../../shared/types.js';

type CreatedAt = ColumnType<Date, never, never>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb: read as the parsed value, written as a JSON string (pg would turn arrays into PG arrays). */
type Json<T> = ColumnType<T, string, string>;

export interface Links {
  commit?: string;
  branch?: string;
  ciUrl?: string;
  other?: { label: string; url: string }[];
}

export interface UsersTable {
  id: Generated<string>;
  username: string;
  display_name: Generated<string>;
  password_hash: string;
  role: 'admin' | 'member';
  disabled: Generated<boolean>;
  created_at: CreatedAt;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  created_at: CreatedAt;
  expires_at: Timestamp;
}

export interface ApiTokensTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: CreatedAt;
  last_used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

export interface TestTypesTable {
  id: Generated<string>;
  slug: string;
  name: string;
  description: Generated<string>;
  tags: ColumnType<string[], string[] | undefined, string[]>;
  current_version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
}

export interface TestTypeVersionsTable {
  test_type_id: string;
  version: number;
  definition: Json<TypeDefinition>;
  note: Generated<string>;
  created_at: CreatedAt;
  created_by: string | null;
}

export interface RunsTable {
  id: Generated<string>;
  seq: ColumnType<number, never, never>;
  test_type_id: string;
  type_version: number;
  external_id: string | null;
  run_at: Timestamp;
  created_at: CreatedAt;
  updated_at: Timestamp;
  source: Generated<string>;
  submitted_by: string | null;
  token_id: string | null;
  params: Json<Record<string, string>>;
  results: Json<Record<string, Scalar>>;
  status: RunStatus;
  status_auto: Generated<boolean>;
  notes: Generated<string>;
  conclusion: Generated<string>;
  links: Json<Links>;
}

export interface EditsTable {
  id: Generated<number>;
  entity_type: 'run' | 'set' | 'test_type';
  entity_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  edited_by: string | null;
  edited_at: CreatedAt;
}

export interface SetsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  description: Generated<string>;
  conclusion: Generated<string>;
  baseline_run_id: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
}

export interface SetRunsTable {
  set_id: string;
  run_id: string;
  added_at: CreatedAt;
}

export interface AttachmentsTable {
  id: Generated<string>;
  run_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  data: Buffer;
  created_at: CreatedAt;
  uploaded_by: string | null;
}

export interface BaselinesTable {
  id: Generated<string>;
  test_type_id: string;
  slug: string;
  name: string;
  description: Generated<string>;
  match_keys: ColumnType<string[], string[] | undefined, string[]>;
  created_at: CreatedAt;
  updated_at: Timestamp;
  created_by: string | null;
}

export interface BaselineRunsTable {
  baseline_id: string;
  run_id: string;
  added_at: CreatedAt;
}

export interface DB {
  baselines: BaselinesTable;
  baseline_runs: BaselineRunsTable;
  users: UsersTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  test_types: TestTypesTable;
  test_type_versions: TestTypeVersionsTable;
  runs: RunsTable;
  edits: EditsTable;
  sets: SetsTable;
  set_runs: SetRunsTable;
  attachments: AttachmentsTable;
}
