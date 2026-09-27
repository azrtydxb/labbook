import { buildApp } from './app.js';
import { seedAdmin } from './auth.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrateToLatest } from './db/migrations.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl);
  const applied = await migrateToLatest(db);
  const seeded = await seedAdmin(db, cfg.adminUsername, cfg.adminPassword);
  const app = await buildApp(db, cfg);
  app.log.info({ migrations: applied, admin: seeded }, 'database ready');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: cfg.host, port: cfg.port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
