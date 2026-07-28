import * as cheerio from 'cheerio';
import { gunzipSync } from 'node:zlib';
import { DateTime } from 'luxon';
import { loadConfig } from '../core/config.ts';
import { listFiles, readFile } from '../core/storage.ts';
import { preferHttps } from '../core/normalize.ts';
import type {
  Credits,
  EpgSource,
  FetchRange,
  ImageRef,
  RawChannel,
  RawProgramme,
} from '../core/types.ts';

/**
 * Archivos subidos por la persona usuaria.
 *
 * Acepta XMLTV (`.xml`, `.xml.gz`) y el JSON que exporta este mismo proyecto.
 * Una vez incorporados se comportan como cualquier otra fuente: entran en la
 * unificación de canales y en la fusión campo a campo, con su prioridad
 * configurable.
 *
 * Los archivos viven en `config/uploads/` y no en un directorio temporal a
 * propósito: así se pueden versionar en el repo y el despliegue estático los
 * usa igual que el servidor local.
 */

const SUPPORTED = /\.(xml|xml\.gz|json)$/i;

export function isSupportedUpload(name: string): boolean {
  return SUPPORTED.test(name);
}

export interface ParsedFile {
  channels: RawChannel[];
  programmes: RawProgramme[];
}

export interface UploadInfo {
  name: string;
  bytes: number;
  modifiedAt: number;
  format: 'xmltv' | 'json';
  channels: number;
  programmes: number;
  error?: string;
}

export async function listUploads(): Promise<UploadInfo[]> {
  const files = (await listFiles()).filter((f) => SUPPORTED.test(f.name));
  const out: UploadInfo[] = [];
  for (const f of files) {
    const base: UploadInfo = {
      name: f.name,
      bytes: f.bytes,
      modifiedAt: f.modifiedAt,
      format: /\.json$/i.test(f.name) ? 'json' : 'xmltv',
      channels: 0,
      programmes: 0,
    };
    try {
      const parsed = await parseUpload(f.name);
      base.channels = parsed.channels.length;
      base.programmes = parsed.programmes.length;
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }
    out.push(base);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Decodifica el contenido, descomprimiendo si hace falta. */
function decode(buf: Buffer): string {
  // Cabecera mágica de gzip: la extensión puede mentir, el contenido no.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

/**
 * Interpreta el formato `20260727140000 -0400` de XMLTV.
 *
 * El offset es opcional en la especificación. Cuando falta se asume la zona
 * del proyecto, que es lo que hacen las guías chilenas que lo omiten.
 */
function parseXmltvTime(value: string, zone: string): number | null {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, off] = m;
  const iso =
    `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}` +
    (off ? `${off.slice(0, 3)}:${off.slice(3)}` : '');
  const dt = off
    ? DateTime.fromISO(iso, { setZone: true })
    : DateTime.fromISO(iso, { zone });
  return dt.isValid ? dt.toMillis() : null;
}

function parseXmltv(xml: string, sourceId: string, label: string, zone: string): ParsedFile {
  const $ = cheerio.load(xml, { xmlMode: true });

  const channels: RawChannel[] = [];
  $('channel').each((_, el) => {
    const $el = $(el);
    const id = $el.attr('id');
    if (!id) return;
    const names: string[] = [];
    $el.find('display-name').each((__, n) => {
      const t = $(n).text().trim();
      if (t) names.push(t);
    });
    // XMLTV admite el número de canal como display-name adicional.
    const numeric = names.find((n) => /^\d{1,5}$/.test(n));
    const readable = names.find((n) => !/^\d{1,5}$/.test(n)) ?? id;

    const logos: ImageRef[] = [];
    const icon = $el.find('icon').first().attr('src');
    if (icon) logos.push({ url: preferHttps(icon), kind: 'logo' });

    channels.push({
      sourceId,
      sourceChannelId: id,
      name: readable,
      number: numeric ? Number(numeric) : undefined,
      logos,
      raw: { file: label, id },
    });
  });

  const programmes: RawProgramme[] = [];
  $('programme').each((_, el) => {
    const $el = $(el);
    const channel = $el.attr('channel');
    const startRaw = $el.attr('start');
    const stopRaw = $el.attr('stop');
    if (!channel || !startRaw) return;

    const start = parseXmltvTime(startRaw, zone);
    const stop = stopRaw ? parseXmltvTime(stopRaw, zone) : null;
    if (start === null || stop === null || stop <= start) return;

    const title = $el.find('title').first().text().trim();
    if (!title) return;

    const categories: string[] = [];
    $el.find('category').each((__, c) => {
      const t = $(c).text().trim();
      if (t && !categories.includes(t)) categories.push(t);
    });

    const images: ImageRef[] = [];
    $el.find('icon').each((__, i) => {
      const src = $(i).attr('src');
      if (src) images.push({ url: preferHttps(src), kind: 'poster' });
    });

    const actors: string[] = [];
    const directors: string[] = [];
    $el.find('credits > actor').each((__, a) => {
      const t = $(a).text().trim();
      if (t) actors.push(t);
    });
    $el.find('credits > director').each((__, d) => {
      const t = $(d).text().trim();
      if (t) directors.push(t);
    });
    const credits: Credits | undefined =
      actors.length || directors.length ? { actors, directors } : undefined;

    // `xmltv_ns` es 0-based: "0 . 4 . " es temporada 1, episodio 5.
    let season: number | undefined;
    let episode: number | undefined;
    const ns = $el.find('episode-num[system="xmltv_ns"]').first().text().trim();
    if (ns) {
      const parts = ns.split('.').map((p) => p.trim());
      if (parts[0]) season = Number(parts[0]) + 1;
      if (parts[1]) episode = Number(parts[1]) + 1;
    }

    const externalIds: Record<string, string> = { uploadFile: label };
    const progId = $el.find('episode-num[system="dd_progid"]').first().text().trim();
    if (progId) externalIds.tmsId = progId;

    programmes.push({
      sourceId,
      sourceChannelId: channel,
      start,
      stop,
      title,
      subTitle: $el.find('sub-title').first().text().trim() || undefined,
      desc: $el.find('desc').first().text().trim() || undefined,
      categories,
      images,
      credits,
      rating: $el.find('rating value').first().text().trim() || undefined,
      episode:
        Number.isFinite(season) || Number.isFinite(episode) ? { season, episode } : undefined,
      externalIds,
    });
  });

  return { channels, programmes };
}

/** Acepta el JSON que exporta este mismo proyecto. */
function parseJson(text: string, sourceId: string, label: string): ParsedFile {
  const data = JSON.parse(text) as {
    channels?: { id: string; name: string; numbers?: Record<string, number>; logos?: ImageRef[] }[];
    programmes?: {
      channel: string;
      start: string | number;
      stop: string | number;
      title: string;
      subTitle?: string;
      desc?: string;
      categories?: string[];
      images?: ImageRef[];
      credits?: Credits;
      rating?: string;
      episode?: { season?: number; episode?: number };
    }[];
  };

  if (!Array.isArray(data.channels) || !Array.isArray(data.programmes)) {
    throw new Error('El JSON no tiene la forma esperada (se esperaban `channels` y `programmes`)');
  }

  const channels: RawChannel[] = data.channels.map((c) => ({
    sourceId,
    sourceChannelId: c.id,
    name: c.name || c.id,
    number: c.numbers ? Object.values(c.numbers)[0] : undefined,
    logos: c.logos ?? [],
    raw: { file: label },
  }));

  const toMs = (v: string | number): number =>
    typeof v === 'number' ? v : DateTime.fromISO(v).toMillis();

  const programmes: RawProgramme[] = [];
  for (const p of data.programmes) {
    const start = toMs(p.start);
    const stop = toMs(p.stop);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) continue;
    programmes.push({
      sourceId,
      sourceChannelId: p.channel,
      start,
      stop,
      title: p.title,
      subTitle: p.subTitle,
      desc: p.desc,
      categories: p.categories ?? [],
      images: p.images ?? [],
      credits: p.credits,
      rating: p.rating,
      episode: p.episode,
      externalIds: { uploadFile: label },
    });
  }

  return { channels, programmes };
}

async function parseUpload(name: string): Promise<ParsedFile> {
  const zone = loadConfig().app.timezone;
  const text = decode(await readFile(name));
  if (/\.json$/i.test(name)) return parseJson(text, 'uploads', name);
  return parseXmltv(text, 'uploads', name, zone);
}

/** Valida un archivo recién subido sin haberlo guardado aún. */
export function parseBuffer(name: string, buf: Buffer): ParsedFile {
  const zone = loadConfig().app.timezone;
  const text = decode(buf);
  if (/\.json$/i.test(name)) return parseJson(text, 'uploads', name);
  return parseXmltv(text, 'uploads', name, zone);
}

export class UploadsSource implements EpgSource {
  readonly id = 'uploads';

  async #parseAll(): Promise<ParsedFile> {
    const channels: RawChannel[] = [];
    const programmes: RawProgramme[] = [];
    const seenChannel = new Set<string>();

    const names = (await listFiles())
      .map((f) => f.name)
      .filter((n) => SUPPORTED.test(n))
      .sort();

    for (const name of names) {
      try {
        const parsed = await parseUpload(name);
        for (const c of parsed.channels) {
          // Varios archivos pueden traer el mismo canal; gana el primero por
          // orden alfabético, que es estable entre ejecuciones.
          if (seenChannel.has(c.sourceChannelId)) continue;
          seenChannel.add(c.sourceChannelId);
          channels.push(c);
        }
        programmes.push(...parsed.programmes);
      } catch (err) {
        // Un archivo corrupto no debe impedir que se usen los demás.
        console.warn(`  ! No se pudo leer ${name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { channels, programmes };
  }

  async fetchChannels(): Promise<RawChannel[]> {
    return (await this.#parseAll()).channels;
  }

  async fetchProgrammes(range: FetchRange): Promise<RawProgramme[]> {
    const { programmes } = await this.#parseAll();
    return programmes.filter((p) => p.stop > range.from && p.start < range.to);
  }
}
