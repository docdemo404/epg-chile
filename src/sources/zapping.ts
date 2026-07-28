import * as cheerio from 'cheerio';
import { getSourceConfig } from '../core/config.ts';
import { request } from '../core/http.ts';
import { isFallbackImage, preferHttps } from '../core/normalize.ts';
import type { EpgSource, FetchRange, ImageRef, RawChannel, RawProgramme } from '../core/types.ts';

/**
 * Zapping TV Chile — guia.zappingtv.com, scraping.
 *
 * Reemplaza a DirecTV, que quedó descartado por estar tras un muro anti-bot.
 * Zapping sirve HTML plano y atiende un User-Agent honesto sin bloqueos.
 *
 * Ventaja decisiva sobre lo que aportaba DirecTV: además de imagen en alta
 * resolución trae descripción, género, año, duración y elenco CON nombre de
 * personaje — el único de las tres fuentes que da el personaje.
 *
 * Limitación real: cada página de canal cubre solo desde ahora hasta ~30
 * horas adelante, y no acepta parámetro de fecha (probado: `?date=`, `?day=`
 * y rutas con fecha se ignoran). Para la guía a varios días se apoya en
 * Movistar; Zapping enriquece la franja cercana, que es la que más se mira.
 */

interface ZapListing {
  /** Epoch en segundos, viene directo en el href `info/{epoch}`. */
  startSec: number;
  title: string;
  desc?: string;
  image?: string;
}

export class ZappingSource implements EpgSource {
  readonly id = 'zapping';

  #base(): string {
    return getSourceConfig(this.id).baseUrl;
  }

  /**
   * El índice trae todos los canales con atributos limpios:
   * `<div class="channel" id="{slug}" data-name="TVN" data-cat="Nacionales">`.
   * Una sola petición para los 177.
   */
  async fetchChannels(): Promise<RawChannel[]> {
    const html = await request(this.id, `${this.#base()}/`, { cacheTtlMinutes: 12 * 60 });
    const $ = cheerio.load(html);
    const out: RawChannel[] = [];

    $('div.channel[id]').each((_, el) => {
      const $el = $(el);
      const slug = $el.attr('id')?.trim();
      if (!slug) return;
      const name = $el.attr('data-name')?.trim() || slug;
      const category = $el.attr('data-cat')?.trim();
      const logo = $el.find('img').first().attr('src');

      out.push({
        sourceId: this.id,
        sourceChannelId: slug,
        name,
        logos: logo ? [{ url: preferHttps(logo), kind: 'logo' }] : [],
        raw: { slug, category },
      });
    });

    return out;
  }

  async fetchProgrammes(range: FetchRange, channels: RawChannel[]): Promise<RawProgramme[]> {
    const cfg = getSourceConfig(this.id) as unknown as { fetchDetails?: boolean };
    const out: RawProgramme[] = [];

    for (const channel of channels) {
      try {
        const listings = await this.#fetchChannelPage(channel.sourceChannelId);
        out.push(...this.#toProgrammes(listings, channel.sourceChannelId, range));
      } catch {
        // Un canal caído no debe tumbar la ingesta: la guía se sostiene con
        // las otras fuentes y con el resto de canales de esta.
      }
    }

    // El elenco con personaje solo está en la ficha de detalle, y eso es una
    // petición por programa (~4.000 por ejecución). Va desactivado por
    // defecto: se activa en sources.yaml cuando se quiera esa riqueza extra.
    if (cfg.fetchDetails) {
      await this.#enrichWithDetails(out);
    }

    return out;
  }

  async #fetchChannelPage(slug: string): Promise<ZapListing[]> {
    const html = await request(this.id, `${this.#base()}/${slug}/`);
    const $ = cheerio.load(html);
    const listings: ZapListing[] = [];

    // El programa en emisión vive en un bloque aparte (`.on-air`) y no
    // aparece en la lista de "hoy"; sin él se perdería el slot actual.
    const onAirHref = $('.program-info a[href^="info/"]').first().attr('href');
    const onAirSec = Number(onAirHref?.match(/info\/(\d+)/)?.[1] ?? 0);
    if (onAirSec > 0) {
      listings.push({
        startSec: onAirSec,
        title: $('.program-info h4').first().text().trim(),
        desc: cleanDesc($('.program-info .program-description').first().text()),
        image: bgUrl($('.program-img').first().attr('style')),
      });
    }

    $('a.epg-item[href^="info/"]').each((_, el) => {
      const $el = $(el);
      const startSec = Number($el.attr('href')?.match(/info\/(\d+)/)?.[1] ?? 0);
      if (!startSec) return;
      const title = $el.find('.epg-schedule-title').first().text().trim();
      if (!title) return;
      listings.push({
        startSec,
        title,
        desc: cleanDesc($el.find('.program-description').first().text()),
        image: bgUrl($el.find('.epg-schedule-image').first().attr('style')),
      });
    });

    // Deduplicar por hora de inicio; el bloque "on air" repite el slot actual.
    const byStart = new Map<number, ZapListing>();
    for (const l of listings) {
      const prev = byStart.get(l.startSec);
      // Se prefiere la variante con descripción más larga (menos truncada).
      if (!prev || (l.desc?.length ?? 0) > (prev.desc?.length ?? 0)) {
        byStart.set(l.startSec, l);
      }
    }
    return [...byStart.values()].sort((a, b) => a.startSec - b.startSec);
  }

  /**
   * Zapping publica el inicio pero no el fin, así que cada emisión termina
   * donde empieza la siguiente. La última se cierra con una hora estimada.
   */
  #toProgrammes(listings: ZapListing[], slug: string, range: FetchRange): RawProgramme[] {
    const out: RawProgramme[] = [];

    for (let i = 0; i < listings.length; i++) {
      const l = listings[i]!;
      const start = l.startSec * 1000;
      const next = listings[i + 1];
      const stop = next ? next.startSec * 1000 : start + 3_600_000;
      if (stop <= start) continue;
      // Fuera de la ventana pedida.
      if (stop <= range.from || start >= range.to) continue;

      const images: ImageRef[] = [];
      if (l.image && !isFallbackImage(l.image)) {
        // El CDN acepta el alto por querystring; se pide la variante grande.
        images.push({ url: upscale(l.image), kind: 'videoFrame' });
      }

      out.push({
        sourceId: this.id,
        sourceChannelId: slug,
        start,
        stop,
        title: l.title,
        desc: l.desc,
        categories: [],
        images,
        externalIds: { zappingSlot: String(l.startSec) },
        raw: l,
      });
    }
    return out;
  }

  /**
   * Completa género, año, duración y elenco desde la ficha de cada programa.
   * Caro: una petición por emisión.
   */
  async #enrichWithDetails(programmes: RawProgramme[]): Promise<void> {
    for (const p of programmes) {
      const slot = p.externalIds.zappingSlot;
      if (!slot) continue;
      try {
        const html = await request(
          this.id,
          `${this.#base()}/${p.sourceChannelId}/info/${slot}`,
          { cacheTtlMinutes: 6 * 60 },
        );
        const detail = parseDetail(html);
        if (detail.desc && detail.desc.length > (p.desc?.length ?? 0)) p.desc = detail.desc;
        if (detail.categories.length) p.categories = detail.categories;
        if (detail.actors.length || detail.directors.length) {
          p.credits = { actors: detail.actors, directors: detail.directors };
        }
        if (detail.year) p.externalIds.year = String(detail.year);
      } catch {
        // El detalle es opcional: sin él el programa sigue teniendo horario,
        // título, sinopsis e imagen.
      }
    }
  }
}

/** Extrae la URL de un `style="background-image: url('...')"`. */
function bgUrl(style: string | undefined): string | undefined {
  const m = style?.match(/url\(['"]?([^'")]+)['"]?\)/);
  return m?.[1] ? preferHttps(m[1]) : undefined;
}

/**
 * Pide al CDN la variante de mayor alto. Zapping sirve `?h=300` en las
 * tarjetas; la misma imagen a 1280 es la que se usa en la ficha.
 */
function upscale(url: string): string {
  return url.replace(/([?&]h=)\d+/, '$11280');
}

/** Normaliza espacios y descarta descripciones vacías. */
function cleanDesc(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : undefined;
}

interface ZapDetail {
  desc?: string;
  categories: string[];
  actors: string[];
  directors: string[];
  year?: number;
}

function parseDetail(html: string): ZapDetail {
  const $ = cheerio.load(html);
  const categories: string[] = [];

  const type = $('.program-zappingtype').first().text().trim();
  if (type) categories.push(type);
  const genres = $('.program-genres').first().text().trim();
  for (const g of genres.split(/[,/]/)) {
    const t = g.trim();
    if (t && !categories.includes(t)) categories.push(t);
  }

  const actors: string[] = [];
  const directors: string[] = [];

  // Cada persona es un `.program-person` con nombre y, debajo, el personaje
  // que interpreta (o el rol, como "Director").
  $('.program-person').each((_, el) => {
    const $el = $(el);
    const name = $el.find('.program-person-name').first().text().trim();
    if (!name) return;
    const sub = $el.find('.program-person-sub').first().text().replace(/\s+/g, ' ').trim();
    if (/director/i.test(sub)) {
      directors.push(name);
    } else {
      // XMLTV no tiene campo de personaje, así que se anexa al nombre:
      // "Enrique Sánchez-Fortún (Lope Ruíz)".
      actors.push(sub ? `${name} (${sub})` : name);
    }
  });

  const yearText = $('.program-year').first().text().trim();
  const year = /^\d{4}$/.test(yearText) ? Number(yearText) : undefined;

  return {
    desc: cleanDesc($('.program-info .program-description').first().text()),
    categories,
    actors,
    directors,
    year,
  };
}
