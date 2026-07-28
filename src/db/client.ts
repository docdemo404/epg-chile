import { createClient, type Client, type InValue } from '@libsql/client';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../core/config.ts';

/**
 * Conexión a la base.
 *
 * Se usa libSQL en vez de better-sqlite3 porque el mismo cliente habla con un
 * archivo local y con Turso remoto: en local y en CI la base es un `.db` en
 * disco, y en Vercel —donde el sistema de archivos es efímero— es Turso. Sin
 * esto habría dos capas de datos que mantener en paralelo.
 *
 * A cambio, toda la capa de datos es asíncrona: el cliente remoto habla por
 * red y no hay forma de fingir sincronía.
 */

const here = dirname(fileURLToPath(import.meta.url));

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

function resolveUrl(): { url: string; authToken?: string } {
  const url = process.env.TURSO_DATABASE_URL;
  if (url) {
    return { url, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  // Sin Turso configurado se cae a un archivo local, que es lo que quieres
  // en desarrollo y en el runner de CI.
  mkdirSync(DATA_DIR, { recursive: true });
  return { url: `file:${join(DATA_DIR, 'epg.db')}` };
}

export function getClient(): Client {
  if (!client) client = createClient(resolveUrl());
  return client;
}

/** True si la base es Turso remoto (afecta a qué optimizaciones aplican). */
export function isRemote(): boolean {
  return Boolean(process.env.TURSO_DATABASE_URL);
}

/**
 * Aplica el esquema una sola vez por proceso.
 *
 * En Vercel cada arranque en frío ejecutaría esto; al ser todo
 * `CREATE TABLE IF NOT EXISTS` es idempotente y barato, pero se memoiza para
 * no pagar el viaje de red en cada petición.
 */
export function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      // Turso rechaza los PRAGMA de journal: los gestiona la plataforma.
      .filter((s) => !(isRemote() && /^PRAGMA\s/i.test(s)));
    for (const stmt of statements) {
      await getClient().execute(stmt);
    }
  })();
  return schemaReady;
}

export type Row = Record<string, unknown>;

/** Consulta que devuelve filas. */
export async function all<T = Row>(sql: string, args: InValue[] = []): Promise<T[]> {
  const res = await getClient().execute({ sql, args });
  return res.rows as unknown as T[];
}

/** Consulta que devuelve una fila o nada. */
export async function get<T = Row>(sql: string, args: InValue[] = []): Promise<T | undefined> {
  const rows = await all<T>(sql, args);
  return rows[0];
}

/** Sentencia sin resultado; devuelve filas afectadas y último id insertado. */
export async function run(
  sql: string,
  args: InValue[] = [],
): Promise<{ changes: number; lastInsertRowid: number }> {
  const res = await getClient().execute({ sql, args });
  return {
    changes: Number(res.rowsAffected ?? 0),
    lastInsertRowid: res.lastInsertRowid === undefined ? 0 : Number(res.lastInsertRowid),
  };
}

/**
 * Ejecuta varias sentencias en una transacción.
 *
 * En Turso esto es una sola ida y vuelta por lote, lo que importa mucho:
 * insertar 27.000 programas de uno en uno contra una base remota tardaría
 * minutos. Los llamadores agrupan en lotes grandes.
 */
export async function batch(
  statements: { sql: string; args: InValue[] }[],
): Promise<void> {
  if (!statements.length) return;
  // libSQL limita el tamaño del lote; 500 va holgado y mantiene el número de
  // viajes bajo.
  const CHUNK = 500;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await getClient().batch(statements.slice(i, i + CHUNK), 'write');
  }
}

/**
 * Ejecuta un conjunto de sentencias como una única transacción atómica.
 *
 * Importa para reemplazar la guía: `replaceMergedProgrammes` borra la ventana
 * y reinserta ~26.000 filas. Si el proceso muere a mitad —cosa normal en
 * serverless, donde la función se corta al agotar el tiempo— sin transacción
 * quedaría una guía a medias. Se comprobó: matar el servidor durante un
 * refresco dejaba 10.002 de 26.558 emisiones.
 *
 * Con esto, una interrupción deja intacta la guía anterior.
 */
export async function atomic(
  statements: { sql: string; args: InValue[] }[],
): Promise<void> {
  if (!statements.length) return;
  const tx = await getClient().transaction('write');
  try {
    for (const s of statements) {
      await tx.execute(s);
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

export async function closeClient(): Promise<void> {
  client?.close();
  client = null;
  schemaReady = null;
}
