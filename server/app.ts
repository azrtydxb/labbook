import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { registerAuth } from './auth.js';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { HttpError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { runRoutes } from './routes/runs.js';
import { setRoutes } from './routes/sets.js';
import { typeRoutes } from './routes/types.js';

export async function buildApp(
  db: Database,
  cfg: Config,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: cfg.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: cfg.maxAttachmentBytes, files: 50 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'labbook API',
        version: '1',
        description:
          'Test-results lab book. Authenticate with `Authorization: Bearer <token>` (create tokens in the GUI ' +
          'under Admin → API tokens). Define a test type once (PUT /api/v1/test-types/{slug}), then submit runs ' +
          '(POST /api/v1/runs, idempotent with externalId).',
      },
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      return reply
        .code(400)
        .send({ error: 'validation failed', message: fe.message, details: fe.validation });
    }
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: fe.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal error' });
  });

  registerAuth(app, db);

  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await sql`select 1`.execute(db);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  authRoutes(app, db, cfg);
  typeRoutes(app, db);
  runRoutes(app, db, cfg);
  setRoutes(app, db);
  dashboardRoutes(app, db);

  // The uploader, downloadable from the running instance.
  const submitScript = path.join(cfg.clientDir, 'labbook-submit.mjs');
  app.get('/labbook-submit.mjs', { schema: { hide: true } }, async (_req, reply) => {
    if (!existsSync(submitScript)) return reply.code(404).send({ error: 'not bundled' });
    reply.header('Content-Disposition', 'attachment; filename="labbook-submit.mjs"');
    return reply.type('text/javascript; charset=utf-8').sendFile('labbook-submit.mjs', cfg.clientDir);
  });

  if (existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, {
      root: cfg.webDir,
      prefix: '/',
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
  } else {
    // sendFile is still needed for the uploader route.
    await app.register(fastifyStatic, { root: cfg.clientDir, serve: false });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    if (req.method === 'GET' && !url.startsWith('/api/') && existsSync(path.join(cfg.webDir, 'index.html'))) {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html', cfg.webDir);
    }
    return reply.code(404).send({ error: 'not found' });
  });

  return app;
}
