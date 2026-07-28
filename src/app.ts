import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './core/config.ts';
import { initDb } from './db/repo.ts';
import { registerApiRoutes } from './api/routes.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Construye la app sin escuchar en un puerto.
 *
 * Está separado de `server.ts` porque en Vercel no hay proceso que escuche:
 * el handler serverless necesita la instancia de Fastify a secas. El servidor
 * local y el handler comparten exactamente esta configuración, así que no hay
 * dos versiones de la app que puedan divergir.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const cfg = loadConfig();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 20 * 1024 * 1024,
    // Vercel entrega la petición ya con la cabecera de proto correcta.
    trustProxy: true,
  });

  await initDb();

  // Las guías XMLTV comprimidas de terceros rondan los pocos MB; 64 deja
  // margen de sobra para un XML sin comprimir de una guía grande.
  await app.register(fastifyMultipart, { limits: { fileSize: 64 * 1024 * 1024 } });

  await app.register(fastifyStatic, {
    root: join(here, 'panel'),
    prefix: '/panel/',
  });

  app.get('/panel', async (_req, reply) => reply.sendFile('index.html'));
  app.get('/', async (_req, reply) => reply.redirect('/panel'));
  app.get('/health', async () => ({ ok: true, timezone: cfg.app.timezone }));

  registerApiRoutes(app);
  return app;
}
