import * as cheerio from 'cheerio';
import { DateTime } from 'luxon';
import { getSourceConfig, loadConfig } from '../core/config.ts';
import { request } from '../core/http.ts';
import { isFallbackImage, preferHttps } from '../core/normalize.ts';
import type { EpgSource, FetchRange, ImageRef, RawChannel, RawProgramme } from '../core/types.ts';

/**
 * mi.tv Chile — scraping.
 *
 * Es la única de las tres que exige scraping: no hay API. Se usa como tercer
 * relleno de sinopsis y género.
 *
 * Coste: un request por canal y día. Con ~190 canales y 3 días son ~570
 * peticiones, así que es la fuente que más cortesía exige — de ahí el
 * `minDelayMs` alto en sources.yaml. La lista de canales sale del sitemap,
 * que es una sola página.
 */

interface MitvListing {
  time: string;
  title: string;
  subTitle?: string;
  synopsis?: string;
  image?: string;
  href?: string;
}

/**
 * Separa el campo `.sub-title` de mi.tv en sus tres posibles contenidos.
 *
 * Formatos observados:
 *   "Interés general"                                  -> género
 *   "Temporada 1 Episodio 5 - El destino los puso ahí" -> episodio + título
 *   "Episodio 12"                                      -> episodio suelto
 */
function parseSubTitle(value: string | undefined): {
  category?: string;
  episode?: { season?: number; episode?: number };
  episodeTitle?: string;
} {
  const text = value?.trim();
  if (!text) return {};

  const m = text.match(
    /^(?:Temporada\s+(\d+)\s*)?(?:Episodio\s+(\d+))?\s*(?:[-–—]\s*(.+))?$/i,
  );
  if (m && (m[1] || m[2])) {
    const season = m[1] ? Number(m[1]) : undefined;
    const episode = m[2] ? Number(m[2]) : undefined;
    const episodeTitle = m[3]?.trim() || undefined;
    return { episode: { season, episode }, episodeTitle };
  }

  // Sin número de episodio pero abriendo con separador: es el título del
  // episodio ("- Las dos caras de Lonquimay"), no un género.
  const dashed = text.match(/^[-–—]\s*(.+)$/);
  if (dashed?.[1]) return { episodeTitle: dashed[1].trim() };

  return { category: text };
}

export class MitvSource implements EpgSource {
  readonly id = 'mitv';

  #base(): string {
    const cfg = getSourceConfig(this.id) as unknown as { baseUrl: string; country: string };
    return `${cfg.baseUrl}/${cfg.country}`;
  }

  /**
   * Los slugs de canal salen del sitemap. Es una única página con todos los
   * enlaces `/cl/canales/{slug}`.
   */
  async fetchChannels(): Promise<RawChannel[]> {
    const html = await request(this.id, `${this.#base()}/sitemap`, {
      cacheTtlMinutes: 24 * 60,
    });
    const $ = cheerio.load(html);
    const slugs = new Map<string, string>();

    $('a[href*="/canales/"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const m = href.match(/\/canales\/([a-z0-9-]+)/i);
      if (!m?.[1]) return;
      const slug = m[1];
      const label = $(el).text().trim();
      if (!slugs.has(slug) || (label && !slugs.get(slug))) {
        slugs.set(slug, label);
      }
    });

    return [...slugs.entries()].map(([slug, label]) => ({
      sourceId: this.id,
      sourceChannelId: slug,
      // Cuando el sitemap no trae etiqueta, el slug legible es mejor que nada;
      // la ingesta de programación lo reemplaza por el nombre real.
      name: label || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      logos: [],
      raw: { slug },
    }));
  }

  async fetchProgrammes(range: FetchRange, channels: RawChannel[]): Promise<RawProgramme[]> {
    const zone = loadConfig().app.timezone;
    const days = this.#daysInRange(range, zone);
    const out: RawProgramme[] = [];

    for (const channel of channels) {
      for (const day of days) {
        try {
          out.push(...(await this.#fetchChannelDay(channel.sourceChannelId, day, zone)));
        } catch {
          // Un canal o día que falla no debe tumbar la ingesta completa:
          // mi.tv es relleno, la guía se sostiene con las otras fuentes.
        }
      }
    }
    return out;
  }

  #daysInRange(range: FetchRange, zone: string): string[] {
    const days: string[] = [];
    let cursor = DateTime.fromMillis(range.from, { zone: 'utc' }).setZone(zone).startOf('day');
    const end = DateTime.fromMillis(range.to, { zone: 'utc' }).setZone(zone);
    while (cursor < end) {
      days.push(cursor.toFormat('yyyy-MM-dd'));
      cursor = cursor.plus({ days: 1 });
    }
    return days;
  }

  async #fetchChannelDay(slug: string, day: string, zone: string): Promise<RawProgramme[]> {
    const html = await request(this.id, `${this.#base()}/async/channel/${slug}/${day}/0`);
    const $ = cheerio.load(html);

    const listings: MitvListing[] = [];
    $('ul.broadcasts > li').each((_, li) => {
      const $li = $(li);
      // Los <li class="native"> son huecos publicitarios, no programación.
      if ($li.hasClass('native')) return;
      const time = $li.find('.time').first().text().trim();
      const title = $li.find('h2').first().text().trim();
      if (!time || !title) return;

      const bg = $li.find('.image').first().attr('style') ?? '';
      const imgMatch = bg.match(/url\(['"]?([^'")]+)['"]?\)/);

      listings.push({
        time,
        title,
        subTitle: $li.find('.sub-title').first().text().trim() || undefined,
        synopsis: $li.find('.synopsis').first().text().trim() || undefined,
        image: imgMatch?.[1],
        href: $li.find('a.program-link').first().attr('href') ?? undefined,
      });
    });

    if (!listings.length) return [];

    const channelLogo = $('.channel-info img').first().attr('src');
    const logos: ImageRef[] =
      channelLogo && !isFallbackImage(channelLogo)
        ? [{ url: preferHttps(channelLogo), kind: 'logo' }]
        : [];

    return this.#toProgrammes(listings, slug, day, zone, logos);
  }

  /**
   * mi.tv solo publica la hora de inicio ("06:00"), así que el fin de cada
   * emisión es el inicio de la siguiente. La última del día se cierra a
   * medianoche.
   *
   * La grilla del día puede cruzar la medianoche: cuando la hora retrocede
   * respecto de la anterior, el programa pertenece al día siguiente.
   */
  #toProgrammes(
    listings: MitvListing[],
    slug: string,
    day: string,
    zone: string,
    channelLogos: ImageRef[],
  ): RawProgramme[] {
    const base = DateTime.fromISO(day, { zone });
    if (!base.isValid) return [];

    const starts: DateTime[] = [];
    let dayOffset = 0;
    let prevMinutes = -1;

    for (const l of listings) {
      const m = l.time.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) {
        starts.push(base);
        continue;
      }
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      const minutes = hh * 60 + mm;
      if (prevMinutes >= 0 && minutes < prevMinutes) dayOffset++;
      prevMinutes = minutes;
      starts.push(base.plus({ days: dayOffset }).set({ hour: hh, minute: mm, second: 0 }));
    }

    const out: RawProgramme[] = [];
    for (let i = 0; i < listings.length; i++) {
      const l = listings[i]!;
      const start = starts[i]!;
      const next = starts[i + 1];
      const stop = next && next > start ? next : start.plus({ hours: 1 });

      const images: ImageRef[] = [];
      if (l.image && !isFallbackImage(l.image)) {
        images.push({ url: preferHttps(l.image), kind: 'poster' });
      }

      const externalIds: Record<string, string> = {};
      const progSlug = l.href?.match(/\/programas\/([a-z0-9-]+)/i)?.[1];
      if (progSlug) externalIds.mitvSlug = progSlug;

      // `.sub-title` es polimórfico: unas veces trae el género ("Interés
      // general") y otras la ubicación del episodio ("Temporada 1 Episodio 5
      // - El destino los puso ahí"). Hay que distinguirlos o se acaba con
      // números de temporada guardados como si fueran categorías.
      const parsed = parseSubTitle(l.subTitle);

      out.push({
        sourceId: this.id,
        sourceChannelId: slug,
        start: start.toMillis(),
        stop: stop.toMillis(),
        title: l.title,
        subTitle: parsed.episodeTitle,
        categories: parsed.category ? [parsed.category] : [],
        episode: parsed.episode,
        desc: l.synopsis,
        images,
        externalIds,
        raw: l,
      });
    }
    return out;
  }
}
