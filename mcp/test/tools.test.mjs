import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  buildRequest,
  formatResponse,
  resolveSchema,
  snakeCase,
  specToTools,
  toolName,
} from '../labbook-mcp.mjs';

const uuid = { type: 'string', format: 'uuid' };

const spec = {
  openapi: '3.0.3',
  info: { title: 'fixture', version: '1' },
  components: {
    schemas: {
      Node: {
        type: 'object',
        description: 'a tree node',
        properties: { name: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } },
      },
      Run: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', description: 'Test type slug' },
          status: { type: 'string', enum: ['pass', 'fail'], default: 'pass' },
          baselineRunId: { ...uuid, nullable: true },
          score: { type: 'number', minimum: 0, exclusiveMinimum: true },
        },
      },
    },
    parameters: {
      RunId: { in: 'path', name: 'id', required: true, schema: uuid },
    },
  },
  paths: {
    '/api/v1/auth/login': { post: { summary: 'Log in' } },
    '/api/v1/auth/logout': { post: { summary: 'Log out' } },
    '/api/v1/runs': {
      get: {
        operationId: 'listRuns',
        summary: 'Query runs',
        description: 'Newest first.',
        parameters: [
          { in: 'query', name: 'type', schema: { type: 'string' }, description: 'Test type slug' },
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 100 } },
        ],
      },
      post: {
        summary: 'Submit a run',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Run' } } },
        },
      },
    },
    '/api/v1/runs/{id}': {
      parameters: [{ $ref: '#/components/parameters/RunId' }],
      get: { summary: 'A run' },
      delete: { summary: 'Delete a run' },
    },
    '/api/v1/runs/{id}/attachments': {
      post: {
        summary: 'Upload attachments',
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
      },
    },
    '/api/v1/runs/{id}/attachments/{filename}': {
      put: {
        summary: 'Upload one attachment',
        parameters: [
          { $ref: '#/components/parameters/RunId' },
          { in: 'path', name: 'filename', required: true, schema: { type: 'string' } },
        ],
        requestBody: { content: { 'application/octet-stream': { schema: {} } } },
      },
    },
    '/api/v1/test-types/{slug}/versions/{version}': {
      get: {
        summary: 'One schema version',
        parameters: [
          { in: 'path', name: 'slug', required: true, schema: { type: 'string' } },
          { in: 'path', name: 'version', required: true, schema: { type: 'integer' } },
        ],
      },
    },
    '/api/v1/trees': {
      put: {
        operationId: 'putTreeHTTPNode',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
      },
    },
  },
};

const tools = specToTools(spec);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test('names: operationId in snake_case, else method + path', () => {
  assert.equal(snakeCase('listRuns'), 'list_runs');
  assert.equal(snakeCase('putTreeHTTPNode'), 'put_tree_http_node');
  assert.equal(toolName('get', '/api/v1/runs/{id}'), 'get_runs_by_id');
  assert.equal(toolName('delete', '/api/v1/sets/{slug}/runs/{runId}'), 'delete_sets_by_slug_runs_by_run_id');
  assert.deepEqual(Object.keys(byName).sort(), [
    'delete_runs_by_id',
    'get_runs_by_id',
    'get_test_types_by_slug_versions_by_version',
    'list_runs',
    'post_runs',
    'put_runs_by_id_attachments_by_filename',
    'put_tree_http_node',
  ]);
});

test('skips login, logout and the multipart upload', () => {
  const keys = tools.map((t) => t.description.split('\n').pop());
  assert.ok(!keys.includes('POST /api/v1/auth/login'));
  assert.ok(!keys.includes('POST /api/v1/auth/logout'));
  assert.ok(!keys.includes('POST /api/v1/runs/{id}/attachments'));
});

test('leaves credential management out: users, tokens, password', () => {
  const creds = specToTools({
    paths: {
      '/api/v1/tokens': { get: { tags: ['tokens'] }, post: { tags: ['tokens'] } },
      '/api/v1/users': { get: { tags: ['users'] } },
      '/api/v1/auth/password': { post: { tags: ['auth'] } },
      '/api/v1/auth/me': { get: { tags: ['auth'] } },
    },
  });
  assert.deepEqual(
    creds.map((t) => t.name),
    ['get_auth_me'],
  );
});

test('skips the upload routes by path when the spec declares no body', () => {
  const bare = {
    paths: {
      '/api/v1/runs/{id}/attachments': { post: { parameters: [spec.components.parameters.RunId] } },
      '/api/v1/runs/{id}/attachments/{filename}': {
        put: {
          parameters: [
            spec.components.parameters.RunId,
            { in: 'path', name: 'filename', required: true, schema: { type: 'string' } },
          ],
        },
      },
    },
  };
  const [only, ...rest] = specToTools(bare);
  assert.equal(rest.length, 0);
  assert.equal(only.name, 'put_runs_by_id_attachments_by_filename');
  assert.equal(only.request.kind, 'raw');
});

test('description, annotations and query schema', () => {
  const t = byName.list_runs;
  assert.equal(t.description, 'Query runs\n\nNewest first.\n\nGET /api/v1/runs');
  assert.deepEqual(t.annotations, { title: 'Query runs', readOnlyHint: true, idempotentHint: true });
  assert.deepEqual(t.inputSchema.properties.type, { type: 'string', description: 'Test type slug' });
  assert.equal(t.inputSchema.properties.limit.default, 100);
  assert.equal(t.inputSchema.properties.params.additionalProperties.type, 'string');
  assert.equal(t.inputSchema.required, undefined);
  assert.equal(byName.delete_runs_by_id.annotations.destructiveHint, true);
  assert.equal(byName.post_runs.annotations.idempotentHint, undefined);
});

test('refs are inlined, 3.0 dialect becomes JSON Schema, body is required when the requestBody is', () => {
  const t = byName.post_runs;
  assert.deepEqual(t.inputSchema.required, ['body']);
  const body = t.inputSchema.properties.body;
  assert.deepEqual(body.required, ['type']);
  assert.deepEqual(body.properties.status, { type: 'string', enum: ['pass', 'fail'], default: 'pass' });
  assert.deepEqual(body.properties.baselineRunId.type, ['string', 'null']);
  assert.equal(body.properties.baselineRunId.format, 'uuid');
  assert.deepEqual(body.properties.score, { type: 'number', exclusiveMinimum: 0 });
  assert.ok(!JSON.stringify(tools).includes('$ref'));
  // path-level parameter $ref
  assert.deepEqual(byName.get_runs_by_id.inputSchema.required, ['id']);
});

test('a $ref cycle is cut after one level', () => {
  const node = resolveSchema({ $ref: '#/components/schemas/Node' }, spec);
  assert.equal(node.description, 'a tree node');
  assert.match(node.properties.child.description, /recursive Node/);
  assert.equal(node.properties.child.properties, undefined);
  assert.equal(byName.put_tree_http_node.inputSchema.properties.body.properties.child.type, undefined);
});

test('buildRequest: path encoding, query, param.* expansion', () => {
  const r = buildRequest(
    byName.list_runs.request,
    { type: 'turbine', limit: 5, params: { model: 'llama 3', gpu: 'R9700' } },
    'https://lb.test',
    'lbk_x',
  );
  assert.equal(r.url, 'https://lb.test/api/v1/runs?type=turbine&limit=5&param.model=llama+3&param.gpu=R9700');
  assert.equal(r.method, 'GET');
  assert.equal(r.headers.authorization, 'Bearer lbk_x');
  assert.equal(r.body, undefined);

  const v = buildRequest(
    byName.get_test_types_by_slug_versions_by_version.request,
    { slug: 'a/b c', version: 2 },
    'https://lb.test',
  );
  assert.equal(v.url, 'https://lb.test/api/v1/test-types/a%2Fb%20c/versions/2');
  assert.throws(() => buildRequest(byName.get_runs_by_id.request, {}, 'https://lb.test'), /missing path/);
});

test('buildRequest: JSON body and raw upload', () => {
  const j = buildRequest(byName.post_runs.request, { body: { type: 't' } }, 'https://lb.test', 'k');
  assert.equal(j.headers['content-type'], 'application/json');
  assert.equal(j.body, '{"type":"t"}');

  const up = byName.put_runs_by_id_attachments_by_filename;
  assert.deepEqual(Object.keys(up.inputSchema.properties).sort(), [
    'content',
    'contentBase64',
    'contentType',
    'filename',
    'id',
  ]);
  const t = buildRequest(up.request, { id: 'r1', filename: 'notes.md', content: 'hé' }, 'https://lb.test');
  assert.equal(t.url, 'https://lb.test/api/v1/runs/r1/attachments/notes.md');
  assert.equal(t.headers['content-type'], 'application/octet-stream');
  assert.deepEqual(t.body, Buffer.from('hé'));
  const b = buildRequest(
    up.request,
    { id: 'r1', filename: 'x.png', contentBase64: 'iVBO', contentType: 'image/png' },
    'https://lb.test',
  );
  assert.equal(b.headers['content-type'], 'image/png');
  assert.deepEqual(b.body, Buffer.from('iVBO', 'base64'));
  assert.throws(() => buildRequest(up.request, { id: 'r1', filename: 'x' }, 'https://lb.test'), /content/);
});

test('formatResponse', () => {
  const ok = formatResponse(200, 'application/json; charset=utf-8', Buffer.from('{"a":1}'));
  assert.deepEqual(ok, { content: [{ type: 'text', text: '{\n  "a": 1\n}' }], structuredContent: { a: 1 } });
  assert.equal(formatResponse(200, 'application/json', Buffer.from('[1]')).structuredContent, undefined);
  const err = formatResponse(404, 'application/json', Buffer.from('{"error":"not_found"}'));
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /^HTTP 404\n/);
  assert.equal(formatResponse(200, 'text/csv', Buffer.from('a,b\n')).content[0].text, 'a,b\n');
  assert.equal(formatResponse(200, 'image/png', Buffer.from([1, 2])).content[0].type, 'image');
  assert.match(
    formatResponse(200, 'application/octet-stream', Buffer.from([1]), 'attachment; filename="x.bin"')
      .content[0].text,
    /^1 bytes of application\/octet-stream \(x\.bin\), base64:\nAQ==$/,
  );
  assert.match(
    formatResponse(200, 'application/zip', Buffer.alloc(300 * 1024)).content[0].text,
    /too large to inline/,
  );
});
