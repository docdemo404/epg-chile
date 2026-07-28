import { getSourceConfig } from '../core/config.ts';
import { requestJson } from '../core/http.ts';
import { preferHttps } from '../core/normalize.ts';
import type { EpgSource, FetchRange, ImageRef, RawChannel, RawProgramme } from '../core/types.ts';

/**
 * Tivify (España) — CDN público de TVUP.
 *
 * OJO: esta fuente es ESPAÑOLA y va marcada como `isolated` en sources.yaml.
 * Sus canales nunca se unifican con los chilenos ni le prestan metadatos a
 * nadie: "La 1" o "Cuatro" no tienen contrapartida en Chile, y un emparejado
 * difuso entre parrillas de países distintos solo puede producir basura.
 *
 * www.tivify.tv es una SPA sin HTML útil: la guía la sirve el CDN de TVUP en
 * archivos JSON estáticos, uno por día y carrier, que es lo que consume la
 * propia web. El carrier anónimo (`carrierId` en la config) es el que ve quien
 * entra sin cuenta, así que no hace falta autenticarse ni hay nada que evadir.
 *
 * Su ventaja frente a las fuentes chilenas es el coste: UN request por día
 * cubre los ~314 canales, en vez de uno por canal y día. La contrapartida es
 * el peso —entre 10 y 15 MB por archivo—, de ahí el cron espaciado.
 *
 *   {baseUrl}/media/carrier/{carrierId}/channels.json
 *   {baseUrl}/media/carrier/{carrierId}/epg/{año}/{mes}/{día}.json
 *   {baseUrl}/media/genres.{lang}.json      · géneros por id
 *   {baseUrl}/media/categories.{lang}.json  · categorías por id
 *
 * Las horas llegan en ISO con Z, así que aquí no hay conversión de zona que
 * pueda salir mal: `Date.parse` da directamente epoch UTC.
 */

interface TivifyMaster {
  id: string;
  name?: string;
  title?: string;
  dial?: number;
  type?: string;
  quality?: string;
  showWeb?: boolean;
  logoColor?: string;
  logoBlanco?: string;
}

interface TivifyChannel {
  enabled?: boolean;
  dial?: number;
  channelCode?: string;
  master?: TivifyMaster;
}

interface TivifyPictures {
  poster?: string;
  background?: string;
  photo?: string;
}

interface TivifyEvent {
  _id: string;
  eventId?: string;
  programId?: string;
  channel: string;
  channelName?: string;
  beginTime: string;
  endTime: string;
  title?: string;
  originalTitle?: string;
  episodeTitle?: string;
  synopsis?: string;
  synopsisLong?: string;
  synopsisEpisode?: string;
  category?: string;
  gender?: string;
  actors?: string[];
  directors?: string[];
  hosts?: string[];
  ageCode?: string;
  season?: number;
  episode?: number;
  serieId?: string;
  moviePictures?: TivifyPictures;
}

interface TivifyDictEntry {
  id: string;
  title?: string;
}

interface TivifyConfig {
  baseUrl: string;
  mediaUrl: string;
  carrierId: string;
  language: string;
}

/** Diccionarios de categoría y género, resueltos una vez por ingesta. */
interface Dictionaries {
  categories: Map<string, string>;
  genres: Map<string, string>;
}

/**
 * Las fichas sin arte propio traen la imagen genérica del canal
 * (`/canales/generic_cd_…`). No ilustran el programa, así que se descartan por
 * el mismo motivo que las `fallback` del resto de fuentes.
 */
function isGenericImage(path: string): boolean {
  return /\/generic_/.test(path);
}

/** El tamaño real viene en la query de la propia URL: `?width=246&height=350`. */
function imageSize(path: string): { width?: number; height?: number } {
  const query = path.split('?')[1];
  if (!query) return {};
  const params = new URLSearchParams(query);
  const width = Number(params.get('width'));
  const height = Number(params.get('height'));
  return {
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
  };
}

/**
 * Normaliza el código de edad del ICAA español.
 *
 * Llega con mayúsculas inconsistentes ("TP" y "tp", "Adultos" y "adultos") y
 * con un valor que no es una calificación: "SC" es *sin clasificar*, y
 * publicarlo como rating haría que el reproductor muestre una etiqueta falsa.
 */
export function parseAgeCode(code: string | undefined): string | undefined {
  const value = code?.trim().toUpperCase();
  if (!value || value === 'SC') return undefined;
  return value === 'ADULTOS' ? '+18' : value;
}

export class TivifySource implements EpgSource {
  readonly id = 'tivify';

  #cfg(): TivifyConfig {
    const cfg = getSourceConfig(this.id) as unknown as TivifyConfig;
    return { ...cfg, language: cfg.language || 'es' };
  }

  #carrierUrl(path: string): string {
    const cfg = this.#cfg();
    return `${cfg.baseUrl}/media/carrier/${cfg.carrierId}/${path}`;
  }

  async fetchChannels(): Promise<RawChannel[]> {
    const cfg = this.#cfg();
    const list = await requestJson<TivifyChannel[]>(this.id, this.#carrierUrl('channels.json'), {
      cacheTtlMinutes: 12 * 60,
    });

    return list
      .filter((c) => c.enabled !== false && c.master?.id && c.master.showWeb !== false)
      .map((c) => {
        const master = c.master!;
        const logos: ImageRef[] = [];
        const logo = master.logoColor || master.logoBlanco;
        if (logo && !isGenericImage(logo)) {
          logos.push({ url: `${cfg.mediaUrl}${logo}`, kind: 'logo', ...imageSize(logo) });
        }

        return {
          sourceId: this.id,
          sourceChannelId: master.id,
          // `master.name` es el código interno del headend ("GNC01"): el
          // nombre que ve el espectador está en `title`.
          name: (master.title ?? master.name ?? master.id).trim(),
          // El dial de la entrada es la posición en la parrilla de este
          // carrier (La 1 = 1); el de `master` es el del canal en abstracto y
          // se repite entre autonómicas.
          number: c.dial ?? master.dial,
          logos,
          isHD: master.quality?.toUpperCase() === 'HD',
          raw: { channelCode: c.channelCode, master },
        } satisfies RawChannel;
      });
  }

  async fetchProgrammes(range: FetchRange, channels: RawChannel[]): Promise<RawProgramme[]> {
    const known = new Set(channels.map((c) => c.sourceChannelId));
    const dicts = await this.#dictionaries();
    const out: RawProgramme[] = [];

    // Un mismo evento aparece varias veces: repetido dentro del archivo del
    // día (mismo `eventId`, distinto `_id`) y otra vez en el archivo de cada
    // día que atraviesa. Sin deduplicar, el merge los ve como emisiones
    // rivales y acaba recortándolas unas contra otras.
    const seen = new Set<string>();

    for (const day of utcDaysInRange(range)) {
      let events: TivifyEvent[];
      try {
        events = await requestJson<TivifyEvent[]>(this.id, this.#carrierUrl(`epg/${day}.json`));
      } catch {
        // Un día que falta no invalida los demás: la guía se queda más corta
        // por ese extremo en vez de quedarse vacía.
        continue;
      }

      for (const e of events) {
        if (!known.has(e.channel)) continue;
        const start = Date.parse(e.beginTime);
        const stop = Date.parse(e.endTime);
        if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) continue;
        if (stop <= range.from || start >= range.to) continue;

        const key = e.eventId ?? e._id;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push(this.#toProgramme(e, start, stop, dicts));
      }
    }
    return out;
  }

  /**
   * Categorías y géneros llegan como ids de Mongo; los diccionarios que los
   * traducen son dos archivos pequeños del mismo CDN. Se cachean un día
   * entero porque cambian con la frecuencia de un catálogo, no de una guía.
   */
  async #dictionaries(): Promise<Dictionaries> {
    const cfg = this.#cfg();
    const load = async (name: string): Promise<Map<string, string>> => {
      try {
        const entries = await requestJson<TivifyDictEntry[]>(
          this.id,
          `${cfg.baseUrl}/media/${name}.${cfg.language}.json`,
          { cacheTtlMinutes: 24 * 60 },
        );
        return new Map(entries.filter((e) => e.id && e.title).map((e) => [e.id, e.title!.trim()]));
      } catch {
        // Sin diccionario la guía sale sin categorías, que es mucho mejor que
        // salir con los ids crudos metidos donde va un género.
        return new Map();
      }
    };

    const [categories, genres] = await Promise.all([load('categories'), load('genres')]);
    return { categories, genres };
  }

  #toProgramme(e: TivifyEvent, start: number, stop: number, dicts: Dictionaries): RawProgramme {
    const cfg = this.#cfg();

    // La categoría es la familia ("Series", "Cine") y el género el matiz
    // ("Comedia"): se emiten en ese orden porque los reproductores solo miran
    // la primera. "Otros" es el cajón de sastre de la fuente y no clasifica
    // nada, así que se descarta.
    const categories = [dicts.categories.get(e.category ?? ''), dicts.genres.get(e.gender ?? '')]
      .filter((c): c is string => Boolean(c) && c !== 'Otros')
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const images: ImageRef[] = [];
    const addImage = (path: string | undefined, kind: ImageRef['kind']): void => {
      if (!path || isGenericImage(path)) return;
      images.push({ url: preferHttps(`${cfg.mediaUrl}${path}`), kind, ...imageSize(path) });
    };
    addImage(e.moviePictures?.poster, 'poster');
    addImage(e.moviePictures?.background, 'videoFrame');

    const actors = (e.actors ?? []).map((a) => a.trim()).filter(Boolean);
    const directors = (e.directors ?? []).map((d) => d.trim()).filter(Boolean);
    const presenters = (e.hosts ?? []).map((h) => h.trim()).filter(Boolean);

    const externalIds: Record<string, string> = {};
    if (e.eventId) externalIds.tivifyEventId = e.eventId;
    if (e.programId) externalIds.tivifyProgramId = e.programId;
    if (e.serieId) externalIds.tivifySerieId = e.serieId;

    const season = e.season && e.season > 0 ? e.season : undefined;
    const episode = e.episode && e.episode > 0 ? e.episode : undefined;

    // `synopsisEpisode` describe el capítulo concreto y las otras dos la serie:
    // cuando existe es la que de verdad informa. `synopsis` viene recortada
    // con puntos suspensivos, así que la larga va antes.
    const desc =
      e.synopsisEpisode?.trim() || e.synopsisLong?.trim() || e.synopsis?.trim() || undefined;

    // El título del episodio a veces repite el del programa; anunciarlo dos
    // veces no aporta.
    const title = (e.title ?? e.originalTitle ?? '').trim() || 'Sin título';
    const episodeTitle = e.episodeTitle?.trim();
    const subTitle = episodeTitle && episodeTitle !== title ? episodeTitle : undefined;

    return {
      sourceId: this.id,
      sourceChannelId: e.channel,
      start,
      stop,
      title,
      subTitle,
      desc,
      categories,
      images,
      credits:
        actors.length || directors.length || presenters.length
          ? { actors, directors, presenters }
          : undefined,
      rating: parseAgeCode(e.ageCode),
      episode: season || episode ? { season, episode } : undefined,
      seriesId: e.serieId,
      externalIds,
      raw: e,
    };
  }
}

/**
 * Días UTC que toca descargar para cubrir una ventana.
 *
 * El CDN indexa los archivos por fecha UTC, no por la hora local de nadie, así
 * que el recorrido se hace en UTC y el filtrado fino por rango lo hace después
 * quien llama. Los meses y días van sin cero a la izquierda, tal como los
 * construye la propia web (`getUTCMonth()+1`).
 */
export function utcDaysInRange(range: FetchRange): string[] {
  const days: string[] = [];
  const cursor = new Date(range.from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(range.to);

  while (cursor.getTime() <= end.getTime()) {
    days.push(`${cursor.getUTCFullYear()}/${cursor.getUTCMonth() + 1}/${cursor.getUTCDate()}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
