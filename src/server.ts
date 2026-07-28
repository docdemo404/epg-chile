import { buildApp } from './app.ts';
import { loadConfig } from './core/config.ts';
import { startScheduler } from './scheduler.ts';

/**
 * Servidor local y para contenedores.
 *
 * En Vercel no se usa este archivo: allí el entrypoint es `src/vercel-entry.ts`, que
 * envuelve la misma app sin escuchar en un puerto ni arrancar el scheduler
 * (en serverless no hay proceso vivo donde un cron interno pueda correr; de
 * eso se encarga GitHub Actions).
 */

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = await buildApp();
const cfg = loadConfig();

if (process.env.EPG_SCHEDULER !== 'off') {
  startScheduler(app.log);
}

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Panel disponible en http://localhost:${PORT}/panel (${cfg.app.timezone})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
