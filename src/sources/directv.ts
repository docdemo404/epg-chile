import { DateTime } from 'luxon';
import { getSourceConfig, loadConfig } from '../core/config.ts';
import { requestJson } from '../core/http.ts';
import { isFallbackImage, parseDirectvDateTime, preferHttps } from '../core/normalize.ts';
import type { EpgSource, FetchRange, ImageRef, RawChannel, RawProgramme } from '../core/types.ts';

/**
 * DirecTV Chile — WebMethods de ASP.NET tras `guia.aspx`.
 *
 * Sin autenticación: basta un POST con `Content-Type: application/json`.
 *
 * Dos trampas verificadas contra la API real:
 *
 *  1. `filtersScreenFilters` DEBE ser `[""]` y `isHd` DEBE ser `""`. Con `[]`
 *     o `"N"` el servidor responde `{"d":""}` — un 200 vacío, sin error. El
 *     comentario del propio bundle lo explica: el array lleva la cadena vacía
 *     para que funcione el Table Value Parameter de SQL Server.
 *
 *  2. Los horarios llegan como texto sin zona ("7/27/2026 2:00:00 PM") y son
 *     hora de Santiago. Se convierten a UTC aquí y en ningún otro sitio.
 *
 * Aporta la grilla más completa y póster en el 100% de los programas, pero no
 * entrega descripción ni elenco: esos campos existen y siempre vienen vacíos.
 */

interface DtvProgram {
  eventId?: string;
  titleId?: string;
  tmsId?: string;
  title?: string;
  description?: string;
  episodeTitle?: string | null;
  channelNumber?: number;
  channelName?: string;
  channelFullName?: string;
  contentChannelID?: number;
  categoryId?: string;
  rating?: string;
  imageUrl?: string;
  isHD?: string;
  startTimeString?: string;
  endTimeString?: string;
}

interface DtvChannel {
  ChannelName?: string;
  ChannelFullName?: string;
  ChannelNumber?: number;
  ContentChannelID?: number;
  ImageUrl?: string;
  ProgramList?: DtvProgram[];
}

interface DtvEnvelope<T> {
  d: T;
}

/** Categorías de DirecTV traducidas a etiquetas legibles en español. */
const CATEGORY_MAP: Record<string, string> = {
  Movies: 'Película',
  Series: 'Serie',
  Special: 'Especial',
  Sports: 'Deportes',
  Soccer: 'Fútbol',
  News: 'Noticias',
  Current: 'Actualidad',
  Talk: 'Programa de conversación',
  Children: 'Infantil',
  Animation: 'Animación',
  Documentary: 'Documental',
  Music: 'Música',
  Religion: 'Religión',
  Nature: 'Naturaleza',
  Animals: 'Animales',
  Weather: 'Clima',
  Educational: 'Educativo',
  Biography: 'Biografía',
  History: 'Historia',
  Art: 'Arte',
  Fashion: 'Moda',
  Cooking: 'Cocina',
  Travel: 'Viajes',
  'Game Show': 'Concurso',
  'Soap Opera': 'Telenovela',
  'Business/Financial': 'Economía',
  'Exercise/Fitness': 'Fitness',
  Drama: 'Drama',
  Horse: 'Hípica',
  Adult: 'Adultos',
};

export class DirectvSource implements EpgSource {
  readonly id = 'directv';

  #url(method: string): string {
    const cfg = getSourceConfig(this.id);
    return `${cfg.baseUrl}/guia/guia.aspx/${method}`;
  }

  #headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json; charset=utf-8',
      Referer: `${getSourceConfig(this.id).baseUrl}/guia/guia.aspx`,
    };
  }

  /** Hora del servidor de DirecTV; sirve para validar la ventana pedida. */
  async getServerTime(): Promise<{ current: string; modified: string } | null> {
    try {
      const res = await requestJson<DtvEnvelope<{ CurrentTime: string; ModifiedTime: string }>>(
        this.id,
        this.#url('GetCountryDateTime'),
        { method: 'POST', body: {}, headers: this.#headers(), noCache: true },
      );
      return { current: res.d.CurrentTime, modified: res.d.ModifiedTime };
    } catch {
      return null;
    }
  }

  /**
   * Pide un bloque de grilla. `time` es la hora local de Santiago del bloque.
   * Devuelve `[]` si el servidor responde vacío.
   */
  async #fetchBlock(local: DateTime): Promise<DtvChannel[]> {
    const res = await requestJson<DtvEnvelope<DtvChannel[] | string>>(
      this.id,
      this.#url('GetProgramming'),
      {
        method: 'POST',
        headers: this.#headers(),
        body: {
          filterParam: {
            day: local.day,
            time: local.hour,
            minute: 0,
            month: local.month,
            year: local.year,
            offSetValue: 0,
            homeScreenFilter: '',
            // Ambos valores son obligatorios tal cual: ver nota de arriba.
            filtersScreenFilters: [''],
            isHd: '',
          },
        },
      },
    );
    return Array.isArray(res.d) ? res.d : [];
  }

  async fetchChannels(): Promise<RawChannel[]> {
    const zone = loadConfig().app.timezone;
    const now = DateTime.now().setZone(zone);
    const blocks = await this.#fetchBlock(now.startOf('hour'));

    // La grilla repite el mismo canal una vez por señal (SD, HD, y a veces
    // varias regionales) distinguidas por contentChannelID. Cada señal es su
    // propio canal en origen; la unificación posterior las agrupa.
    const seen = new Map<string, RawChannel>();
    for (const ch of blocks) {
      const contentId = ch.ContentChannelID ?? ch.ChannelNumber;
      if (contentId === undefined) continue;
      const key = String(contentId);
      if (seen.has(key)) continue;
      const name = (ch.ChannelName ?? ch.ChannelFullName ?? key).trim();
      const logos: ImageRef[] =
        ch.ImageUrl && !isFallbackImage(ch.ImageUrl)
          ? [{ url: preferHttps(ch.ImageUrl), kind: 'logo' }]
          : [];
      seen.set(key, {
        sourceId: this.id,
        sourceChannelId: key,
        name,
        fullName: ch.ChannelFullName?.trim(),
        number: ch.ChannelNumber,
        logos,
        isHD: /HD$/i.test(name),
        raw: { ChannelName: ch.ChannelName, ChannelNumber: ch.ChannelNumber, ContentChannelID: contentId },
      });
    }
    return [...seen.values()];
  }

  async fetchProgrammes(range: FetchRange): Promise<RawProgramme[]> {
    const cfg = loadConfig();
    const zone = cfg.app.timezone;
    const blockHours = (getSourceConfig(this.id) as unknown as { blockHours?: number }).blockHours ?? 3;

    // La grilla se sirve en bloques alineados a múltiplos de blockHours.
    let cursor = DateTime.fromMillis(range.from, { zone: 'utc' }).setZone(zone).startOf('hour');
    cursor = cursor.set({ hour: Math.floor(cursor.hour / blockHours) * blockHours });
    const end = DateTime.fromMillis(range.to, { zone: 'utc' }).setZone(zone);

    const out: RawProgramme[] = [];
    const seen = new Set<string>();

    while (cursor < end) {
      const blocks = await this.#fetchBlock(cursor);
      for (const ch of blocks) {
        const contentId = String(ch.ContentChannelID ?? ch.ChannelNumber ?? '');
        if (!contentId) continue;
        for (const p of ch.ProgramList ?? []) {
          const prog = this.#toProgramme(p, contentId, zone);
          if (!prog) continue;
          // Los bloques se solapan en los bordes; deduplicar por evento.
          const key = `${contentId}|${prog.start}|${prog.title}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(prog);
        }
      }
      cursor = cursor.plus({ hours: blockHours });
    }
    return out;
  }

  #toProgramme(p: DtvProgram, contentChannelId: string, zone: string): RawProgramme | null {
    if (!p.startTimeString || !p.endTimeString) return null;
    const start = parseDirectvDateTime(p.startTimeString, zone);
    const stop = parseDirectvDateTime(p.endTimeString, zone);
    if (start === null || stop === null || stop <= start) return null;

    const images: ImageRef[] = p.imageUrl && !isFallbackImage(p.imageUrl)
      ? [{ url: preferHttps(p.imageUrl), kind: 'poster' }]
      : [];

    const categories: string[] = [];
    if (p.categoryId) {
      categories.push(CATEGORY_MAP[p.categoryId] ?? p.categoryId);
    }

    const externalIds: Record<string, string> = {};
    // tmsId es el identificador de Gracenote: el mejor ancla para cruzar
    // fuentes y para que consumidores externos enriquezcan por su cuenta.
    if (p.tmsId) externalIds.tmsId = p.tmsId;
    if (p.eventId) externalIds.directvEventId = p.eventId;

    // description y episodeTitle existen en el modelo pero DirecTV Chile los
    // devuelve siempre vacíos; se mapean igual por si algún día se pueblan.
    const desc = p.description?.trim() || undefined;
    const subTitle = p.episodeTitle?.trim() || undefined;

    return {
      sourceId: this.id,
      sourceChannelId: contentChannelId,
      start,
      stop,
      title: (p.title ?? '').trim() || 'Sin título',
      subTitle,
      desc,
      categories,
      images,
      rating: p.rating?.trim() || undefined,
      externalIds,
      raw: p,
    };
  }
}
