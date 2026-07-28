import { DateTime } from 'luxon';
import { getSourceConfig, loadConfig } from '../core/config.ts';
import { mapLimit, request } from '../core/http.ts';
import { isFallbackImage, preferHttps } from '../core/normalize.ts';
import type { EpgSource, FetchRange, ImageRef, RawChannel, RawProgramme } from '../core/types.ts';

/**
 * Canales de parrilla fija — la misma programación cada semana.
 *
 * Los canales locales pequeños no tienen EPG en ningún operador ni una web que
 * scrapear: publican una parrilla semanal que se repite y que solo cambia
 * cuando el canal reorganiza sus bloques. Esta fuente toma ese horario semanal
 * y lo expande a fechas concretas dentro de la ventana de la guía.
 *
 * La parrilla vive FUERA del repositorio, en la URL que declara cada canal en
 * sources.yaml, y se vuelve a descargar en cada ingesta: así el dueño del
 * horario lo corrige sin tocar el código ni volver a desplegar.
 *
 * Formato esperado (el resto de campos se ignora):
 *
 *   {
 *     "canal": "Diferencia TV",
 *     "programacion": {
 *       "lunes_a_viernes": {
 *         "bloques": [
 *           { "hora": "08:00", "programa": "…", "descripcion": "…",
 *             "categoria": "…", "imagen": { "url": "…" } }
 *         ]
 *       },
 *       "sabado_y_domingo": { "bloques": [ … ] }
 *     }
 *   }
 *
 * Solo hace falta la hora de inicio: cada bloque termina donde empieza el
 * siguiente, incluso si el siguiente es del día de después. Así el bloque de
 * cierre cubre la madrugada hasta el inicio de transmisiones, en vez de dejar
 * un hueco que el reproductor muestra como "sin información".
 */

interface WeeklyBlock {
  hora?: string;
  programa?: string;
  descripcion?: string;
  categoria?: string;
  categorias?: string[];
  imagen?: { url?: string; alt?: string };
}

interface WeeklyPeriod {
  periodo?: string;
  bloques?: WeeklyBlock[];
}

interface WeeklySchedule {
  canal?: string;
  programacion?: Record<string, WeeklyPeriod>;
}

interface WeeklyChannelConfig {
  id: string;
  url: string;
  name?: string;
  fullName?: string;
  number?: number;
  logo?: string;
}

/** Un bloque ya situado en el calendario, todavía sin hora de fin. */
interface PlacedBlock {
  start: number;
  block: WeeklyBlock;
}

const DAYS: Record<string, number> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  domingo: 7,
};

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Traduce la etiqueta de un periodo a los días de la semana que cubre.
 *
 * Acepta las formas en que se escribe una parrilla a mano: "lunes_a_viernes",
 * "sabado y domingo", "domingo", "todos los días". La palabra "a" entre dos
 * días es un rango, y puede dar la vuelta a la semana ("viernes a lunes").
 */
export function weekdaysFromLabel(label: string): number[] {
  const tokens = stripAccents(label.toLowerCase())
    .split(/[^a-z]+/)
    .filter(Boolean);

  if (tokens.some((t) => t === 'todos' || t === 'diario' || t === 'diaria')) {
    return [1, 2, 3, 4, 5, 6, 7];
  }

  const days = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const day = DAYS[tokens[i]!];
    if (day === undefined) continue;
    days.add(day);

    // "lunes a viernes": el rango se expande, dando la vuelta si hace falta.
    const link = tokens[i + 1];
    const next = tokens[i + 2] ? DAYS[tokens[i + 2]!] : undefined;
    if ((link === 'a' || link === 'al' || link === 'hasta') && next !== undefined) {
      for (let d = day; ; d = (d % 7) + 1) {
        days.add(d);
        if (d === next) break;
      }
      i += 2;
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Expande una parrilla semanal a emisiones con fecha concreta.
 *
 * Exportada para las pruebas: es la pieza con toda la aritmética delicada
 * —cambio de día, cambio de periodo y cambio de hora de Chile— y la única que
 * no depende de la red.
 */
export function expandSchedule(
  schedule: WeeklySchedule,
  range: FetchRange,
  zone: string,
): PlacedBlock[] {
  const periods = Object.entries(schedule.programacion ?? {})
    .map(([key, period]) => ({
      days: weekdaysFromLabel(period?.periodo || key),
      blocks: (period?.bloques ?? []).filter((b) => b?.hora && b?.programa),
    }))
    .filter((p) => p.days.length && p.blocks.length)
    // El periodo más específico gana: así se puede añadir un "domingo" aparte
    // sin tener que desmontar el "lunes a domingo" que ya estaba.
    .sort((a, b) => a.days.length - b.days.length);

  if (!periods.length) return [];

  // Se arranca un día antes de la ventana porque el último bloque de la noche
  // anterior sigue en pantalla de madrugada, y se termina un día después para
  // que el último bloque tenga con qué cerrar.
  const first = DateTime.fromMillis(range.from, { zone: 'utc' }).setZone(zone).startOf('day').minus({ days: 1 });
  const last = DateTime.fromMillis(range.to, { zone: 'utc' }).setZone(zone).startOf('day').plus({ days: 1 });

  const placed: PlacedBlock[] = [];

  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    const period = periods.find((p) => p.days.includes(day.weekday));
    if (!period) continue;

    let dayOffset = 0;
    let prevMinutes = -1;

    for (const block of period.blocks) {
      const m = block.hora!.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) continue;
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour > 23 || minute > 59) continue;

      // La parrilla sigue el orden de emisión, así que una hora que retrocede
      // respecto de la anterior es la madrugada del día siguiente: el bloque
      // de las 00:30 pertenece al día de después, no al de las 08:00.
      const minutes = hour * 60 + minute;
      if (prevMinutes >= 0 && minutes <= prevMinutes) dayOffset++;
      prevMinutes = minutes;

      const start = day.plus({ days: dayOffset }).set({ hour, minute, second: 0, millisecond: 0 });
      if (!start.isValid) continue;
      placed.push({ start: start.toMillis(), block });
    }
  }

  placed.sort((a, b) => a.start - b.start);
  // Dos bloques a la misma hora son un error de la parrilla: manda el primero.
  return placed.filter((p, i) => i === 0 || p.start !== placed[i - 1]!.start);
}

export class WeeklySource implements EpgSource {
  readonly id = 'weekly';

  #channels(): WeeklyChannelConfig[] {
    const cfg = getSourceConfig(this.id) as unknown as { channels?: WeeklyChannelConfig[] };
    return (cfg.channels ?? []).filter((c) => c?.id && c?.url);
  }

  async fetchChannels(): Promise<RawChannel[]> {
    const out: RawChannel[] = [];

    for (const channel of this.#channels()) {
      // El nombre configurado manda sobre el del archivo: es el que el dueño
      // de esta guía eligió, y el archivo lo edita un tercero.
      let fromFile: string | undefined;
      try {
        fromFile = (await this.#schedule(channel)).canal?.trim();
      } catch {
        // Que la parrilla no cargue no debe borrar el canal de la guía: sin
        // canal, el merge tiraría también las emisiones de la última ingesta
        // buena que siguen en la capa cruda.
      }

      const logos: ImageRef[] =
        channel.logo && !isFallbackImage(channel.logo)
          ? [{ url: preferHttps(channel.logo), kind: 'logo' }]
          : [];

      out.push({
        sourceId: this.id,
        sourceChannelId: channel.id,
        name: channel.name?.trim() || fromFile || channel.id,
        fullName: channel.fullName?.trim(),
        number: channel.number,
        logos,
        raw: { url: channel.url, canal: fromFile },
      });
    }
    return out;
  }

  async fetchProgrammes(range: FetchRange, channels: RawChannel[]): Promise<RawProgramme[]> {
    const zone = loadConfig().app.timezone;
    const wanted = new Set(channels.map((c) => c.sourceChannelId));
    const out: RawProgramme[] = [];

    for (const channel of this.#channels()) {
      if (!wanted.has(channel.id)) continue;
      try {
        out.push(...(await this.#fetchChannel(channel, range, zone)));
      } catch {
        // Un canal que falla no arrastra a los demás.
      }
    }
    return out;
  }

  async #schedule(channel: WeeklyChannelConfig): Promise<WeeklySchedule> {
    const text = await request(this.id, channel.url, { cacheTtlMinutes: 60 });
    // El archivo lo edita una persona a mano: un BOM o unos espacios delante
    // son más probables que un JSON perfectamente recortado.
    const parsed = JSON.parse(text.replace(/^﻿/, '').trim()) as WeeklySchedule;
    if (!parsed?.programacion) {
      throw new Error(`La parrilla de ${channel.id} no trae "programacion"`);
    }
    return parsed;
  }

  async #fetchChannel(
    channel: WeeklyChannelConfig,
    range: FetchRange,
    zone: string,
  ): Promise<RawProgramme[]> {
    const schedule = await this.#schedule(channel);
    const placed = expandSchedule(schedule, range, zone);
    const usable = await this.#usableImages(placed);

    const out: RawProgramme[] = [];
    for (let i = 0; i < placed.length; i++) {
      const { start, block } = placed[i]!;
      // Cada bloque termina donde empieza el siguiente. El último del
      // recorrido se descarta: cae fuera de la ventana y no tiene con qué
      // cerrar, así que inventarle un fin sería inventar programación.
      const stop = placed[i + 1]?.start;
      if (stop === undefined || stop <= start) continue;
      if (stop <= range.from || start >= range.to) continue;

      const image = block.imagen?.url?.trim();
      const images: ImageRef[] =
        image && usable.has(image) ? [{ url: preferHttps(image), kind: 'poster' }] : [];

      const categories = (block.categorias ?? (block.categoria ? [block.categoria] : []))
        .map((c) => c.trim())
        .filter(Boolean);

      out.push({
        sourceId: this.id,
        sourceChannelId: channel.id,
        start,
        stop,
        title: block.programa!.trim(),
        desc: block.descripcion?.trim() || undefined,
        categories,
        images,
        externalIds: {},
        raw: block,
      });
    }
    return out;
  }

  /**
   * Comprueba qué imágenes de la parrilla existen de verdad.
   *
   * Las demás fuentes no necesitan esto porque sus imágenes salen del CDN del
   * propio operador. Aquí las URLs las escribe a mano quien mantiene el
   * archivo, y hoy mismo la mitad apunta a un host que no responde: colar esas
   * URLs en la guía deja al reproductor esperando por una imagen que no va a
   * llegar. Son una docena de URLs distintas por canal, así que verificarlas
   * una vez por ingesta no le cuesta nada a nadie.
   *
   * Ante la duda se conserva la imagen: solo se descarta lo que responde un
   * error claro, no lo que falla por un corte de red puntual.
   */
  async #usableImages(placed: PlacedBlock[]): Promise<Set<string>> {
    const urls = [
      ...new Set(
        placed
          .map((p) => p.block.imagen?.url?.trim())
          .filter((u): u is string => Boolean(u) && !isFallbackImage(u)),
      ),
    ];
    if (!urls.length) return new Set();

    const results = await mapLimit(urls, 4, async (url) => {
      try {
        const res = await fetch(url, {
          method: 'HEAD',
          headers: { 'User-Agent': loadConfig().app.userAgent },
          signal: AbortSignal.timeout(8000),
        });
        // Algunos servidores no implementan HEAD: un 405 no dice que la
        // imagen falte.
        return { url, ok: res.ok || res.status === 405 };
      } catch {
        return { url, ok: false };
      }
    });

    return new Set(results.filter((r) => r.ok).map((r) => r.url));
  }
}
