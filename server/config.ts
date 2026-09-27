import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  adminUsername: string | undefined;
  adminPassword: string | undefined;
  /** Per-attachment cap in bytes. */
  maxAttachmentBytes: number;
  /** Cap on a JSON request body (single run with inline attachments, or a batch). */
  maxBodyBytes: number;
  sessionTtlHours: number;
  webDir: string;
  clientDir: string;
  logLevel: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function int(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 8080),
    databaseUrl,
    adminUsername: env.ADMIN_USERNAME || undefined,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    maxAttachmentBytes: int(env.MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 64 * 1024 * 1024),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 24 * 30),
    // dist/server/config.js -> dist/web
    webDir: env.WEB_DIR ?? path.resolve(here, '../web'),
    clientDir: env.CLIENT_DIR ?? path.resolve(here, '../../client'),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
