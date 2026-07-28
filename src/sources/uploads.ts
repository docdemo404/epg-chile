import * as cheerio from 'cheerio';
import { gunzipSync } from 'node:zlib';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DateTime } from 'luxon';
import { loadConfig } from '../core/config.ts';
import { listFiles, readFile } from '../core/storage.ts';
import { request } from '../core/http.ts';
import { listFeedUrls, setFeedUrlStatus } from '../db/repo.ts';
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

// ------------------------------------------------------------- guías por URL

/**
 * Decide el formato por el contenido, no por la extensión.
 *
 * Una URL puede no tener extensión útil (`/epg?format=xml`) o mentir, así que
 * se mira el primer carácter no vacío: `{` o `[` es JSON y cualquier otra cosa
 * se intenta como XMLTV.
 */
function parseText(text: string, label: string): ParsedFile {
  const zone = loadConfig().app.timezone;
  const head = text.trimStart()[0];
  if (head === '{' || head === '[') return parseJson(text, 'uploads', label);
  return parseXmltv(text, 'uploads', label, zone);
}

/** Rangos que nunca deben ser destino de una URL escrita desde el panel. */
/**
 * Expande un IPv6 a sus 8 grupos numéricos.
 *
 * Hace falta porque no se puede razonar sobre la cadena tal cual: `new URL()`
 * normaliza la dirección y comprime los ceros, así que `::ffff:127.0.0.1`
 * llega aquí escrito `::ffff:7f00:1`. Comparar texto se rompe justo con la
 * forma que escribiría alguien buscando saltarse la comprobación.
 */
function expandIpv6(ip: string): number[] | null {
  const [head = '', tail = '', extra] = ip.split('::');
  if (extra !== undefined) return null; // más de un "::" no es válido

  const toGroups = (part: string): number[] =>
    part ? part.split(':').map((h) => parseInt(h, 16)) : [];

  const left = toGroups(head);
  const right = toGroups(tail);
  const groups = ip.includes('::')
    ? [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
    : left;

  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    // Las formas con IPv4 embebido en decimal (`::ffff:10.0.0.1`) las acepta
    // `isIP`, pero no se pueden expandir a hexadecimal: se tratan aparte.
    const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
    if (dotted) return isPrivateAddress(dotted);

    const g = expandIpv6(v6);
    if (!g) return true; // ilegible ⇒ se rechaza

    const [g0 = 0, g5 = 0, g6 = 0, g7 = 0] = [g[0], g[5], g[6], g[7]];

    // Sin especificar (::) y loopback (::1).
    if (g.every((x) => x === 0)) return true;
    if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true;
    // Enlace local fe80::/10 y únicas locales fc00::/7.
    if ((g0 & 0xffc0) === 0xfe80) return true;
    if ((g0 & 0xfe00) === 0xfc00) return true;

    // IPv4 mapeada (::ffff:0:0/96) y la compatible ya obsoleta (::/96): en
    // ambas los 32 bits finales son una IPv4 que hay que juzgar como tal.
    const primerosCeros = g.slice(0, 5).every((x) => x === 0);
    if (primerosCeros && (g5 === 0xffff || g5 === 0)) {
      const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
      return isPrivateAddress(v4);
    }
    return false;
  }

  const parts = ip.split('.').map(Number);
  // Ante cualquier cosa que no sea una IPv4 legible, se rechaza: en una
  // comprobación de seguridad lo desconocido no puede contar como seguro.
  if (parts.length !== 4) return true;
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = -1, b = -1] = parts;

  return (
    a === 0 || // "esta" red
    a === 10 || // privada
    a === 127 || // loopback
    (a === 169 && b === 254) || // enlace local y metadatos de nube (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // privada
    (a === 192 && b === 168) || // privada
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast y reservados
  );
}

/**
 * Comprueba que una URL sea segura de pedir desde el servidor.
 *
 * El panel no tiene autenticación, así que esta función es lo único que separa
 * "descargar una guía" de "usar el servidor como puente hacia la red interna".
 * Se resuelve el nombre y se miran las IP: un dominio puede apuntar a
 * 127.0.0.1 o a 169.254.169.254, que es donde viven las credenciales de
 * instancia en varias nubes.
 *
 * Queda una ventana teórica de DNS rebinding —entre esta comprobación y la
 * descarga real el nombre podría cambiar de IP—. Cerrarla exigiría resolver y
 * conectar por IP fijando el Host, que Node no permite sin un agente propio.
 * Para el alcance de este proyecto el riesgo es aceptable y conviene que quede
 * escrito.
 */
export async function assertSafeFeedUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('La URL no es válida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Solo se admiten URLs http o https');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => {
        throw new Error(`No se pudo resolver el dominio ${host}`);
      })).map((a) => a.address);

  if (!addresses.length) throw new Error(`No se pudo resolver el dominio ${host}`);
  if (addresses.some(isPrivateAddress)) {
    throw new Error('Esa URL apunta a una dirección interna o reservada');
  }
  return url;
}

/** Descarga y valida una guía remota sin darla de alta. */
export async function fetchFeed(raw: string, label: string): Promise<ParsedFile> {
  const url = await assertSafeFeedUrl(raw);
  // Sin caché: el sentido de una URL es que su contenido cambie, y al darla de
  // alta se quiere ver lo que hay ahora, no lo que había hace una hora.
  const text = await request('uploads', url.toString(), { noCache: true });
  const parsed = parseText(text, label);
  if (!parsed.channels.length && !parsed.programmes.length) {
    throw new Error('La URL no devolvió canales ni programación');
  }
  return parsed;
}

export class UploadsSource implements EpgSource {
  readonly id = 'uploads';

  async #parseAll(): Promise<ParsedFile> {
    const channels: RawChannel[] = [];
    const programmes: RawProgramme[] = [];
    const seenChannel = new Set<string>();

    const absorb = (parsed: ParsedFile): void => {
      for (const c of parsed.channels) {
        // Varias guías pueden traer el mismo canal; gana la primera en
        // llegar, y el orden es estable entre ejecuciones.
        if (seenChannel.has(c.sourceChannelId)) continue;
        seenChannel.add(c.sourceChannelId);
        channels.push(c);
      }
      programmes.push(...parsed.programmes);
    };

    const names = (await listFiles())
      .map((f) => f.name)
      .filter((n) => SUPPORTED.test(n))
      .sort();

    for (const name of names) {
      try {
        absorb(await parseUpload(name));
      } catch (err) {
        // Un archivo corrupto no debe impedir que se usen los demás.
        console.warn(`  ! No se pudo leer ${name}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Las guías por URL se vuelven a descargar en cada ingesta: es la
    // diferencia con un archivo subido, que es una foto fija.
    for (const feed of await listFeedUrls()) {
      if (!feed.enabled) continue;
      try {
        const parsed = await fetchFeed(feed.url, feed.label);
        absorb(parsed);
        await setFeedUrlStatus(feed.id, 'ok', {
          channels: parsed.channels.length,
          programmes: parsed.programmes.length,
        });
      } catch (err) {
        // Igual que con los archivos: una guía remota caída no puede tumbar
        // las demás. Se registra para que el panel lo muestre.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  ! No se pudo descargar ${feed.label} (${feed.url}): ${msg}`);
        await setFeedUrlStatus(feed.id, 'error', { error: msg });
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
