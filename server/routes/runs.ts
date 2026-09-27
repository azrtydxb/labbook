import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { badRequest, notFound } from '../errors.js';
import type { TypeDefinition } from '../../shared/types.js';
import { runsToCsv } from '../services/export.js';
import {
  getRunDetail,
  guessContentType,
  listRuns,
  patchRun,
  RunInputSchema,
  RunPatchSchema,
  submitRun,
  upsertAttachment,
  type RunFilter,
} from '../services/runs.js';
import { getDefinition, mergedDefinition } from '../services/testTypes.js';

const ListQuery = z
  .object({
    type: z.string().optional().describe('Test type slug'),
    set: z.string().optional().describe('Set slug'),
    status: z.string().optional().describe('Comma-separated: pass,fail,error,info'),
    q: z.string().max(200).optional().describe('Search notes, conclusion, params, source, links'),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    ids: z.string().optional().describe('Comma-separated run ids'),
    limit: z.coerce.number().int().min(1).max(10000).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .catchall(z.string())
  .describe('Filter on parameters with param.<key>=<value>, e.g. param.model=llama');

type ListQueryT = z.output<typeof ListQuery>;

function toFilter(q: ListQueryT): RunFilter {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (k.startsWith('param.') && typeof v === 'string') params[k.slice(6)] = v;
  }
  const statuses = q.status?.split(',').filter(Boolean) ?? [];
  for (const s of statuses)
    if (!['pass', 'fail', 'error', 'info'].includes(s)) throw badRequest(`bad status ${s}`);
  const ids = q.ids?.split(',').filter(Boolean);
  if (ids?.some((i) => !z.uuid().safeParse(i).success)) throw badRequest('ids must be uuids');
  return {
    type: q.type,
    set: q.set,
    status: statuses as RunFilter['status'],
    params,
    from: q.from,
    to: q.to,
    q: q.q,
    ids,
    limit: q.limit,
    offset: q.offset,
    order: q.order,
  };
}

const IdParams = z.object({ id: z.uuid() });

export function runRoutes(app: FastifyInstance, db: Database, cfg: Config): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/v1/runs',
    { schema: { tags: ['runs'], summary: 'Query runs', querystring: ListQuery } },
    async (req) => {
      requireUser(req);
      return listRuns(db, toFilter(req.query));
    },
  );

  r.post(
    '/api/v1/runs',
    {
      bodyLimit: cfg.maxBodyBytes,
      schema: {
        tags: ['runs'],
        summary: 'Submit a run (upsert by type + externalId)',
        body: RunInputSchema,
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const res = await submitRun(
        db,
        req.body,
        { userId: me.id, tokenId: req.tokenId },
        cfg.maxAttachmentBytes,
      );
      reply.code(res.created ? 201 : 200);
      return res;
    },
  );

  r.post(
    '/api/v1/runs/batch',
    {
      bodyLimit: cfg.maxBodyBytes,
      schema: {
        tags: ['runs'],
        summary: 'Submit many runs; each is its own transaction and reports its own result',
        body: z.object({ runs: z.array(RunInputSchema).min(1).max(1000) }),
      },
    },
    async (req) => {
      const me = requireUser(req);
      const results = [];
      for (const [index, run] of req.body.runs.entries()) {
        try {
          const res = await submitRun(
            db,
            run,
            { userId: me.id, tokenId: req.tokenId },
            cfg.maxAttachmentBytes,
          );
          results.push({ index, ok: true, ...res });
        } catch (e) {
          const err = e as { message?: string; details?: unknown };
          results.push({ index, ok: false, error: err.message ?? String(e), details: err.details });
        }
      }
      const failed = results.filter((x) => !x.ok).length;
      return {
        created: results.filter((x) => x.ok && 'created' in x && x.created).length,
        updated: results.filter((x) => x.ok && 'created' in x && !x.created).length,
        failed,
        results,
      };
    },
  );

  r.get(
    '/api/v1/runs/:id',
    {
      schema: {
        tags: ['runs'],
        summary: 'A run with its evaluation against bounds and baseline, attachments and edit history',
        params: IdParams,
      },
    },
    async (req) => {
      requireUser(req);
      return getRunDetail(db, req.params.id);
    },
  );

  r.patch(
    '/api/v1/runs/:id',
    {
      schema: {
        tags: ['runs'],
        summary: 'Edit notes, conclusion, status, links, params or values (every change is logged)',
        params: IdParams,
        body: RunPatchSchema,
      },
    },
    async (req) => {
      const me = requireUser(req);
      const changed = await patchRun(db, req.params.id, req.body, me.id);
      return { changed };
    },
  );

  r.delete(
    '/api/v1/runs/:id',
    { schema: { tags: ['runs'], summary: 'Delete a run (admin)', params: IdParams } },
    async (req) => {
      requireAdmin(req);
      const res = await db.deleteFrom('runs').where('id', '=', req.params.id).executeTakeFirst();
      if (!Number(res.numDeletedRows)) throw notFound('run not found');
      return { ok: true };
    },
  );

  // ---- attachments ---------------------------------------------------------

  r.post(
    '/api/v1/runs/:id/attachments',
    {
      schema: {
        tags: ['attachments'],
        summary: 'Upload attachments (multipart/form-data, one or more files; same filename replaces)',
        params: IdParams,
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const run = await db.selectFrom('runs').select('id').where('id', '=', req.params.id).executeTakeFirst();
      if (!run) throw notFound('run not found');
      if (!req.isMultipart()) throw badRequest('expected multipart/form-data');
      const out = [];
      for await (const part of req.files({ limits: { fileSize: cfg.maxAttachmentBytes } })) {
        const data = await part.toBuffer();
        if (part.file.truncated) throw badRequest(`${part.filename} exceeds ${cfg.maxAttachmentBytes} bytes`);
        const res = await upsertAttachment(
          db,
          run.id,
          {
            filename: part.filename,
            contentType:
              part.mimetype && part.mimetype !== 'application/octet-stream'
                ? part.mimetype
                : guessContentType(part.filename),
            data,
          },
          cfg.maxAttachmentBytes,
          me.id,
        );
        out.push({ filename: part.filename, ...res });
      }
      reply.code(201);
      return { attachments: out };
    },
  );

  // Raw upload for scripts: the body is the file, any content type.
  app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: cfg.maxAttachmentBytes },
      (_req, body, done) => done(null, body),
    );
    raw.withTypeProvider<ZodTypeProvider>().put(
      '/api/v1/runs/:id/attachments/:filename',
      {
        schema: {
          tags: ['attachments'],
          summary: 'Upload one attachment as the raw request body (curl --data-binary @file)',
          params: IdParams.extend({ filename: z.string().min(1).max(255) }),
        },
      },
      async (req, reply) => {
        const me = requireUser(req);
        const run = await db
          .selectFrom('runs')
          .select('id')
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!run) throw notFound('run not found');
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
        const res = await upsertAttachment(
          db,
          run.id,
          {
            filename: req.params.filename,
            contentType: ct && ct !== 'application/octet-stream' ? ct : guessContentType(req.params.filename),
            data: body,
          },
          cfg.maxAttachmentBytes,
          me.id,
        );
        reply.code(201);
        return { filename: req.params.filename, ...res };
      },
    );
  });

  r.get(
    '/api/v1/attachments/:id',
    {
      schema: {
        tags: ['attachments'],
        summary: 'Download an attachment (inline=1 serves text as text/plain for viewing)',
        params: IdParams,
        querystring: z.object({ inline: z.enum(['0', '1']).optional() }),
      },
    },
    async (req, reply) => {
      requireUser(req);
      const a = await db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!a) throw notFound('attachment not found');
      const inline = req.query.inline === '1';
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      reply.header(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      );
      // Never let an uploaded HTML/SVG file render on this origin.
      const textual = /^(text\/|application\/(json|yaml|xml|x-ndjson))/.test(a.content_type);
      reply.type(inline && textual ? 'text/plain; charset=utf-8' : a.content_type);
      return reply.send(a.data);
    },
  );

  r.delete(
    '/api/v1/attachments/:id',
    { schema: { tags: ['attachments'], summary: 'Delete an attachment', params: IdParams } },
    async (req) => {
      requireUser(req);
      const res = await db.deleteFrom('attachments').where('id', '=', req.params.id).executeTakeFirst();
      if (!Number(res.numDeletedRows)) throw notFound('attachment not found');
      return { ok: true };
    },
  );

  // ---- export & compare ----------------------------------------------------

  r.get(
    '/api/v1/export',
    {
      schema: {
        tags: ['export'],
        summary: 'Export runs as CSV or JSON (same filters as GET /runs; limit defaults to 10000)',
        querystring: ListQuery.extend({
          format: z.enum(['csv', 'json']).default('csv'),
          limit: z.coerce.number().int().min(1).max(100000).default(10000),
        }),
      },
    },
    async (req, reply) => {
      requireUser(req);
      const f = toFilter(req.query);
      const { runs } = await listRuns(db, f);
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `labbook-${req.query.type ?? req.query.set ?? 'runs'}-${stamp}`;
      if (req.query.format === 'json') {
        reply.header('Content-Disposition', `attachment; filename="${name}.json"`);
        return { exportedAt: new Date(), filter: req.query, runs };
      }
      const defs = new Map<string, TypeDefinition>();
      const types = await db.selectFrom('test_types').select(['id', 'slug']).execute();
      for (const slug of new Set(runs.map((x) => x.type.slug))) {
        const t = types.find((x) => x.slug === slug);
        if (t) defs.set(slug, await mergedDefinition(db, t.id));
      }
      reply.header('Content-Disposition', `attachment; filename="${name}.csv"`);
      reply.type('text/csv; charset=utf-8');
      return runsToCsv(runs, defs);
    },
  );

  r.get(
    '/api/v1/compare',
    {
      schema: {
        tags: ['runs'],
        summary: 'Several runs with their definitions, for side-by-side comparison',
        querystring: z.object({ ids: z.string().describe('Comma-separated run ids (2-12)') }),
      },
    },
    async (req) => {
      requireUser(req);
      const ids = req.query.ids.split(',').filter(Boolean);
      if (ids.length < 1 || ids.length > 12) throw badRequest('give 1-12 run ids');
      if (ids.some((i) => !z.uuid().safeParse(i).success)) throw badRequest('ids must be uuids');
      const { runs } = await listRuns(db, { ids, limit: ids.length, offset: 0, order: 'asc' });
      const ordered = ids.map((id) => runs.find((x) => x.id === id)).filter((x) => x !== undefined);
      const definitions: Record<string, TypeDefinition> = {};
      for (const run of ordered) {
        const t = await db
          .selectFrom('test_types')
          .select('id')
          .where('slug', '=', run.type.slug)
          .executeTakeFirstOrThrow();
        definitions[`${run.type.slug}@${run.typeVersion}`] = await getDefinition(db, t.id, run.typeVersion);
      }
      return { runs: ordered, definitions };
    },
  );
}
