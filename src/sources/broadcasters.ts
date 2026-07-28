import * as cheerio from 'cheerio';
import { DateTime } from 'luxon';
import { getSourceConfig, loadConfig } from '../core/config.ts';
import { request } from '../core/http.ts';
import { preferHttps } from '../core/normalize.ts';
import type { EpgSource, FetchRange, ImageRef, RawChannel, RawProgramme } from '../core/types.ts';

/**
 * Emisoras chilenas — parrilla publicada por el propio canal.
 *
 * Mega, Canal 13 y La Red publican su programación en su web. Como fuente de
 * primera mano suelen ir por delante de los operadores cuando hay cambios de
 * última hora, y traen la imagen oficial del programa.
 *
 * Cada emisora es un canal único con su propio maquetado, así que en vez de
 * un adaptador por sitio hay uno solo con un parser por emisora. Añadir otra
 * emisora es agregar una entrada a BROADCASTERS.
 *
 * Limitación inherente: solo cubren su propia señal, sin sinopsis por emisión
 * (salvo La Red, que aporta imagen). Su papel es corregir horarios y aportar
 * el título oficial en los canales abiertos más vistos de Chile.
 */

interface Broadcaster {
  key: string;
  name: string;
  url: string;
  parse: (html: string, zone: string) => ParsedEntry[];
}

interface ParsedEntry {
  /** Epoch ms UTC. */
  start: number;
  title: string;
  image?: string;
  href?: string;
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

const WEEKDAY_IDS: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Convierte "Lunes 27 de Julio" a una fecha del año en curso. */
function parseSpanishDate(text: string, zone: string): DateTime | null {
  const clean = stripAccents(text).toLowerCase();
  const m = clean.match(/(\d{1,2})\s+de\s+([a-z]+)/);
  if (!m?.[1] || !m[2]) return null;
  const month = MONTHS[m[2]];
  if (!month) return null;
  const day = Number(m[1]);
  const now = DateTime.now().setZone(zone);
  let dt = DateTime.fromObject({ year: now.year, month, day }, { zone });
  if (!dt.isValid) return null;
  // Una parrilla publicada en diciembre que apunta a enero es del año que viene.
  if (dt < now.minus({ days: 180 })) dt = dt.plus({ years: 1 });
  return dt;
}

/** Aplica "HH:MM" a un día, avanzando al siguiente si la hora retrocede. */
function buildTimeline(
  base: DateTime,
  entries: { time: string; title: string; image?: string; href?: string }[],
): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  let dayOffset = 0;
  let prevMinutes = -1;

  for (const e of entries) {
    const m = e.time.match(/(\d{1,2}):(\d{2})/);
    if (!m?.[1] || !m[2]) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const minutes = hh * 60 + mm;
    // La parrilla cruza la medianoche: "00:15" tras "22:20" es del día siguiente.
    if (prevMinutes >= 0 && minutes < prevMinutes) dayOffset++;
    prevMinutes = minutes;
    out.push({
      start: base.plus({ days: dayOffset }).set({ hour: hh, minute: mm, second: 0, millisecond: 0 }).toMillis(),
      title: e.title,
      image: e.image,
      href: e.href,
    });
  }
  return out;
}

// ------------------------------------------------------------------- Canal 13

/**
 * Canal 13 publica un bloque por día, con la fecha en un `h2.dia` y las
 * emisiones como `a.item` con `.hora` y `.programa`. Es el maquetado más
 * limpio de los tres.
 */
function parseCanal13(html: string, zone: string): ParsedEntry[] {
  const $ = cheerio.load(html);
  const out: ParsedEntry[] = [];

  $('.programacion-dia').each((_, block) => {
    const $block = $(block);
    const dateText = $block.find('h2.dia').first().text().trim();
    const base = parseSpanishDate(dateText, zone);
    if (!base) return;

    const entries: { time: string; title: string; href?: string }[] = [];
    $block.find('.programas a.item, a.item').each((__, item) => {
      const $item = $(item);
      const time = $item.find('.hora').first().text().trim();
      const title = $item.find('.programa').first().text().replace(/\s+/g, ' ').trim();
      if (!time || !title) return;
      entries.push({ time, title, href: $item.attr('href') || undefined });
    });
    out.push(...buildTimeline(base, entries));
  });

  return out;
}

// --------------------------------------------------------------------- La Red

/**
 * La Red publica la semana completa en pestañas por día (`#mon`..`#sun`) y es
 * la única de las tres que adjunta imagen por programa.
 */
function parseLaRed(html: string, zone: string): ParsedEntry[] {
  const $ = cheerio.load(html);
  const out: ParsedEntry[] = [];
  const monday = DateTime.now().setZone(zone).startOf('week');

  for (const [id, weekday] of Object.entries(WEEKDAY_IDS)) {
    const $tab = $(`#${id}`);
    if (!$tab.length) continue;
    const base = monday.plus({ days: weekday - 1 });

    const entries: { time: string; title: string; image?: string; href?: string }[] = [];
    $tab.find('.item').each((_, item) => {
      const $item = $(item);
      const time = $item.find('.hour p').first().text().trim();
      const title = $item.find('.programa-name').first().text().replace(/\s+/g, ' ').trim();
      if (!time || !title) return;
      entries.push({
        time,
        title,
        image: $item.find('img').first().attr('src') || undefined,
        href: $item.find('a').first().attr('href') || undefined,
      });
    });
    out.push(...buildTimeline(base, entries));
  }

  return out;
}

// ----------------------------------------------------------------------- Mega

/**
 * Mega no publica una grilla estructurada: la parrilla del día va redactada
 * dentro de una nota editorial, en líneas del tipo
 * "Mucho Gusto: 08:00 horas.".
 *
 * Es el parser más frágil de los tres — depende de la redacción — pero es la
 * única vía disponible en el sitio. Si el formato cambia, la fuente
 * simplemente deja de aportar y el resto de la guía sigue intacta.
 */
function parseMega(html: string, zone: string): ParsedEntry[] {
  const $ = cheerio.load(html);

  // El cuerpo del artículo viene en el JSON-LD; es más estable que el DOM.
  let body = '';
  let headline = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    const bodyMatch = txt.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    if (bodyMatch?.[1] && bodyMatch[1].length > body.length) {
      body = bodyMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\//g, '/');
    }
    const headMatch = txt.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (headMatch?.[1] && !headline) headline = headMatch[1];
  });
  if (!body) return [];

  const base = parseSpanishDate(headline, zone) ?? DateTime.now().setZone(zone).startOf('day');

  const entries: { time: string; title: string }[] = [];
  for (const line of body.split('\n')) {
    // "Carmen Gloria: Fuerte y Claro: 15:45 horas." — el título puede llevar
    // dos puntos, así que se ancla al ÚLTIMO ": HH:MM horas".
    const m = line.match(/^(.*?):\s*(\d{1,2}:\d{2})\s*horas?\.?\s*$/);
    if (!m?.[1] || !m[2]) continue;
    const title = m[1].replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
    if (!title || title.length > 120) continue;
    entries.push({ time: m[2], title });
  }

  return buildTimeline(base, entries);
}

const BROADCASTERS: Broadcaster[] = [
  { key: 'mega', name: 'Mega', url: 'https://www.mega.cl/programacion/', parse: parseMega },
  { key: 'canal13', name: 'Canal 13', url: 'https://www.13.cl/programacion', parse: parseCanal13 },
  { key: 'lared', name: 'La Red', url: 'https://www.lared.cl/guia-programacion', parse: parseLaRed },
];

export class BroadcastersSource implements EpgSource {
  readonly id = 'broadcasters';

  async fetchChannels(): Promise<RawChannel[]> {
    const enabled = this.#enabledKeys();
    return BROADCASTERS.filter((b) => enabled.has(b.key)).map((b) => ({
      sourceId: this.id,
      sourceChannelId: b.key,
      name: b.name,
      logos: [],
      raw: { url: b.url },
    }));
  }

  #enabledKeys(): Set<string> {
    const cfg = getSourceConfig(this.id) as unknown as { broadcasters?: string[] };
    const list = cfg.broadcasters?.length ? cfg.broadcasters : BROADCASTERS.map((b) => b.key);
    return new Set(list);
  }

  async fetchProgrammes(range: FetchRange): Promise<RawProgramme[]> {
    const zone = loadConfig().app.timezone;
    const enabled = this.#enabledKeys();
    const out: RawProgramme[] = [];

    for (const b of BROADCASTERS) {
      if (!enabled.has(b.key)) continue;
      try {
        const html = await request(this.id, b.url, { cacheTtlMinutes: 60 });
        const entries = b.parse(html, zone).sort((a, c) => a.start - c.start);
        out.push(...this.#toProgrammes(entries, b, range));
      } catch {
        // Una emisora caída o con maquetado cambiado no debe afectar al resto.
      }
    }
    return out;
  }

  /** El fin de cada emisión es el inicio de la siguiente dentro del mismo día. */
  #toProgrammes(entries: ParsedEntry[], b: Broadcaster, range: FetchRange): RawProgramme[] {
    const out: RawProgramme[] = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const next = entries[i + 1];
      // Sin siguiente emisión se cierra en una hora; un salto mayor a 6 h
      // indica cambio de día, no un programa de seis horas.
      let stop = next ? next.start : e.start + 3_600_000;
      if (stop - e.start > 6 * 3_600_000) stop = e.start + 3_600_000;
      if (stop <= e.start) continue;
      if (stop <= range.from || e.start >= range.to) continue;

      const images: ImageRef[] = e.image
        ? [{ url: preferHttps(e.image), kind: 'poster' }]
        : [];

      const externalIds: Record<string, string> = { broadcaster: b.key };
      if (e.href) externalIds.broadcasterUrl = e.href;

      out.push({
        sourceId: this.id,
        sourceChannelId: b.key,
        start: e.start,
        stop,
        title: e.title,
        categories: [],
        images,
        externalIds,
        raw: e,
      });
    }
    return out;
  }
}
