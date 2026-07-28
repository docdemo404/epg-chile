import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';

/**
 * Entrypoint serverless de Vercel.
 *
 * Vercel invoca esta función para cada petición. La instancia de Fastify se
 * cachea entre invocaciones que reusan el mismo contenedor: construirla en
 * cada petición añadiría cientos de milisegundos por nada.
 *
 * No arranca el scheduler: en serverless no hay proceso vivo entre peticiones
 * donde un cron interno pueda correr. La ingesta la dispara GitHub Actions.
 */

let appPromise: Promise<FastifyInstance> | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const app = await buildApp();
      // Fastify necesita estar listo antes de inyectarle peticiones crudas.
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const app = await getApp();
  app.server.emit('request', req, res);
}
