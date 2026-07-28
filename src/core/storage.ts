import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.ts';

/**
 * Almacenamiento de los archivos EPG que sube la persona usuaria.
 *
 * Hay dos backends porque el despliegue lo exige: en Vercel el sistema de
 * archivos es efímero —lo que subas desaparece en la siguiente invocación—,
 * así que allí se usa Vercel Blob. En local y en el runner de CI se usa el
 * disco, bajo `config/uploads/`, para poder versionar los archivos en el repo.
 *
 * El resto del código no sabe cuál está activo.
 */

const LOCAL_DIR = join(CONFIG_DIR, 'uploads');
const BLOB_PREFIX = 'uploads/';

export interface StoredFile {
  name: string;
  bytes: number;
  modifiedAt: number;
}

function useBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function storageKind(): 'blob' | 'disk' {
  return useBlob() ? 'blob' : 'disk';
}

function localDir(): string {
  if (!existsSync(LOCAL_DIR)) mkdirSync(LOCAL_DIR, { recursive: true });
  return LOCAL_DIR;
}

/** Nombre seguro: se usa tal cual como clave de blob y como nombre de archivo. */
export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function listFiles(): Promise<StoredFile[]> {
  if (useBlob()) {
    const { list } = await import('@vercel/blob');
    const res = await list({ prefix: BLOB_PREFIX });
    return res.blobs.map((b) => ({
      name: b.pathname.slice(BLOB_PREFIX.length),
      bytes: b.size,
      modifiedAt: new Date(b.uploadedAt).getTime(),
    }));
  }
  const dir = localDir();
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.') && f !== 'README.md')
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, bytes: st.size, modifiedAt: st.mtimeMs };
    });
}

export async function readFile(name: string): Promise<Buffer> {
  const safe = safeName(name);
  if (useBlob()) {
    const { list } = await import('@vercel/blob');
    const res = await list({ prefix: BLOB_PREFIX + safe });
    const blob = res.blobs.find((b) => b.pathname === BLOB_PREFIX + safe);
    if (!blob) throw new Error(`No existe el archivo ${safe}`);
    const download = await fetch(blob.url);
    if (!download.ok) throw new Error(`No se pudo descargar ${safe}: HTTP ${download.status}`);
    return Buffer.from(await download.arrayBuffer());
  }
  return readFileSync(join(localDir(), safe));
}

export async function writeFile(name: string, data: Buffer): Promise<void> {
  const safe = safeName(name);
  if (useBlob()) {
    const { put } = await import('@vercel/blob');
    await put(BLOB_PREFIX + safe, data, {
      access: 'public',
      // Sin esto Vercel añade un sufijo aleatorio al nombre y no se podría
      // volver a encontrar el archivo por su clave.
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }
  writeFileSync(join(localDir(), safe), data);
}

export async function deleteFile(name: string): Promise<boolean> {
  const safe = safeName(name);
  if (useBlob()) {
    const { del, list } = await import('@vercel/blob');
    const res = await list({ prefix: BLOB_PREFIX + safe });
    const blob = res.blobs.find((b) => b.pathname === BLOB_PREFIX + safe);
    if (!blob) return false;
    await del(blob.url);
    return true;
  }
  const path = join(localDir(), safe);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export async function fileExists(name: string): Promise<boolean> {
  const files = await listFiles();
  return files.some((f) => f.name === safeName(name));
}
