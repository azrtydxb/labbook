// Response schemas: the OpenAPI spec's single source of truth for what the API
// returns. Fastify serializes every documented response through them, so a handler
// that drifts from its schema fails loudly (test suite) instead of lying in the spec.
// `.meta({ id })` turns a schema into a named component under #/components/schemas.
// No .transform() here: the serializer encodes, and transforms cannot be encoded.
import { z } from 'zod';

export const ErrorSchema = z
  .object({
    error: z.string().describe('Short, human-readable reason'),
    message: z.string().optional().describe('Validator message (validation failures)'),
    details: z.unknown().optional().describe('Per-field problems, when there are any'),
  })
  .meta({ id: 'Error' });

const ERROR_TEXT: Record<number, string> = {
  400: 'Invalid request (validation failed, bad values, incompatible schema change)',
  401: 'Missing, invalid or revoked credentials',
  403: 'Authenticated but not allowed (admin only, or a session-only action)',
  404: 'Not found',
  409: 'Conflicts with existing data',
  429: 'Too many attempts',
};

/** Error responses for a route; every authenticated route can answer 400 and 401. */
export function errors(...codes: (403 | 404 | 409 | 429)[]) {
  const out: Record<
    number,
    { description: string; content: { 'application/json': { schema: typeof ErrorSchema } } }
  > = {};
  for (const c of [400, 401, ...codes]) {
    out[c] = { description: ERROR_TEXT[c]!, content: { 'application/json': { schema: ErrorSchema } } };
  }
  return out;
}

export const OkSchema = z.object({ ok: z.boolean() }).meta({ id: 'Ok' });
export const ChangedSchema = z
  .object({ changed: z.array(z.string()).describe('Fields that actually changed (empty: no-op)') })
  .meta({ id: 'Changed' });

const date = () => z.date().describe('ISO 8601 timestamp');
export const Scalar = z.union([z.number(), z.boolean(), z.string(), z.null()]).meta({ id: 'Scalar' });
export const RunStatusSchema = z.enum(['pass', 'fail', 'error', 'info']).meta({ id: 'RunStatus' });
const Params = z.record(z.string(), z.string()).describe('Parameters, stored as strings');
const Values = z.record(z.string(), Scalar).describe('Data point values by key');

// ---- users & tokens --------------------------------------------------------

export const UserSchema = z
  .object({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string(),
    role: z.enum(['admin', 'member']),
  })
  .meta({ id: 'User' });

export const UserListItemSchema = UserSchema.extend({ disabled: z.boolean(), createdAt: date() }).meta({
  id: 'UserListItem',
});

export const ApiTokenSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    prefix: z.string().describe('First characters of the token, to recognise it'),
    owner: z.string(),
    createdAt: date(),
    lastUsedAt: date().nullable(),
    revokedAt: date().nullable(),
    runs: z.number().int().describe('Runs submitted with this token'),
  })
  .meta({ id: 'ApiToken' });

// ---- test types --------------------------------------------------------------

export const TargetOut = z
  .object({
    ref: z.enum(['absolute', 'baseline', 'best']),
    baseline: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    label: z.string().optional(),
  })
  .meta({
    id: 'Target',
    description:
      'A zone that counts as good (grades runs on/below target; never changes pass/fail). absolute: ' +
      'min/max in the unit; baseline: ratios of the matching pinned-baseline member; best: ratios of the ' +
      'best earlier comparable run.',
  });

export const TypeDefinitionOut = z
  .object({
    parameters: z.array(
      z.object({ key: z.string(), label: z.string(), description: z.string(), identity: z.boolean() }),
    ),
    dataPoints: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        unit: z.string(),
        type: z.enum(['number', 'boolean', 'string']),
        better: z.enum(['higher', 'lower', 'none']),
        description: z.string(),
        bounds: z
          .object({
            min: z.number().optional(),
            max: z.number().optional(),
            relMin: z.number().optional(),
            relMax: z.number().optional(),
            expected: z.union([z.boolean(), z.string()]).optional(),
          })
          .optional(),
        targets: z.array(TargetOut).optional(),
      }),
    ),
    primary: z.string().optional(),
  })
  .meta({ id: 'TypeDefinition' });

export const TestTypeSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    version: z.number().int().describe('Current schema version'),
    definition: TypeDefinitionOut,
    createdAt: date(),
    updatedAt: date(),
  })
  .meta({ id: 'TestType' });

export const TestTypeDetailSchema = TestTypeSchema.extend({
  merged: TypeDefinitionOut.describe('Union of every version, latest first (to read old runs)'),
  versions: z.array(
    z.object({
      version: z.number().int(),
      note: z.string(),
      createdAt: date(),
      createdBy: z.string().nullable(),
    }),
  ),
}).meta({ id: 'TestTypeDetail' });

export const TestTypeSummarySchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    version: z.number().int(),
    definition: TypeDefinitionOut,
    runCount: z.number().int(),
    failingCount: z.number().int(),
    lastRunAt: date().nullable(),
    primary: z
      .object({
        key: z.string(),
        label: z.string(),
        unit: z.string(),
        better: z.enum(['higher', 'lower', 'none']),
      })
      .nullable(),
    trend: z.array(
      z.object({
        id: z.uuid(),
        runAt: date(),
        status: RunStatusSchema,
        value: Scalar,
        params: Params,
      }),
    ),
    updatedAt: date(),
  })
  .meta({ id: 'TestTypeSummary' });

export const TypeUpsertResultSchema = z
  .object({
    slug: z.string(),
    created: z.boolean(),
    versionCreated: z.boolean().describe('The definition changed, so a new version was recorded'),
    version: z.number().int(),
  })
  .meta({ id: 'TypeUpsertResult' });

// ---- runs ------------------------------------------------------------------

export const LinksOut = z
  .object({
    commit: z.string().optional(),
    branch: z.string().optional(),
    ciUrl: z.string().optional(),
    other: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
  })
  .meta({ id: 'Links' });

const SetRef = z.object({ slug: z.string(), name: z.string() });

export const RunSummarySchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int().describe('Global submission order'),
    type: z.object({ slug: z.string(), name: z.string() }),
    typeVersion: z.number().int(),
    externalId: z.string().nullable(),
    runAt: date(),
    createdAt: date(),
    updatedAt: date(),
    source: z.string(),
    submittedBy: z.string().nullable(),
    params: Params,
    values: Values,
    status: RunStatusSchema,
    statusAuto: z.boolean().describe('Status was computed from the bounds, not set by hand'),
    notes: z.string(),
    conclusion: z.string(),
    links: LinksOut,
    sets: z.array(SetRef),
    attachmentCount: z.number().int(),
    baselineOf: z.array(SetRef).describe('Pinned baselines this run is a member of'),
    target: z
      .enum(['on', 'off', 'none'])
      .describe('Target grade: off if any target zone is missed, on if all measurable ones are met'),
  })
  .meta({ id: 'RunSummary' });

export const RunListSchema = z
  .object({
    total: z.number().int().describe('Matches before limit/offset'),
    runs: z.array(RunSummarySchema),
  })
  .meta({ id: 'RunList' });

export const RunSubmitResultSchema = z
  .object({
    id: z.uuid(),
    created: z.boolean().describe('false: an existing run with this externalId was updated'),
    status: RunStatusSchema,
    changed: z.array(z.string()),
  })
  .meta({ id: 'RunSubmitResult' });

export const EditSchema = z
  .object({
    id: z.number().int(),
    field: z.string(),
    oldValue: z.string().nullable(),
    newValue: z.string().nullable(),
    editedAt: date(),
    editedBy: z.string().nullable(),
  })
  .meta({ id: 'Edit' });

export const PointEvaluationSchema = z
  .object({
    key: z.string(),
    value: Scalar.optional(),
    baseline: Scalar.optional(),
    delta: z.number().nullable(),
    deltaPct: z.number().nullable(),
    improved: z.boolean().nullable().describe('Moved in the "better" direction; null when not applicable'),
    verdict: z.enum(['pass', 'fail', 'none', 'missing']),
    reasons: z.array(z.string()),
  })
  .meta({ id: 'PointEvaluation' });

export const AttachmentSchema = z
  .object({
    id: z.uuid(),
    filename: z.string(),
    contentType: z.string(),
    size: z.number().int(),
    sha256: z.string(),
    createdAt: date(),
    uploadedBy: z.string().nullable(),
  })
  .meta({ id: 'Attachment' });

// ---- pinned baselines & targets --------------------------------------------

export const BaselineSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    matchKeys: z.array(z.string()).describe('Parameters a member shares with the runs it applies to'),
    createdAt: date(),
    updatedAt: date(),
    members: z.array(
      z.object({
        runId: z.uuid(),
        match: z.record(z.string(), z.string()).describe('The member run params on the match keys'),
        runAt: date(),
        externalId: z.string().nullable(),
        label: z.string(),
        params: Params,
        values: Values,
      }),
    ),
  })
  .meta({ id: 'Baseline' });

export const BaselineComparisonSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    runId: z.uuid().describe('The matching member run'),
    runAt: date(),
    label: z.string(),
    match: z.record(z.string(), z.string()),
    points: z.array(
      z.object({
        key: z.string(),
        value: Scalar.optional(),
        baseline: Scalar.optional(),
        delta: z.number().nullable(),
        deltaPct: z.number().nullable().describe('Fraction: 0.03 = 3% above the baseline'),
        ratio: z.number().nullable().describe('value / baseline: 1.03 = 103% of the baseline'),
        improved: z.boolean().nullable(),
      }),
    ),
  })
  .meta({ id: 'BaselineComparison' });

export const TargetResultSchema = z
  .object({
    key: z.string(),
    index: z.number().int().describe("Position in the data point's targets"),
    label: z.string(),
    ref: z.enum(['absolute', 'baseline', 'best']),
    baseline: z.string().optional(),
    referenceRunId: z.uuid().nullable(),
    reference: z.number().nullable(),
    zone: z.object({ min: z.number().nullable(), max: z.number().nullable() }).describe('In the unit'),
    value: z.number().nullable(),
    verdict: z.enum(['on', 'off', 'unknown']).describe('unknown: no value or no reference yet'),
  })
  .meta({ id: 'TargetResult' });

export const RunDetailSchema = RunSummarySchema.extend({
  type: z.object({ slug: z.string(), name: z.string(), currentVersion: z.number().int() }),
  definition: TypeDefinitionOut.describe('The definition version this run was recorded under'),
  evaluation: z.object({
    verdict: z.enum(['pass', 'fail', 'none']),
    points: z.array(PointEvaluationSchema),
  }),
  baseline: z
    .object({
      id: z.uuid(),
      seq: z.number().int(),
      runAt: date(),
      externalId: z.string().nullable(),
      params: Params,
      values: Values,
      status: RunStatusSchema,
    })
    .nullable()
    .describe('Previous run of the same type with equal identity parameters (used by the bounds)'),
  baselines: z
    .array(BaselineComparisonSchema)
    .describe('Every pinned baseline with a member matching this run (informational)'),
  targets: z.array(TargetResultSchema).describe('The run graded against the target zones'),
  attachments: z.array(AttachmentSchema),
  edits: z.array(EditSchema),
}).meta({ id: 'RunDetail' });

export const AttachmentUploadSchema = z
  .object({ filename: z.string(), id: z.uuid(), size: z.number().int() })
  .meta({ id: 'AttachmentUpload' });

// ---- sets ------------------------------------------------------------------

export const SetSummarySchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    hasConclusion: z.boolean(),
    conclusion: z.string(),
    runCount: z.number().int(),
    failingCount: z.number().int(),
    firstRunAt: date().nullable(),
    lastRunAt: date().nullable(),
    createdAt: date(),
    updatedAt: date(),
    types: z.array(SetRef),
  })
  .meta({ id: 'SetSummary' });

export const SetDetailSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    conclusion: z.string(),
    baselineRunId: z.uuid().nullable(),
    createdAt: date(),
    updatedAt: date(),
    runs: z.array(RunSummarySchema),
    definitions: z.record(z.string(), TypeDefinitionOut).describe('Merged definition by type slug'),
    edits: z.array(EditSchema),
  })
  .meta({ id: 'SetDetail' });

export const SetRefResultSchema = z.object({ id: z.uuid(), slug: z.string() }).meta({ id: 'SetRef' });

// ---- dashboard -------------------------------------------------------------

export const DashboardSchema = z
  .object({
    counts: z.object({
      types: z.number().int(),
      runs: z.number().int(),
      runs7d: z.number().int(),
      failing: z.number().int(),
      sets: z.number().int(),
      attachments: z.number().int(),
      attachmentBytes: z.number().int(),
    }),
    recent: z.array(RunSummarySchema),
    failing: z.array(RunSummarySchema),
    regressions: z.array(
      z.object({
        runId: z.uuid(),
        type: z.object({ slug: z.string(), name: z.string() }),
        runAt: date(),
        params: Params,
        key: z.string(),
        label: z.string(),
        unit: z.string(),
        value: z.number(),
        baseline: z.number(),
        baselineRunId: z.uuid(),
        deltaPct: z.number(),
        boundFailed: z.boolean().describe('A relative bound failed (else: the headline moved the wrong way)'),
      }),
    ),
  })
  .meta({ id: 'Dashboard' });
