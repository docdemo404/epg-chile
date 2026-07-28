import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CACHE_DIR, loadConfig, type RateLimitConfig } from './config.ts';

/**
 * Cliente HTTP compartido por los adaptadores.
 *
 * Las tres fuentes son endpoints no documentados de terceros, así que este
 * cliente es el único punto por donde salen requests: aquí viven el límite de
 * concurrencia, la pausa entre llamadas, el respeto de `Retry-After` y la
 * caché en disco. El objetivo es refrescar la guía unas pocas veces al día,
 * no golpear en bucle.
 */

class RateLimiter {
  #active = 0;
  #lastStart = 0;
  #queue: (() => void)[] = [];
  readonly cfg: RateLimitConfig;

  constructor(cfg: RateLimitConfig) {
    this.cfg = cfg;
  }

  async acquire(): Promise<void> {
    if (this.#active >= this.cfg.concurrency) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active++;
    const since = Date.now() - this.#lastStart;
    if (since < this.cfg.minDelayMs) {
      await sleep(this.cfg.minDelayMs - since);
    }
    this.#lastStart = Date.now();
  }

  release(): void {
    this.#active--;
    const next = this.#queue.shift();
    if (next) next();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const limiters = new Map<string, RateLimiter>();

function limiterFor(sourceId: string, cfg: RateLimitConfig): RateLimiter {
  let l = limiters.get(sourceId);
  if (!l) {
    l = new RateLimiter(cfg);
    limiters.set(sourceId, l);
  }
  return l;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** Desactiva la caché en disco para esta llamada. */
  noCache?: boolean;
  /** TTL propio en minutos; por defecto usa http.cacheTtlMinutes. */
  cacheTtlMinutes?: number;
}

function cachePath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return join(CACHE_DIR, `${hash}.json`);
}

function readCache(key: string, ttlMinutes: number): string | null {
  const path = cachePath(key);
  if (!existsSync(path)) return null;
  const ageMs = Date.now() - statSync(path).mtimeMs;
  if (ageMs > ttlMinutes * 60_000) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function writeCache(key: string, value: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(key), value, 'utf8');
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/**
 * Ejecuta un request con límite de tasa, reintentos con backoff exponencial y
 * caché en disco. Devuelve el cuerpo como texto.
 */
export async function request(
  sourceId: string,
  url: string,
  opts: RequestOptions = {},
): Promise<string> {
  const cfg = loadConfig();
  const source = cfg.sources.find((s) => s.id === sourceId);
  const rate = source?.rateLimit ?? { concurrency: 2, minDelayMs: 500 };
  const method = opts.method ?? 'GET';
  const cacheKey = `${method} ${url} ${opts.body ? JSON.stringify(opts.body) : ''}`;
  const ttl = opts.cacheTtlMinutes ?? cfg.http.cacheTtlMinutes;

  if (!opts.noCache && ttl > 0) {
    const hit = readCache(cacheKey, ttl);
    if (hit !== null) return hit;
  }

  const limiter = limiterFor(sourceId, rate);
  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.http.retries; attempt++) {
    await limiter.acquire();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.http.timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': cfg.app.userAgent,
            'Accept-Encoding': 'gzip, deflate',
            ...opts.headers,
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });

        // El servidor pide esperar: obedecer antes de cualquier reintento.
        if (res.status === 429 || res.status === 503) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 0);
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : cfg.http.backoffBaseMs * 2 ** attempt;
          throw new HttpError(`${res.status}, esperando ${waitMs}ms`, res.status, url);
        }
        if (!res.ok) {
          throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
        }

        const text = await decodeBody(res);
        if (!opts.noCache && ttl > 0) writeCache(cacheKey, text);
        return text;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = err;
      // 4xx distintos de 429 son errores de la petición: reintentar no ayuda.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      if (attempt < cfg.http.retries) {
        await sleep(cfg.http.backoffBaseMs * 2 ** attempt);
      }
    } finally {
      limiter.release();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Falló el request a ${url}: ${String(lastError)}`);
}

/**
 * `fetch` descomprime gzip automáticamente salvo cuando el servidor manda un
 * `Content-Type` de descarga binaria (así sirve programadorx sus .xml.gz). En
 * ese caso hay que descomprimir a mano.
 */
async function decodeBody(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  // Cabecera mágica de gzip.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

export async function requestJson<T>(
  sourceId: string,
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const text = await request(sourceId, url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Respuesta no es JSON válido desde ${url}: ${text.slice(0, 200)}`);
  }
}

/** Ejecuta tareas con un tope de concurrencia, preservando el orden de salida. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
