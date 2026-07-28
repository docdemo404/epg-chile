import { loadConfig } from './config.ts';
import {
  diceCoefficient,
  isFallbackImage,
  isPresent,
  largestImage,
  normalizeTitle,
} from './normalize.ts';
import type {
  Credits,
  EpisodeRef,
  ImageRef,
  MergedProgramme,
  MergedProgrammeFields,
  Provenance,
  RawProgramme,
} from './types.ts';

/**
 * Fusión de programas entre fuentes con relleno de campos faltantes.
 *
 * Es el corazón del sistema. Ninguna fuente chilena está completa: DirecTV
 * trae póster en el 100% de sus programas y descripción en ninguno; Movistar
 * trae descripción, elenco y géneros. Fusionar campo a campo es lo que
 * produce una guía realmente utilizable.
 *
 * Dos decisiones que importan:
 *
 *  - Se fusiona CAMPO A CAMPO, no registro a registro. Se toma el primer valor
 *    presente según la prioridad configurada para ese campo concreto.
 *  - "Presente" excluye la cadena vacía. DirecTV devuelve `description: ""`
 *    en vez de `null`; tratarlo como valor válido dejaría media guía sin
 *    sinopsis pese a que Movistar sí la tiene.
 *
 * Cada campo registra de qué fuente salió (`provenance`), sin lo cual es
 * imposible depurar un dato raro.
 */

export interface MergeInput {
  channelId: number;
  programmes: RawProgramme[];
}

export interface MergeStats {
  groups: number;
  output: number;
  enrichedFields: Record<string, number>;
  /** Programas que recibieron datos de más de una fuente. */
  crossSourceMerges: number;
  /** Emisiones añadidas por una fuente de respaldo donde la principal no cubría. */
  gapsFilled: number;
  /** Emisiones descartadas por proponer un horario rival al de la principal. */
  discardedRivals: number;
  /** Fuente que fijó el horario de cada canal. */
  primaryBySource: Record<string, number>;
}

/**
 * Fusiona las emisiones de cada canal en una única línea de tiempo.
 *
 * Regla central: por cada canal manda UNA fuente principal, que fija qué
 * programas existen y a qué hora. Las demás actúan como respaldo y solo
 * aportan metadatos a los programas que ya existen.
 *
 * Sin esta regla, dos fuentes que discrepan sobre la parrilla de un canal
 * emiten ambas versiones y el XMLTV sale con emisiones solapadas, que es
 * justo lo que rompe la visualización en Kodi y Tvheadend. Se midió: sin
 * fuente principal aparecían más de mil solapes en 49 canales.
 *
 * Una emisión de respaldo solo entra por derecho propio si cae en un hueco
 * real de la principal — ahí sí suma cobertura en vez de competir.
 */
export function mergeProgrammes(inputs: MergeInput[]): { programmes: MergedProgramme[]; stats: MergeStats } {
  const cfg = loadConfig();
  const { minOverlapRatio, maxStartDriftMinutes, titleThreshold } = cfg.matching.programme;
  const driftMs = maxStartDriftMinutes * 60_000;
  const matchOpts = { minOverlapRatio, driftMs, titleThreshold };

  const priorityOf = new Map<string, number>(cfg.sources.map((s) => [s.id, s.priority]));
  const stats: MergeStats = {
    groups: 0,
    output: 0,
    enrichedFields: {},
    crossSourceMerges: 0,
    gapsFilled: 0,
    discardedRivals: 0,
    primaryBySource: {},
  };
  const out: MergedProgramme[] = [];

  for (const input of inputs) {
    const bySource = new Map<string, RawProgramme[]>();
    for (const p of input.programmes) {
      const arr = bySource.get(p.sourceId) ?? [];
      arr.push(p);
      bySource.set(p.sourceId, arr);
    }

    const primaryId = pickPrimarySource(bySource, priorityOf);
    if (!primaryId) continue;
    stats.primaryBySource[primaryId] = (stats.primaryBySource[primaryId] ?? 0) + 1;

    const anchors = [...(bySource.get(primaryId) ?? [])].sort((a, b) => a.start - b.start);
    const backups: RawProgramme[] = [];
    for (const [sourceId, list] of bySource) {
      if (sourceId !== primaryId) backups.push(...list);
    }
    backups.sort((a, b) => a.start - b.start);
    const claimed = new Array<boolean>(backups.length).fill(false);

    // --- Cada emisión de la principal absorbe sus equivalentes de respaldo.
    for (const anchor of anchors) {
      const group: RawProgramme[] = [anchor];
      for (let j = 0; j < backups.length; j++) {
        if (claimed[j]) continue;
        const cand = backups[j]!;
        if (cand.start > anchor.start + driftMs) break;
        if (cand.start < anchor.start - driftMs) continue;
        // Una sola aportación por fuente: la primera que casa.
        if (group.some((g) => g.sourceId === cand.sourceId)) continue;
        if (!isSameProgramme(anchor, cand, matchOpts)) continue;
        claimed[j] = true;
        group.push(cand);
      }
      stats.groups++;
      if (group.length > 1) stats.crossSourceMerges++;
      out.push(fuseGroup(input.channelId, group, priorityOf, cfg.fieldPriority, stats));
    }

    // --- Lo que quedó sin casar solo entra si rellena un hueco real.
    const timeline = anchors.map((a) => ({ start: a.start, stop: a.stop }));
    for (let j = 0; j < backups.length; j++) {
      if (claimed[j]) continue;
      const cand = backups[j]!;
      if (overlapsAny(cand, timeline)) {
        // Propone un horario rival para una franja ya cubierta: se descarta,
        // porque emitir ambas versiones es lo que genera los solapes.
        stats.discardedRivals++;
        continue;
      }
      timeline.push({ start: cand.start, stop: cand.stop });
      stats.gapsFilled++;
      stats.groups++;
      out.push(fuseGroup(input.channelId, [cand], priorityOf, cfg.fieldPriority, stats));
    }
  }

  const sanitized = resolveTimelineOverlaps(out, stats);
  stats.output = sanitized.length;
  sanitized.sort((a, b) => a.channelId - b.channelId || a.start - b.start);
  return { programmes: sanitized, stats };
}

/** Duración mínima que justifica conservar un fragmento recortado. */
const MIN_TRIMMED_MS = 5 * 60_000;

/**
 * Deja cada canal con una línea de tiempo sin solapes.
 *
 * Hace falta incluso con una única fuente principal: los operadores publican
 * bloques comodín que engloban eventos concretos. Movistar, por ejemplo,
 * anuncia "ESPN Compact" durante nueve horas y dentro coloca la Fórmula 1 de
 * dos horas. Ambas emisiones son legítimas, pero XMLTV no admite solapes.
 *
 * Criterio: gana lo más específico, que es lo más corto. El bloque largo no
 * se descarta sino que se recorta a los huecos que queden libres, para no
 * perder cobertura donde de verdad no hay nada más preciso.
 */
function resolveTimelineOverlaps(
  programmes: MergedProgramme[],
  stats: MergeStats,
): MergedProgramme[] {
  const byChannel = new Map<number, MergedProgramme[]>();
  for (const p of programmes) {
    const arr = byChannel.get(p.channelId) ?? [];
    arr.push(p);
    byChannel.set(p.channelId, arr);
  }

  const out: MergedProgramme[] = [];

  for (const list of byChannel.values()) {
    if (list.length < 2) {
      out.push(...list);
      continue;
    }

    // Más corto primero: la emisión concreta desplaza al bloque comodín.
    const bySpecificity = [...list].sort(
      (a, b) => a.stop - a.start - (b.stop - b.start) || a.start - b.start,
    );

    const accepted: MergedProgramme[] = [];
    const deferred: MergedProgramme[] = [];

    for (const p of bySpecificity) {
      if (accepted.some((q) => p.start < q.stop && p.stop > q.start)) {
        deferred.push(p);
      } else {
        accepted.push(p);
      }
    }

    // Los desplazados se reinsertan recortados a los huecos libres.
    for (const p of deferred) {
      const segments = subtractRanges(
        { start: p.start, stop: p.stop },
        accepted.map((q) => ({ start: q.start, stop: q.stop })),
      ).filter((s) => s.stop - s.start >= MIN_TRIMMED_MS);

      if (!segments.length) {
        stats.discardedRivals++;
        continue;
      }
      for (const seg of segments) {
        accepted.push({ ...p, start: seg.start, stop: seg.stop });
      }
    }

    accepted.sort((a, b) => a.start - b.start);
    out.push(...accepted);
  }

  return out;
}

/** Resta un conjunto de rangos a un rango, devolviendo lo que queda libre. */
function subtractRanges(
  range: { start: number; stop: number },
  blocks: { start: number; stop: number }[],
): { start: number; stop: number }[] {
  const overlapping = blocks
    .filter((b) => b.start < range.stop && b.stop > range.start)
    .sort((a, b) => a.start - b.start);

  const segments: { start: number; stop: number }[] = [];
  let cursor = range.start;
  for (const b of overlapping) {
    if (b.start > cursor) segments.push({ start: cursor, stop: Math.min(b.start, range.stop) });
    cursor = Math.max(cursor, b.stop);
    if (cursor >= range.stop) break;
  }
  if (cursor < range.stop) segments.push({ start: cursor, stop: range.stop });
  return segments;
}

/**
 * Fracción de emisiones, respecto de la fuente más detallada del canal, que
 * una fuente prioritaria necesita para poder fijar el horario.
 */
const MIN_RELATIVE_DETAIL = 0.5;

/**
 * Elige la fuente que fija el horario de un canal.
 *
 * Manda la prioridad configurada, no el volumen de datos: medir solo cobertura
 * entregaba la parrilla al agregador de turno en 137 canales.
 *
 * La viabilidad se mide en NÚMERO DE EMISIONES, no en tiempo cubierto. Los
 * agregadores encadenan cada emisión con la siguiente y no dejan huecos, así
 * que siempre "cubren" el día entero aunque conozcan la mitad de programas
 * que el EPG del operador, que sí deja huecos reales. Midiendo duración,
 * Canal 13 acababa con una parrilla de títulos sueltos pese a que Movistar
 * tenía 38 emisiones con sinopsis para ese mismo canal.
 */
function pickPrimarySource(
  bySource: Map<string, RawProgramme[]>,
  priorityOf: Map<string, number>,
): string | null {
  const candidates = [...bySource.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => ({
      id,
      detail: list.length,
      priority: priorityOf.get(id) ?? 99,
    }));

  if (!candidates.length) return null;

  const maxDetail = Math.max(...candidates.map((c) => c.detail));
  const viable = candidates.filter((c) => c.detail >= maxDetail * MIN_RELATIVE_DETAIL);
  const pool = viable.length ? viable : candidates;

  pool.sort((a, b) => a.priority - b.priority || b.detail - a.detail);
  return pool[0]!.id;
}

function overlapsAny(p: RawProgramme, timeline: { start: number; stop: number }[]): boolean {
  return timeline.some((t) => p.start < t.stop && p.stop > t.start);
}

function isSameProgramme(
  a: RawProgramme,
  b: RawProgramme,
  opts: { minOverlapRatio: number; driftMs: number; titleThreshold: number },
): boolean {
  if (Math.abs(a.start - b.start) > opts.driftMs) return false;

  const overlap = Math.min(a.stop, b.stop) - Math.max(a.start, b.start);
  if (overlap <= 0) return false;
  const shorter = Math.min(a.stop - a.start, b.stop - b.start);
  if (shorter <= 0) return false;
  if (overlap / shorter < opts.minOverlapRatio) return false;

  const ta = normalizeTitle(a.title);
  const tb = normalizeTitle(b.title);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  // Un título contenido en el otro es habitual: "Pampa ilusión" vs
  // "Pampa ilusión - Capítulo 12".
  if (ta.includes(tb) || tb.includes(ta)) return true;
  return diceCoefficient(ta, tb) >= opts.titleThreshold;
}

/**
 * Fusiona un grupo tomando, para cada campo, el primer valor presente según
 * la prioridad de ESE campo.
 */
function fuseGroup(
  channelId: number,
  group: RawProgramme[],
  globalPriority: Map<string, number>,
  fieldPriority: Record<string, string[]>,
  stats: MergeStats,
): MergedProgramme {
  const byGlobal = [...group].sort(
    (a, b) => (globalPriority.get(a.sourceId) ?? 99) - (globalPriority.get(b.sourceId) ?? 99),
  );

  /** Ordena el grupo según la prioridad declarada para un campo. */
  const orderFor = (field: string): RawProgramme[] => {
    const order = fieldPriority[field];
    if (!order?.length) return byGlobal;
    return [...group].sort((a, b) => {
      const ia = order.indexOf(a.sourceId);
      const ib = order.indexOf(b.sourceId);
      // Fuentes no listadas van al final, ordenadas por prioridad global.
      const ra = ia === -1 ? 1000 + (globalPriority.get(a.sourceId) ?? 99) : ia;
      const rb = ib === -1 ? 1000 + (globalPriority.get(b.sourceId) ?? 99) : ib;
      return ra - rb;
    });
  };

  const provenance: Provenance = {};

  /** Primer valor presente para un campo, anotando su procedencia. */
  function pick<K extends keyof MergedProgrammeFields>(
    field: K,
    extract: (p: RawProgramme) => MergedProgrammeFields[K] | undefined,
  ): MergedProgrammeFields[K] | undefined {
    for (const p of orderFor(field as string)) {
      const value = extract(p);
      if (!isPresent(value)) continue;
      provenance[field] = p.sourceId;
      // Cuenta como enriquecimiento si el dato lo aportó una fuente distinta
      // de la que ancla el horario.
      if (p.sourceId !== byGlobal[0]!.sourceId) {
        stats.enrichedFields[field as string] = (stats.enrichedFields[field as string] ?? 0) + 1;
      }
      return value;
    }
    return undefined;
  }

  const title = pick('title', (p) => p.title) ?? byGlobal[0]!.title;
  const desc = pick('desc', (p) => p.desc);
  const subTitle = pick('subTitle', (p) => p.subTitle);
  const rating = pick('rating', (p) => p.rating);
  const episode = pick('episode', (p) => p.episode as EpisodeRef | undefined);
  const seriesId = pick('seriesId', (p) => p.seriesId);

  // Categorías: unión de todas las fuentes, sin duplicados. Cada operador
  // clasifica distinto y sumarlas da una guía más navegable.
  const categories = mergeCategories(orderFor('categories'), provenance, stats, byGlobal[0]!.sourceId);

  // Elenco: se toma el bloque completo de la fuente de mayor prioridad que lo
  // tenga. Mezclar repartos parciales de fuentes distintas produce listas
  // incoherentes y con duplicados por diferencias de tildes.
  const credits = pick('credits', (p) => p.credits as Credits | undefined);

  // Imágenes: aquí no manda la prioridad sino la resolución. Se conserva la
  // mejor de cada tipo, así el póster de DirecTV y el frame 1920x1080 de
  // Movistar conviven en el mismo registro.
  const images = mergeImages(group, provenance, stats, byGlobal[0]!.sourceId);

  const externalIds: Record<string, string> = {};
  for (const p of byGlobal) Object.assign(externalIds, p.externalIds);

  // El horario lo fija la fuente de mayor prioridad que aporte el título.
  const anchor = orderFor('title').find((p) => isPresent(p.title)) ?? byGlobal[0]!;

  return {
    channelId,
    start: anchor.start,
    stop: anchor.stop,
    title,
    subTitle,
    desc,
    categories,
    images,
    credits,
    rating,
    episode,
    seriesId,
    externalIds,
    provenance,
    contributingSources: [...new Set(group.map((p) => p.sourceId))],
  };
}

function mergeCategories(
  ordered: RawProgramme[],
  provenance: Provenance,
  stats: MergeStats,
  anchorSource: string,
): string[] {
  const seen = new Map<string, string>();
  for (const p of ordered) {
    for (const c of p.categories ?? []) {
      const trimmed = c.trim();
      if (!trimmed) continue;
      const k = trimmed.toLowerCase();
      if (seen.has(k)) continue;
      seen.set(k, trimmed);
      if (!provenance.categories) provenance.categories = p.sourceId;
      if (p.sourceId !== anchorSource) {
        stats.enrichedFields.categories = (stats.enrichedFields.categories ?? 0) + 1;
      }
    }
  }
  return [...seen.values()];
}

function mergeImages(
  group: RawProgramme[],
  provenance: Provenance,
  stats: MergeStats,
  anchorSource: string,
): ImageRef[] {
  // El filtro se repite aquí y en los adaptadores a propósito: la capa cruda
  // guarda lo que se ingirió antes de que existiera este descarte, y solo se
  // reescribe cuando la fuente vuelve a pasar. Filtrar en el merge limpia
  // también esa cola sin esperar a la siguiente ingesta.
  const all = group
    .flatMap((p) => (p.images ?? []).map((img) => ({ img, sourceId: p.sourceId })))
    .filter((e) => !isFallbackImage(e.img?.url));
  if (!all.length) return [];

  const out: ImageRef[] = [];
  const kinds: ImageRef['kind'][] = ['poster', 'videoFrame', 'banner', 'logo'];

  for (const kind of kinds) {
    const pool = all.filter((e) => e.img.kind === kind);
    if (!pool.length) continue;
    const best = largestImage(pool.map((e) => e.img), kind);
    if (!best) continue;
    const owner = pool.find((e) => e.img.url === best.url);
    out.push(best);
    if (!provenance.images) provenance.images = owner?.sourceId;
    if (owner && owner.sourceId !== anchorSource) {
      stats.enrichedFields.images = (stats.enrichedFields.images ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Reparte los programas crudos por canal unificado, descartando los que
 * pertenecen a canales sin vincular.
 */
export function groupByChannel(
  programmes: RawProgramme[],
  linkIndex: Map<string, number>,
): MergeInput[] {
  const byChannel = new Map<number, RawProgramme[]>();
  for (const p of programmes) {
    const channelId = linkIndex.get(`${p.sourceId}::${p.sourceChannelId}`);
    if (channelId === undefined) continue;
    const arr = byChannel.get(channelId) ?? [];
    arr.push(p);
    byChannel.set(channelId, arr);
  }
  return [...byChannel.entries()].map(([channelId, list]) => ({ channelId, programmes: list }));
}
