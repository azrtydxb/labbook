// The OpenAPI document is the contract the MCP server and scripts are generated
// from, so every operation must be fully described. Needs no database: building the
// spec never queries.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createDb, type Database } from '../server/db/index.js';

interface Operation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  requestBody?: unknown;
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

describe('OpenAPI document', () => {
  let db: Database;
  let app: FastifyInstance;
  let spec: {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, unknown> };
  };

  beforeAll(async () => {
    const url = 'postgres://unused@127.0.0.1:1/unused';
    db = createDb(url);
    app = await buildApp(db, loadConfig({ DATABASE_URL: url }), { logger: false });
    await app.ready();
    spec = app.swagger() as unknown as typeof spec;
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  const operations = () =>
    Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.entries(ops).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })),
    );

  it('gives every operation a unique operationId, a summary and a tag', () => {
    const ops = operations();
    expect(ops.length).toBeGreaterThan(30);
    for (const { key, op } of ops) {
      expect(op.operationId, key).toMatch(/^[a-z][A-Za-z]+$/);
      expect(op.summary, key).toBeTruthy();
      expect(op.tags?.length, key).toBeGreaterThan(0);
    }
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('types a success response for every operation', () => {
    for (const { key, op } of operations()) {
      const ok = Object.entries(op.responses ?? {}).filter(([code]) => code.startsWith('2'));
      expect(ok.length, key).toBeGreaterThan(0);
      for (const [code, r] of ok) expect(r.content, `${key} ${code}`).toBeTruthy();
    }
  });

  it('documents the upload bodies and the named components', () => {
    expect(spec.paths['/api/v1/runs/{id}/attachments']?.post?.requestBody).toBeTruthy();
    expect(spec.paths['/api/v1/runs/{id}/attachments/{filename}']?.put?.requestBody).toBeTruthy();
    for (const name of ['Error', 'RunSummary', 'RunDetail', 'TestType', 'SetDetail', 'Baseline']) {
      expect(spec.components.schemas, name).toHaveProperty(name);
    }
  });
});
