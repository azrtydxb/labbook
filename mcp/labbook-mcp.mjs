#!/usr/bin/env node
// labbook-mcp: the labbook API as MCP tools over stdio, one tool per operation of the live OpenAPI spec.
//
//   LABBOOK_URL=https://labbook.kw.watteel.lab node labbook-mcp.mjs [--token-file <file>]
//
// token, first found: --token-file <file>, $LABBOOK_TOKEN_FILE, $LABBOOK_TOKEN, ~/.config/labbook/token
// (read on every call, so a token created after startup is picked up without a restart).
// The OS trust store is used (as NODE_USE_SYSTEM_CA=1 would); NODE_EXTRA_CA_CERTS for any other CA.
//
// The spec at $LABBOOK_URL/api/docs/json is fetched at startup and on the refresh_spec tool.
// stdout carries the MCP protocol; diagnostics go to stderr.

/* global fetch, AbortSignal -- the root eslint config gives node globals only to client/ and importers/ */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL, URLSearchParams, fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// Session-cookie endpoints are meaningless for a bearer-token agent; credential
// management (passwords, users, API tokens) stays with humans in the GUI.
const SKIPPED = new Set([
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/password',
]);
const SKIPPED_TAGS = new Set(['users', 'tokens']);
// Specs that predate declared upload bodies: recognise the two upload routes by path.
const MULTIPART_FALLBACK = 'POST /api/v1/runs/{id}/attachments';
const RAW_FALLBACK = 'PUT /api/v1/runs/{id}/attachments/{filename}';
// The runs query accepts param.<key>=<value>; fastify-swagger flattens the query schema and drops that.
const PARAM_FILTER_FALLBACK = new Set(['GET /api/v1/runs', 'GET /api/v1/export']);
const TIMEOUT_MS = 60_000;
const MAX_INLINE_BINARY = 256 * 1024;

export function snakeCase(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

// operationId when present (listRuns → list_runs), else method + path: GET /api/v1/runs/{id} → get_runs_by_id.
export function toolName(method, path, operationId) {
  if (operationId) return snakeCase(operationId);
  const segs = path
    .replace(/^\/api\/v1(?=\/|$)/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith('{') ? `by_${snakeCase(s.slice(1, -1))}` : snakeCase(s)));
  return [method.toLowerCase(), ...segs].join('_');
}

function pointer(spec, ref) {
  if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`);
  let node = spec;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
  return node;
}

// Inline every $ref (MCP clients need self-contained schemas) and turn OpenAPI 3.0 dialect into JSON Schema:
// nullable → a "null" type, boolean exclusiveMinimum/Maximum → numeric. A cycle becomes an open schema.
export function resolveSchema(node, spec, stack = []) {
  if (Array.isArray(node)) return node.map((n) => resolveSchema(n, spec, stack));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop();
    if (stack.includes(node.$ref)) return { description: `(recursive ${name}; see the enclosing schema)` };
    const { $ref: _ref, ...siblings } = node;
    const target = resolveSchema(pointer(spec, node.$ref), spec, [...stack, node.$ref]);
    return { ...target, ...resolveSchema(siblings, spec, stack) };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolveSchema(v, spec, stack);
  if (out.nullable === true) {
    delete out.nullable;
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null'];
    else if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
  } else if (out.nullable === false) delete out.nullable;
  for (const [ex, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ]) {
    if (out[ex] === true) {
      out[ex] = out[bound];
      delete out[bound];
    } else if (out[ex] === false) delete out[ex];
  }
  return out;
}

function bodyKind(key, requestBody) {
  const types = Object.keys(requestBody?.content ?? {});
  if (!requestBody) return key === RAW_FALLBACK ? 'raw' : key === MULTIPART_FALLBACK ? 'multipart' : null;
  if (types.some((t) => t.includes('json'))) return 'json';
  if (types.length > 0 && types.every((t) => t === 'multipart/form-data')) return 'multipart';
  return 'raw';
}

export function specToTools(spec) {
  const tools = [];
  const names = new Set(['refresh_spec']);
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const shared = item.parameters ?? [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const key = `${method.toUpperCase()} ${path}`;
      if (SKIPPED.has(key) || op.tags?.some((t) => SKIPPED_TAGS.has(t))) continue;
      const requestBody = op.requestBody && resolveSchema(op.requestBody, spec);
      const kind = bodyKind(key, requestBody);
      if (kind === 'multipart') continue;

      // Operation-level parameters override path-level ones with the same name and location.
      const params = new Map();
      for (const p of [...shared, ...(op.parameters ?? [])].map((p) => resolveSchema(p, spec))) {
        params.set(`${p.in}:${p.name}`, p);
      }
      const properties = {};
      const required = [];
      const pathParams = [];
      const queryParams = [];
      for (const p of params.values()) {
        if (p.in !== 'path' && p.in !== 'query') continue;
        const schema = { ...(p.schema ?? { type: 'string' }) };
        if (p.description && !schema.description) schema.description = p.description;
        properties[p.name] = schema;
        if (p.in === 'path' || p.required) required.push(p.name);
        (p.in === 'path' ? pathParams : queryParams).push(p.name);
      }

      const paramFilters =
        PARAM_FILTER_FALLBACK.has(key) || /param\.<key>/.test(`${op.summary ?? ''} ${op.description ?? ''}`);
      if (paramFilters) {
        properties.params = {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Filter on run parameters: {"model": "llama"} is sent as param.model=llama',
        };
      }

      if (kind === 'json') {
        const media = Object.entries(requestBody.content).find(([t]) => t.includes('json'))[1];
        properties.body = { ...(media.schema ?? {}) };
        if (requestBody.description && !properties.body.description) {
          properties.body.description = requestBody.description;
        }
        if (requestBody.required) required.push('body');
      } else if (kind === 'raw') {
        properties.content = { type: 'string', description: 'File content as UTF-8 text' };
        properties.contentBase64 = {
          type: 'string',
          description: 'File content, base64-encoded (for binary files); use instead of content',
        };
        properties.contentType = {
          type: 'string',
          description: 'Content-Type of the file (default application/octet-stream)',
        };
      }

      let name = toolName(method, path, op.operationId);
      for (let i = 2; names.has(name); i++) name = `${toolName(method, path, op.operationId)}_${i}`;
      names.add(name);

      const text = [op.summary, op.description].filter(Boolean).join('\n\n');
      const annotations = {};
      if (op.summary) annotations.title = op.summary;
      if (method === 'get') annotations.readOnlyHint = true;
      if (method === 'delete') annotations.destructiveHint = true;
      if (['get', 'put', 'delete'].includes(method)) annotations.idempotentHint = true;

      tools.push({
        name,
        description: `${text ? `${text}\n\n` : ''}${key}`,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        annotations,
        request: { method: method.toUpperCase(), path, pathParams, queryParams, kind, paramFilters },
      });
    }
  }
  return tools;
}

// Returns { url, method, headers, body } for fetch; throws on a missing path parameter or upload content.
export function buildRequest(request, args, baseUrl, token) {
  let path = request.path;
  for (const name of request.pathParams) {
    const v = args[name];
    if (v === undefined || v === null || v === '') throw new Error(`missing path parameter '${name}'`);
    path = path.replace(`{${name}}`, encodeURIComponent(String(v)));
  }
  const query = new URLSearchParams();
  for (const name of request.queryParams) {
    const v = args[name];
    if (v === undefined || v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) query.append(name, String(item));
  }
  if (request.paramFilters && args.params && typeof args.params === 'object') {
    for (const [k, v] of Object.entries(args.params)) query.append(`param.${k}`, String(v));
  }
  const qs = query.toString();
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (request.kind === 'json' && args.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(args.body);
  } else if (request.kind === 'raw') {
    if (typeof args.contentBase64 === 'string') body = Buffer.from(args.contentBase64, 'base64');
    else if (typeof args.content === 'string') body = Buffer.from(args.content, 'utf8');
    else throw new Error("provide the file as 'content' (text) or 'contentBase64'");
    headers['content-type'] = args.contentType || 'application/octet-stream';
  }
  return { url: `${baseUrl}${path}${qs ? `?${qs}` : ''}`, method: request.method, headers, body };
}

// An HTTP response as an MCP tool result.
export function formatResponse(status, contentType, buf, disposition) {
  const ok = status >= 200 && status < 300;
  const ct = (contentType || '').toLowerCase();
  const mime = ct.split(';')[0].trim();
  if (buf.length === 0)
    return { content: [{ type: 'text', text: `HTTP ${status} (no content)` }], isError: !ok };
  if (mime.includes('json')) {
    const text = buf.toString('utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { content: [{ type: 'text', text: `HTTP ${status}\n${text}` }], isError: !ok };
    }
    const pretty = JSON.stringify(data, null, 2);
    if (!ok) return { content: [{ type: 'text', text: `HTTP ${status}\n${pretty}` }], isError: true };
    const result = { content: [{ type: 'text', text: pretty }] };
    if (data && typeof data === 'object' && !Array.isArray(data)) result.structuredContent = data;
    return result;
  }
  if (!ok || mime.startsWith('text/') || /csv|xml|yaml|javascript/.test(mime)) {
    const text = buf.toString('utf8');
    return { content: [{ type: 'text', text: ok ? text : `HTTP ${status}\n${text}` }], isError: !ok };
  }
  if (mime.startsWith('image/')) {
    return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: mime }] };
  }
  const name = /filename="?([^";]+)"?/.exec(disposition || '')?.[1];
  let note = `${buf.length} bytes of ${mime || 'unknown type'}${name ? ` (${name})` : ''}`;
  note +=
    buf.length <= MAX_INLINE_BINARY
      ? `, base64:\n${buf.toString('base64')}`
      : `; too large to inline (limit ${MAX_INLINE_BINARY} bytes)`;
  return { content: [{ type: 'text', text: note }] };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

// { token } or { error } — never throws, never logs the token.
function readToken() {
  const defaultFile = join(homedir(), '.config', 'labbook', 'token');
  const file =
    argValue('--token-file') ||
    process.env.LABBOOK_TOKEN_FILE ||
    (!process.env.LABBOOK_TOKEN && existsSync(defaultFile) ? defaultFile : '');
  let token = process.env.LABBOOK_TOKEN || '';
  if (file) {
    try {
      token = readFileSync(file, 'utf8').trim();
    } catch (e) {
      return { error: `cannot read token file ${file}: ${e.message}` };
    }
  }
  if (token) return { token: token.trim() };
  return {
    error:
      'no labbook API token. Create one in the labbook GUI under Admin → API tokens, then save it to ' +
      '~/.config/labbook/token (or point $LABBOOK_TOKEN_FILE / --token-file at a file, or set $LABBOOK_TOKEN). ' +
      'The token is read on every call, so no restart is needed.',
  };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

async function fetchSpec(baseUrl) {
  const res = await fetch(`${baseUrl}/api/docs/json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /api/docs/json → HTTP ${res.status}`);
  return res.json();
}

function describeFetchError(e, baseUrl) {
  if (e?.name === 'TimeoutError') return `timed out after ${TIMEOUT_MS / 1000}s`;
  const cause = e?.cause ? ` (${e.cause.code || e.cause.message})` : '';
  return `cannot reach ${baseUrl}: ${e.message}${cause}. For a certificate error set NODE_EXTRA_CA_CERTS.`;
}

const REFRESH_TOOL = {
  name: 'refresh_spec',
  description:
    'Re-fetch the labbook OpenAPI spec and rebuild the tool list (after a labbook upgrade, or if the ' +
    'spec could not be fetched at startup).',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'Refresh the API spec', idempotentHint: true },
};

async function main() {
  const baseUrl = (process.env.LABBOOK_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    process.stderr.write('labbook-mcp: set LABBOOK_URL (e.g. https://labbook.kw.watteel.lab)\n');
    process.exit(2);
  }
  // MCP clients launched from a GUI do not inherit NODE_USE_SYSTEM_CA from the shell, and the cluster CA
  // lives in the OS store; setDefaultCACertificates needs Node >= 22.19.
  if (tls.setDefaultCACertificates) {
    const cas = [...tls.getCACertificates('default'), ...tls.getCACertificates('system')];
    tls.setDefaultCACertificates([...new Set(cas)]);
  }
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

  let tools = [];
  let info = {};
  async function load() {
    const spec = await fetchSpec(baseUrl);
    tools = specToTools(spec);
    info = spec.info ?? {};
  }
  try {
    await load();
  } catch (e) {
    // Start anyway so the client sees refresh_spec and can retry once labbook is reachable.
    process.stderr.write(`labbook-mcp: spec not loaded: ${describeFetchError(e, baseUrl)}\n`);
  }

  const server = new Server(
    { name: 'labbook', version: pkg.version },
    { capabilities: { tools: { listChanged: true } }, instructions: info.description },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.map(({ request: _request, ...tool }) => tool), REFRESH_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    if (params.name === 'refresh_spec') {
      try {
        await load();
      } catch (e) {
        return errorResult(`spec not loaded: ${describeFetchError(e, baseUrl)}`);
      }
      await server.sendToolListChanged();
      return {
        content: [
          {
            type: 'text',
            text: `${tools.length} tools from ${info.title ?? 'the spec'} v${info.version ?? '?'}`,
          },
        ],
      };
    }
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) return errorResult(`unknown tool '${params.name}'`);
    const { token, error } = readToken();
    if (error) return errorResult(error);

    let req;
    try {
      req = buildRequest(tool.request, args, baseUrl, token);
    } catch (e) {
      return errorResult(e.message);
    }
    let res;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return errorResult(`${req.method} ${tool.request.path}: ${describeFetchError(e, baseUrl)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return formatResponse(
      res.status,
      res.headers.get('content-type'),
      buf,
      res.headers.get('content-disposition'),
    );
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`labbook-mcp: ${tools.length} tools from ${baseUrl}\n`);
}

// Run only as a script, not when imported by the tests. realpath both sides: npm's bin is a symlink.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((e) => {
    process.stderr.write(`labbook-mcp: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
