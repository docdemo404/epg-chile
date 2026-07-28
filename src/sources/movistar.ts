import { getSourceConfig } from '../core/config.ts';
import { requestJson } from '../core/http.ts';
import { preferHttps } from '../core/normalize.ts';
import { getDictionary, saveDictionary } from '../db/repo.ts';
import type { EpgSource, FetchRange, ImageRef, RawChannel, RawProgramme } from '../core/types.ts';

/**
 * Movistar TV Chile — Telefónica GVP ContentAPI.
 *
 * Es una API REST pública, sin autenticación. La base se arma como
 * `{host}/{instance}/{catalog}/{language}`, tal como hace `getContentapiPath()`
 * en el bundle de movistartv.cl.
 *
 * Es la fuente más rica del proyecto: única que entrega descripción, elenco,
 * géneros y rating por edad. Su contrapartida es que actores/géneros/ratings
 * llegan como PIDs (`PER66091`, `GEN6`, `AGE103`) y hay que resolverlos en una
 * segunda llamada; por eso se cachean en `ca_dictionary`.
 */

interface CaEnvelope<T> {
  Content: { List: T[]; Count: number } | T[] | null;
  HttpStatusCode: number;
  StatusMessage: string;
}

interface CaImage {
  Url: string;
  SourceImageWidth?: number;
  SourceImageHeight?: number;
}

interface CaChannel {
  Pid: string;
  Name?: string;
  Title?: string;
  ChannelNumber?: number;
  Images?: { Logo?: CaImage[] };
}

interface CaSchedule {
  Pid: string;
  Title?: string;
  Description?: string;
  ShortDescription?: string;
  ChannelName?: string;
  ChannelNumber?: number;
  LiveChannelPid?: string;
  /** Epoch en SEGUNDOS. */
  Start?: number;
  End?: number;
  SeriesId?: number;
  SeasonNumber?: number;
  EpisodeNumber?: number;
  AgeRatingPid?: string;
  Images?: { VideoFrame?: CaImage[]; Banner?: CaImage[] };
  Relations?: { GenrePids?: string[]; ActorPids?: string[]; DirectorPids?: string[] };
}

const CHANNEL_FIELDS = ['Pid', 'Name', 'Title', 'ChannelNumber', 'images.logo'].join(',');

const SCHEDULE_FIELDS = [
  'Pid',
  'Title',
  'Description',
  'ShortDescription',
  'ChannelName',
  'ChannelNumber',
  'LiveChannelPid',
  'Start',
  'End',
  'SeriesId',
  'SeasonNumber',
  'EpisodeNumber',
  'AgeRatingPid',
  'images.videoFrame',
  'images.banner',
].join(',');

function unwrapList<T>(env: CaEnvelope<T>): T[] {
  const c = env.Content;
  if (!c) return [];
  if (Array.isArray(c)) return c;
  return c.List ?? [];
}

function toImages(list: CaImage[] | undefined, kind: ImageRef['kind']): ImageRef[] {
  return (list ?? [])
    .filter((i) => i.Url)
    .map((i) => ({
      url: preferHttps(i.Url),
      kind,
      width: i.SourceImageWidth,
      height: i.SourceImageHeight,
    }));
}

export class MovistarSource implements EpgSource {
  readonly id = 'movistar';

  #base(): string {
    const cfg = getSourceConfig(this.id);
    const { baseUrl, instance, catalog, language } = cfg as unknown as {
      baseUrl: string;
      instance: string;
      catalog: string;
      language: string;
    };
    return `${baseUrl}/${instance}/${catalog}/${language}`;
  }

  #headers(): Record<string, string> {
    const cfg = getSourceConfig(this.id) as unknown as { referer?: string };
    return cfg.referer ? { Referer: cfg.referer, Origin: cfg.referer.replace(/\/$/, '') } : {};
  }

  async fetchChannels(): Promise<RawChannel[]> {
    const url =
      `${this.#base()}/contents/all?contentTypes=LCH&ca_active=true` +
      `&orderBy=contentOrder&fields=${encodeURIComponent(CHANNEL_FIELDS)}&limit=10000`;
    const env = await requestJson<CaEnvelope<CaChannel>>(this.id, url, { headers: this.#headers() });
    return unwrapList(env)
      .filter((c) => c.Pid)
      .map((c) => ({
        sourceId: this.id,
        sourceChannelId: c.Pid,
        name: (c.Name ?? c.Title ?? c.Pid).trim(),
        fullName: c.Title?.trim(),
        number: c.ChannelNumber,
        logos: toImages(c.Images?.Logo, 'logo'),
        raw: c,
      }));
  }

  async fetchProgrammes(range: FetchRange, channels: RawChannel[]): Promise<RawProgramme[]> {
    const cfg = getSourceConfig(this.id) as unknown as {
      channelBatchSize: number;
      windowHours: number;
    };
    const batchSize = cfg.channelBatchSize ?? 20;
    const windowMs = (cfg.windowHours ?? 6) * 3_600_000;

    const pids = channels.map((c) => c.sourceChannelId);
    const batches: string[][] = [];
    for (let i = 0; i < pids.length; i += batchSize) {
      batches.push(pids.slice(i, i + batchSize));
    }

    const windows: FetchRange[] = [];
    for (let t = range.from; t < range.to; t += windowMs) {
      windows.push({ from: t, to: Math.min(t + windowMs, range.to) });
    }

    const raw: CaSchedule[] = [];
    // Secuencial a propósito: el limitador del cliente HTTP ya controla la
    // concurrencia y así el progreso es legible en los logs.
    for (const w of windows) {
      for (const batch of batches) {
        raw.push(...(await this.#fetchScheduleWindow(batch, w)));
      }
    }

    const dict = await this.#resolveDictionary(raw);
    return raw
      .filter((s) => s.Start && s.End && s.LiveChannelPid)
      .map((s) => this.#toProgramme(s, dict));
  }

  async #fetchScheduleWindow(pids: string[], window: FetchRange): Promise<CaSchedule[]> {
    const startSec = Math.floor(window.from / 1000);
    const endSec = Math.floor(window.to / 1000);
    const url =
      `${this.#base()}/schedules?liveChannelPids=${pids.join(',')}` +
      `&startTime=${startSec}&endTime=${endSec}` +
      `&fields=${encodeURIComponent(SCHEDULE_FIELDS)}` +
      `&includeRelations=Genre,Actor,Director&relatedContents=true&limit=10000`;
    const env = await requestJson<CaEnvelope<CaSchedule>>(this.id, url, { headers: this.#headers() });
    return unwrapList(env);
  }

  /**
   * Resuelve los PIDs de personas, géneros y ratings a nombres legibles.
   *
   * Solo se consultan los que no estén ya en `ca_dictionary`: son estables en
   * el tiempo, así que tras la primera ingesta esto casi no genera tráfico.
   */
  async #resolveDictionary(schedules: CaSchedule[]): Promise<Map<string, string>> {
    const needed = new Set<string>();
    for (const s of schedules) {
      for (const p of s.Relations?.GenrePids ?? []) needed.add(p);
      for (const p of s.Relations?.ActorPids ?? []) needed.add(p);
      for (const p of s.Relations?.DirectorPids ?? []) needed.add(p);
      if (s.AgeRatingPid) needed.add(s.AgeRatingPid);
    }
    if (!needed.size) return new Map();

    const all = [...needed];
    const cached = await getDictionary(all);
    const missing = all.filter((p) => !cached.has(p));

    const fetched: { pid: string; kind: string; title: string }[] = [];
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      const url = `${this.#base()}/contents?pids=${batch.join(',')}&fields=Pid,Title,Name`;
      try {
        const env = await requestJson<CaEnvelope<{ Pid: string; Title?: string; Name?: string }>>(
          this.id,
          url,
          { headers: this.#headers() },
        );
        for (const item of unwrapList(env)) {
          const title = (item.Title ?? item.Name ?? '').trim();
          if (!item.Pid || !title) continue;
          fetched.push({ pid: item.Pid, kind: item.Pid.slice(0, 3), title });
          cached.set(item.Pid, title);
        }
      } catch {
        // Un lote fallido degrada metadatos, no rompe la ingesta: el programa
        // sale sin ese actor o género y el resto de la guía sigue en pie.
      }
    }
    if (fetched.length) await saveDictionary(fetched);
    return cached;
  }

  #toProgramme(s: CaSchedule, dict: Map<string, string>): RawProgramme {
    const resolve = (pids: string[] | undefined): string[] =>
      (pids ?? []).map((p) => dict.get(p)).filter((v): v is string => Boolean(v));

    const actors = resolve(s.Relations?.ActorPids);
    const directors = resolve(s.Relations?.DirectorPids);
    const categories = resolve(s.Relations?.GenrePids);

    const images = [
      ...toImages(s.Images?.VideoFrame, 'videoFrame'),
      ...toImages(s.Images?.Banner, 'banner'),
    ];

    const externalIds: Record<string, string> = { movistarPid: s.Pid };
    if (s.SeriesId) externalIds.movistarSeriesId = String(s.SeriesId);

    const season = s.SeasonNumber && s.SeasonNumber > 0 ? s.SeasonNumber : undefined;
    const episode = s.EpisodeNumber && s.EpisodeNumber > 0 ? s.EpisodeNumber : undefined;

    // Description es la larga; ShortDescription sirve de respaldo y, si ambas
    // existen y difieren, la corta hace de subtítulo.
    const desc = s.Description?.trim() || s.ShortDescription?.trim() || undefined;
    const short = s.ShortDescription?.trim();
    const subTitle = short && short !== desc ? short : undefined;

    return {
      sourceId: this.id,
      sourceChannelId: s.LiveChannelPid!,
      // Start/End vienen en segundos.
      start: s.Start! * 1000,
      stop: s.End! * 1000,
      title: (s.Title ?? '').trim() || 'Sin título',
      subTitle,
      desc,
      categories,
      images,
      credits: actors.length || directors.length ? { actors, directors } : undefined,
      rating: s.AgeRatingPid ? dict.get(s.AgeRatingPid) : undefined,
      episode: season || episode ? { season, episode } : undefined,
      seriesId: s.SeriesId ? String(s.SeriesId) : undefined,
      externalIds,
      raw: s,
    };
  }
}
