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

  // Un fallo de base no debe tumbar la app entera: si arranca, el panel puede
  // cargar y explicar qué falta configurar. Un 500 sin cuerpo no dice nada.
  let dbError: string | null = null;
  try {
    await initDb();
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
    app.log.error(`Base no disponible: ${dbError}`);
  }

  // Las rutas que necesitan datos responden 503 con el motivo, en vez de
  // reventar con un stack trace. `/api/stats` se responde aquí mismo con
  // ceros: es lo que alimenta el aviso del panel, así que tiene que llegar.
  app.addHook('onRequest', async (req, reply) => {
    if (!dbError) return;
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/epg/')) return;

    if (req.url.startsWith('/api/stats')) {
      return reply.send({
        channels: 0,
        multiSourceChannels: 0,
        programmes: 0,
        coverage: { desc: 0, image: 0, credits: 0, category: 0, episode: 0 },
        timezone: cfg.app.timezone,
        ephemeral: true,
        setupError: dbError,
      });
    }
    if (req.url.startsWith('/api/sources')) return reply.send([]);
    if (req.url.startsWith('/api/channels') || req.url.startsWith('/api/profiles')) {
      return reply.send([]);
    }
    return reply.code(503).send({ error: dbError, needsSetup: true });
  });

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
