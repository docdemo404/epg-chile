import type { InValue } from '@libsql/client';
import { loadConfig } from '../core/config.ts';
import { all, atomic, batch, ensureSchema, get, run } from './client.ts';
import type {
  Channel,
  Credits,
  EpisodeRef,
  ImageRef,
  MergedProgramme,
  RawChannel,
  RawProgramme,
} from '../core/types.ts';

/**
 * Capa de datos.
 *
 * Toda la API es asíncrona porque la base puede ser Turso remoto (ver
 * `client.ts`). Las escrituras masivas van siempre por `batch`: contra una
 * base remota, insertar 27.000 programas de uno en uno tardaría minutos.
 */

let initialized: Promise<void> | null = null;

/** Prepara el esquema y sincroniza la tabla de fuentes con sources.yaml. */
export function initDb(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    await ensureSchema();
    const cfg = loadConfig();
    await batch(
      cfg.sources.map((s) => ({
        sql: `INSERT INTO sources (id, priority, enabled) VALUES (?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET priority = excluded.priority, enabled = excluded.enabled`,
        args: [s.id, s.priority, s.enabled ? 1 : 0] as InValue[],
      })),
    );
  })();
  return initialized;
}

const json = (v: unknown): string => JSON.stringify(v ?? null);

const parse = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  try {
    const parsed = JSON.parse(String(v));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
};

const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s.length ? s : undefined;
};

const num = (v: unknown): number => Number(v ?? 0);

// ---------------------------------------------------------------- raw layer

export async function saveRawChannels(sourceId: string, channels: RawChannel[]): Promise<void> {
  await initDb();
  const now = Date.now();
  await batch(
    channels.map((c) => ({
      sql: `INSERT INTO raw_channels
              (source_id, source_channel_id, name, full_name, number, logos_json, is_hd, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, source_channel_id) DO UPDATE SET
              name = excluded.name, full_name = excluded.full_name, number = excluded.number,
              logos_json = excluded.logos_json, is_hd = excluded.is_hd,
              raw_json = excluded.raw_json, fetched_at = excluded.fetched_at`,
      args: [
        sourceId,
        c.sourceChannelId,
        c.name,
        c.fullName ?? null,
        c.number ?? null,
        json(c.logos ?? []),
        c.isHD ? 1 : 0,
        c.raw === undefined ? null : json(c.raw),
        now,
      ] as InValue[],
    })),
  );
  await run('UPDATE sources SET channel_count = ? WHERE id = ?', [channels.length, sourceId]);
}

export async function saveRawProgrammes(
  sourceId: string,
  programmes: RawProgramme[],
): Promise<number> {
  await initDb();
  const now = Date.now();
  await batch(
    programmes.map((p) => ({
      sql: `INSERT INTO raw_programmes
              (source_id, source_channel_id, start, stop, title, sub_title, desc,
               categories_json, images_json, credits_json, rating, episode_json,
               series_id, external_ids_json, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, source_channel_id, start, title) DO UPDATE SET
              stop = excluded.stop, sub_title = excluded.sub_title, desc = excluded.desc,
              categories_json = excluded.categories_json, images_json = excluded.images_json,
              credits_json = excluded.credits_json, rating = excluded.rating,
              episode_json = excluded.episode_json, series_id = excluded.series_id,
              external_ids_json = excluded.external_ids_json, raw_json = excluded.raw_json,
              fetched_at = excluded.fetched_at`,
      args: [
        sourceId,
        p.sourceChannelId,
        p.start,
        p.stop,
        p.title,
        p.subTitle ?? null,
        p.desc ?? null,
        json(p.categories ?? []),
        json(p.images ?? []),
        p.credits ? json(p.credits) : null,
        p.rating ?? null,
        p.episode ? json(p.episode) : null,
        p.seriesId ?? null,
        json(p.externalIds ?? {}),
        p.raw === undefined ? null : json(p.raw),
        now,
      ] as InValue[],
    })),
  );
  const row = await get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM raw_programmes WHERE source_id = ?',
    [sourceId],
  );
  await run('UPDATE sources SET programme_count = ? WHERE id = ?', [num(row?.c), sourceId]);
  return programmes.length;
}

function rowToRawChannel(r: Record<string, unknown>): RawChannel {
  return {
    sourceId: String(r.source_id),
    sourceChannelId: String(r.source_channel_id),
    name: String(r.name),
    fullName: str(r.full_name),
    number: r.number === null || r.number === undefined ? undefined : Number(r.number),
    logos: parse<ImageRef[]>(r.logos_json, []),
    isHD: Number(r.is_hd) === 1,
  };
}

export async function getRawChannels(sourceId?: string): Promise<RawChannel[]> {
  await initDb();
  const rows = sourceId
    ? await all('SELECT * FROM raw_channels WHERE source_id = ? ORDER BY number, name', [sourceId])
    : await all('SELECT * FROM raw_channels ORDER BY source_id, number, name');
  return rows.map(rowToRawChannel);
}

function rowToRawProgramme(r: Record<string, unknown>): RawProgramme {
  return {
    sourceId: String(r.source_id),
    sourceChannelId: String(r.source_channel_id),
    start: Number(r.start),
    stop: Number(r.stop),
    title: String(r.title),
    subTitle: str(r.sub_title),
    desc: str(r.desc),
    categories: parse<string[]>(r.categories_json, []),
    images: parse<ImageRef[]>(r.images_json, []),
    credits: r.credits_json ? parse<Credits | undefined>(r.credits_json, undefined) : undefined,
    rating: str(r.rating),
    episode: r.episode_json ? parse<EpisodeRef | undefined>(r.episode_json, undefined) : undefined,
    seriesId: str(r.series_id),
    externalIds: parse<Record<string, string>>(r.external_ids_json, {}),
  };
}

export async function getRawProgrammesInWindow(from: number, to: number): Promise<RawProgramme[]> {
  await initDb();
  const rows = await all(
    'SELECT * FROM raw_programmes WHERE stop > ? AND start < ? ORDER BY start',
    [from, to],
  );
  return rows.map(rowToRawProgramme);
}

export async function purgeOldProgrammes(before: number): Promise<number> {
  await initDb();
  const a = await run('DELETE FROM raw_programmes WHERE stop < ?', [before]);
  const b = await run('DELETE FROM programmes WHERE stop < ?', [before]);
  return a.changes + b.changes;
}

// ------------------------------------------------------------ channel layer

export async function replaceChannels(
  channels: {
    xmltvId: string;
    canonicalName: string;
    altNames: string[];
    logos: ImageRef[];
    links: {
      sourceId: string;
      sourceChannelId: string;
      number?: number;
      confidence: number;
      manual: boolean;
    }[];
  }[],
): Promise<void> {
  await initDb();
  const now = Date.now();

  // Los ids se conservan entre recálculos reusándolos por `xmltv_id`. Borrar
  // e insertar de nuevo los renumeraría en cada refresco y dejaría sin efecto
  // los enlaces permanentes ya creados.
  const existing = await all<{ id: number; xmltv_id: string }>(
    'SELECT id, xmltv_id FROM channels',
  );
  const idByXmltv = new Map(existing.map((r) => [String(r.xmltv_id), Number(r.id)]));

  await run('DELETE FROM channel_links');

  const keep = new Set<number>();
  const linkStatements: { sql: string; args: InValue[] }[] = [];

  for (const c of channels) {
    let id = idByXmltv.get(c.xmltvId);
    if (id === undefined) {
      const res = await run(
        `INSERT INTO channels (xmltv_id, canonical_name, alt_names_json, logos_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [c.xmltvId, c.canonicalName, json(c.altNames), json(c.logos), now],
      );
      id = res.lastInsertRowid;
    } else {
      await run(
        `UPDATE channels SET canonical_name = ?, alt_names_json = ?, logos_json = ?, updated_at = ?
         WHERE id = ?`,
        [c.canonicalName, json(c.altNames), json(c.logos), now, id],
      );
    }
    keep.add(id);
    for (const l of c.links) {
      linkStatements.push({
        sql: `INSERT INTO channel_links
                (channel_id, source_id, source_channel_id, number, confidence, manual)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [id, l.sourceId, l.sourceChannelId, l.number ?? null, l.confidence, l.manual ? 1 : 0],
      });
    }
  }
  await batch(linkStatements);

  // Los canales que dejaron de existir se retiran, con sus programas.
  const gone = existing.filter((r) => !keep.has(Number(r.id))).map((r) => Number(r.id));
  if (gone.length) {
    const placeholders = gone.map(() => '?').join(',');
    await run(`DELETE FROM programmes WHERE channel_id IN (${placeholders})`, gone);
    await run(`DELETE FROM channels WHERE id IN (${placeholders})`, gone);
  }
}

export interface ChannelWithLinks extends Channel {
  links: { sourceId: string; sourceChannelId: string; confidence: number; manual: boolean }[];
}

export async function getChannels(): Promise<ChannelWithLinks[]> {
  await initDb();
  const chans = await all('SELECT * FROM channels ORDER BY canonical_name');
  const links = await all('SELECT * FROM channel_links');

  const byChannel = new Map<number, Record<string, unknown>[]>();
  for (const l of links) {
    const cid = Number(l.channel_id);
    const arr = byChannel.get(cid) ?? [];
    arr.push(l);
    byChannel.set(cid, arr);
  }

  return chans.map((c) => {
    const id = Number(c.id);
    const ls = byChannel.get(id) ?? [];
    const numbers: Record<string, number> = {};
    for (const l of ls) {
      if (l.number !== null && l.number !== undefined) numbers[String(l.source_id)] = Number(l.number);
    }
    return {
      id,
      xmltvId: String(c.xmltv_id),
      canonicalName: String(c.canonical_name),
      altNames: parse<string[]>(c.alt_names_json, []),
      numbers,
      logos: parse<ImageRef[]>(c.logos_json, []),
      sources: [...new Set(ls.map((l) => String(l.source_id)))],
      links: ls.map((l) => ({
        sourceId: String(l.source_id),
        sourceChannelId: String(l.source_channel_id),
        confidence: Number(l.confidence),
        manual: Number(l.manual) === 1,
      })),
    };
  });
}

/** Índice (sourceId, sourceChannelId) -> channelId, usado por la fusión. */
export async function getChannelLinkIndex(): Promise<Map<string, number>> {
  await initDb();
  const rows = await all('SELECT channel_id, source_id, source_channel_id FROM channel_links');
  return new Map(
    rows.map((r) => [`${String(r.source_id)}::${String(r.source_channel_id)}`, Number(r.channel_id)]),
  );
}

// ------------------------------------------------------------- merged layer

export async function replaceMergedProgrammes(
  from: number,
  to: number,
  programmes: MergedProgramme[],
): Promise<void> {
  await initDb();
  const now = Date.now();
  // Borrado y reinserción en una sola transacción: si el proceso muere a
  // mitad, la guía anterior sigue en pie en vez de quedar truncada.
  await atomic([
    { sql: 'DELETE FROM programmes WHERE stop > ? AND start < ?', args: [from, to] },
    ...programmes.map((p) => ({
      sql: `INSERT INTO programmes
              (channel_id, start, stop, title, sub_title, desc, categories_json, images_json,
               credits_json, rating, episode_json, series_id, external_ids_json,
               provenance_json, sources_json, merged_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(channel_id, start) DO UPDATE SET
              stop = excluded.stop, title = excluded.title, sub_title = excluded.sub_title,
              desc = excluded.desc, categories_json = excluded.categories_json,
              images_json = excluded.images_json, credits_json = excluded.credits_json,
              rating = excluded.rating, episode_json = excluded.episode_json,
              series_id = excluded.series_id, external_ids_json = excluded.external_ids_json,
              provenance_json = excluded.provenance_json, sources_json = excluded.sources_json,
              merged_at = excluded.merged_at`,
      args: [
        p.channelId,
        p.start,
        p.stop,
        p.title,
        p.subTitle ?? null,
        p.desc ?? null,
        json(p.categories ?? []),
        json(p.images ?? []),
        p.credits ? json(p.credits) : null,
        p.rating ?? null,
        p.episode ? json(p.episode) : null,
        p.seriesId ?? null,
        json(p.externalIds ?? {}),
        json(p.provenance ?? {}),
        json(p.contributingSources ?? []),
        now,
      ] as InValue[],
    })),
  ]);
}

export async function getMergedProgrammes(opts: {
  from?: number;
  to?: number;
  channelIds?: number[];
}): Promise<MergedProgramme[]> {
  await initDb();
  const conds: string[] = [];
  const params: InValue[] = [];
  if (opts.from !== undefined) {
    conds.push('stop > ?');
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    conds.push('start < ?');
    params.push(opts.to);
  }
  if (opts.channelIds?.length) {
    conds.push(`channel_id IN (${opts.channelIds.map(() => '?').join(',')})`);
    params.push(...opts.channelIds);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await all(`SELECT * FROM programmes ${where} ORDER BY channel_id, start`, params);

  return rows.map((r) => ({
    channelId: Number(r.channel_id),
    start: Number(r.start),
    stop: Number(r.stop),
    title: String(r.title),
    subTitle: str(r.sub_title),
    desc: str(r.desc),
    categories: parse<string[]>(r.categories_json, []),
    images: parse<ImageRef[]>(r.images_json, []),
    credits: r.credits_json ? parse<Credits | undefined>(r.credits_json, undefined) : undefined,
    rating: str(r.rating),
    episode: r.episode_json ? parse<EpisodeRef | undefined>(r.episode_json, undefined) : undefined,
    seriesId: str(r.series_id),
    externalIds: parse<Record<string, string>>(r.external_ids_json, {}),
    provenance: parse(r.provenance_json, {}),
    contributingSources: parse<string[]>(r.sources_json, []),
  }));
}

/** Emisiones por canal en una ventana, contadas en SQL. */
export async function countProgrammesByChannel(
  from: number,
  to: number,
): Promise<Map<number, number>> {
  await initDb();
  const rows = await all(
    'SELECT channel_id, COUNT(*) AS n FROM programmes WHERE stop > ? AND start < ? GROUP BY channel_id',
    [from, to],
  );
  return new Map(rows.map((r) => [Number(r.channel_id), Number(r.n)]));
}

export interface CoverageStats {
  total: number;
  withDesc: number;
  withImage: number;
  withCredits: number;
  withCategory: number;
  withEpisode: number;
}

/** Cobertura de metadatos agregada en SQL, sin materializar la guía entera. */
export async function getCoverageStats(from: number, to: number): Promise<CoverageStats> {
  await initDb();
  const row = await get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN desc IS NOT NULL AND desc != '' THEN 1 ELSE 0 END) AS withDesc,
       SUM(CASE WHEN images_json != '[]' THEN 1 ELSE 0 END) AS withImage,
       SUM(CASE WHEN credits_json IS NOT NULL THEN 1 ELSE 0 END) AS withCredits,
       SUM(CASE WHEN categories_json != '[]' THEN 1 ELSE 0 END) AS withCategory,
       SUM(CASE WHEN episode_json IS NOT NULL THEN 1 ELSE 0 END) AS withEpisode
     FROM programmes WHERE stop > ? AND start < ?`,
    [from, to],
  );
  return {
    total: num(row?.total),
    withDesc: num(row?.withDesc),
    withImage: num(row?.withImage),
    withCredits: num(row?.withCredits),
    withCategory: num(row?.withCategory),
    withEpisode: num(row?.withEpisode),
  };
}

// --------------------------------------------------------------- dictionary

export async function getDictionary(pids: string[]): Promise<Map<string, string>> {
  if (!pids.length) return new Map();
  await initDb();
  const out = new Map<string, string>();
  // Se trocea para no pasarse del límite de parámetros por consulta.
  for (let i = 0; i < pids.length; i += 400) {
    const chunk = pids.slice(i, i + 400);
    const rows = await all(
      `SELECT pid, title FROM ca_dictionary WHERE pid IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const r of rows) out.set(String(r.pid), String(r.title));
  }
  return out;
}

export async function saveDictionary(
  entries: { pid: string; kind: string; title: string }[],
): Promise<void> {
  if (!entries.length) return;
  await initDb();
  const now = Date.now();
  await batch(
    entries.map((e) => ({
      sql: `INSERT INTO ca_dictionary (pid, kind, title, fetched_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(pid) DO UPDATE SET title = excluded.title, fetched_at = excluded.fetched_at`,
      args: [e.pid, e.kind, e.title, now] as InValue[],
    })),
  );
}

// ------------------------------------------------------------------ sources

export async function markSourceRun(
  sourceId: string,
  status: 'ok' | 'error',
  error?: string,
): Promise<void> {
  await initDb();
  const now = Date.now();
  if (status === 'ok') {
    await run(
      'UPDATE sources SET last_run_at = ?, last_ok_at = ?, last_status = ?, last_error = NULL WHERE id = ?',
      [now, now, status, sourceId],
    );
  } else {
    await run('UPDATE sources SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?', [
      now,
      status,
      error ?? null,
      sourceId,
    ]);
  }
}

export interface SourceStatus {
  id: string;
  priority: number;
  enabled: number;
  last_run_at: number | null;
  last_ok_at: number | null;
  last_status: string | null;
  last_error: string | null;
  channel_count: number;
  programme_count: number;
}

export async function getSourceStatuses(): Promise<SourceStatus[]> {
  await initDb();
  const rows = await all('SELECT * FROM sources ORDER BY priority');
  return rows.map((r) => ({
    id: String(r.id),
    priority: Number(r.priority),
    enabled: Number(r.enabled),
    last_run_at: r.last_run_at === null ? null : Number(r.last_run_at),
    last_ok_at: r.last_ok_at === null ? null : Number(r.last_ok_at),
    last_status: r.last_status === null ? null : String(r.last_status),
    last_error: r.last_error === null ? null : String(r.last_error),
    channel_count: num(r.channel_count),
    programme_count: num(r.programme_count),
  }));
}

// ----------------------------------------------------------------- profiles

export interface Profile {
  id: number;
  name: string;
  slug: string;
  channelIds: number[];
  options: Record<string, unknown>;
}

function rowToProfile(r: Record<string, unknown>): Profile {
  return {
    id: Number(r.id),
    name: String(r.name),
    slug: String(r.slug),
    channelIds: parse<number[]>(r.channels_json, []),
    options: parse<Record<string, unknown>>(r.options_json, {}),
  };
}

export async function listProfiles(): Promise<Profile[]> {
  await initDb();
  return (await all('SELECT * FROM profiles ORDER BY name')).map(rowToProfile);
}

export async function getProfileBySlug(slug: string): Promise<Profile | null> {
  await initDb();
  const r = await get('SELECT * FROM profiles WHERE slug = ?', [slug]);
  return r ? rowToProfile(r) : null;
}

export async function saveProfile(
  name: string,
  slug: string,
  channelIds: number[],
  options: Record<string, unknown>,
): Promise<Profile> {
  await initDb();
  const now = Date.now();
  await run(
    `INSERT INTO profiles (name, slug, channels_json, options_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       name = excluded.name, channels_json = excluded.channels_json,
       options_json = excluded.options_json, updated_at = excluded.updated_at`,
    [name, slug, json(channelIds), json(options), now, now],
  );
  return (await getProfileBySlug(slug))!;
}

export async function deleteProfile(slug: string): Promise<boolean> {
  await initDb();
  const res = await run('DELETE FROM profiles WHERE slug = ?', [slug]);
  return res.changes > 0;
}
