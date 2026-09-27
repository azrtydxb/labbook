import type { RunEvaluation, RunStatus, Scalar, TypeDefinition } from '../../../shared/types';

export type { RunEvaluation, RunStatus, Scalar, TypeDefinition };
export type { DataPointDef, ParameterDef, Bounds } from '../../../shared/types';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
}

export interface Links {
  commit?: string;
  branch?: string;
  ciUrl?: string;
  other?: { label: string; url: string }[];
}

export interface Run {
  id: string;
  seq: number;
  type: { slug: string; name: string };
  typeVersion: number;
  externalId: string | null;
  runAt: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  submittedBy: string | null;
  params: Record<string, string>;
  values: Record<string, Scalar>;
  status: RunStatus;
  statusAuto: boolean;
  notes: string;
  conclusion: string;
  links: Links;
  sets: { slug: string; name: string }[];
  attachmentCount: number;
}

export interface Edit {
  id: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  editedAt: string;
  editedBy: string | null;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
  uploadedBy: string | null;
}

export interface RunDetail extends Omit<Run, 'type'> {
  type: { slug: string; name: string; currentVersion: number };
  definition: TypeDefinition;
  evaluation: RunEvaluation;
  baseline: {
    id: string;
    seq: number;
    runAt: string;
    externalId: string | null;
    params: Record<string, string>;
    values: Record<string, Scalar>;
    status: RunStatus;
  } | null;
  attachments: Attachment[];
  edits: Edit[];
}

export interface TypeSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  version: number;
  definition: TypeDefinition;
  runCount: number;
  failingCount: number;
  lastRunAt: string | null;
  primary: { key: string; label: string; unit: string; better: 'higher' | 'lower' | 'none' } | null;
  trend: { id: string; runAt: string; status: RunStatus; value: Scalar; params: Record<string, string> }[];
}

export interface TypeDetail {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  version: number;
  definition: TypeDefinition;
  merged: TypeDefinition;
  versions: { version: number; note: string; createdAt: string; createdBy: string | null }[];
  createdAt: string;
  updatedAt: string;
}

export interface SetSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  conclusion: string;
  hasConclusion: boolean;
  runCount: number;
  failingCount: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  updatedAt: string;
  types: { slug: string; name: string }[];
}

export interface SetDetail {
  id: string;
  slug: string;
  name: string;
  description: string;
  conclusion: string;
  baselineRunId: string | null;
  createdAt: string;
  updatedAt: string;
  runs: Run[];
  definitions: Record<string, TypeDefinition>;
  edits: Edit[];
}

export interface Dashboard {
  counts: {
    types: number;
    runs: number;
    runs7d: number;
    failing: number;
    sets: number;
    attachments: number;
    attachmentBytes: number;
  };
  recent: Run[];
  failing: Run[];
  regressions: {
    runId: string;
    type: { slug: string; name: string };
    runAt: string;
    params: Record<string, string>;
    key: string;
    label: string;
    unit: string;
    value: number;
    baseline: number;
    baselineRunId: string;
    deltaPct: number;
    boundFailed: boolean;
  }[];
}

export interface Token {
  id: string;
  name: string;
  prefix: string;
  owner: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  runs: number;
}
