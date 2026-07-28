import { loadAliases, loadConfig } from './config.ts';
import {
  channelMatchKey,
  diceCoefficient,
  isFallbackImage,
  normalizeChannelName,
  slugify,
} from './normalize.ts';
import type { ImageRef, RawChannel } from './types.ts';

/**
 * Unificación de canales entre fuentes.
 *
 * El problema real: `TVN` (DirecTV #149) = `TELEVISION NACIONAL` (Movistar
 * LCH...) = `tvn` (mi.tv). Las numeraciones de operadores NO coinciden, así
 * que nunca se empareja por número de canal — solo por nombre y por alias.
 *
 * Cascada: alias manual > nombre normalizado idéntico > similitud difusa por
 * encima del umbral. Lo que no llega al umbral queda sin vincular y visible
 * en el panel, en vez de fusionarse mal en silencio.
 */

export interface ChannelLink {
  sourceId: string;
  sourceChannelId: string;
  number?: number;
  confidence: number;
  manual: boolean;
}

export interface UnifiedChannel {
  xmltvId: string;
  canonicalName: string;
  altNames: string[];
  logos: ImageRef[];
  links: ChannelLink[];
}

export interface MatchReport {
  channels: UnifiedChannel[];
  /** Canales cubiertos por una sola fuente: candidatos a alias manual. */
  unlinked: { sourceId: string; sourceChannelId: string; name: string; number?: number }[];
  stats: {
    total: number;
    multiSource: number;
    singleSource: number;
    manual: number;
    bySource: Record<string, number>;
  };
}

function key(sourceId: string, sourceChannelId: string): string {
  return `${sourceId}::${sourceChannelId}`;
}

/**
 * Agrupa los canales crudos de todas las fuentes en canales unificados.
 */
export function matchChannels(rawBySource: Map<string, RawChannel[]>): MatchReport {
  const cfg = loadConfig();
  const aliases = loadAliases();
  const threshold = cfg.matching.channelNameThreshold;

  const all: RawChannel[] = [];
  for (const list of rawBySource.values()) all.push(...list);

  // Canales excluidos explícitamente (barkers, canales de servicio).
  const ignored = new Set<string>();
  for (const [sourceId, ids] of Object.entries(aliases.ignore?.sources ?? {})) {
    for (const id of ids) ignored.add(key(sourceId, String(id)));
  }

  const byKey = new Map<string, RawChannel>();
  for (const c of all) {
    if (ignored.has(key(c.sourceId, c.sourceChannelId))) continue;
    byKey.set(key(c.sourceId, c.sourceChannelId), c);
  }

  const claimed = new Set<string>();
  let groups: UnifiedChannel[] = [];

  // Índice por fuente y nombre normalizado, para localizar señales gemelas.
  const twinIndex = new Map<string, RawChannel[]>();
  for (const raw of byKey.values()) {
    const tk = `${raw.sourceId}::${normalizeChannelName(raw.fullName || raw.name)}`;
    const arr = twinIndex.get(tk) ?? [];
    arr.push(raw);
    twinIndex.set(tk, arr);
  }

  // --- 1. Alias manuales: prioridad absoluta, nunca los pisa el automático.
  for (const alias of aliases.channels) {
    const links: ChannelLink[] = [];
    const logos: ImageRef[] = [];
    const altNames: string[] = [];

    const take = (raw: RawChannel, manual: boolean): void => {
      const k = key(raw.sourceId, raw.sourceChannelId);
      if (claimed.has(k)) return;
      claimed.add(k);
      links.push({
        sourceId: raw.sourceId,
        sourceChannelId: raw.sourceChannelId,
        number: raw.number,
        confidence: 1,
        manual,
      });
      logos.push(...raw.logos);
      altNames.push(raw.name);
      if (raw.fullName) altNames.push(raw.fullName);
    };

    for (const [sourceId, ids] of Object.entries(alias.match ?? {})) {
      for (const id of ids) {
        const raw = byKey.get(key(sourceId, String(id)));
        if (!raw) continue;
        take(raw, true);

        // Los operadores publican la misma señal en SD y HD como entradas
        // distintas con nombre idéntico (Movistar tiene dos "CANAL 13 SPA":
        // LCH482 y LCH603). Nombrar una en el alias debe arrastrar a sus
        // gemelas, o la otra queda suelta y el canal sale duplicado en la
        // guía. Solo se absorbe con nombre normalizado idéntico, así que
        // "ESPN" nunca se traga a "ESPN 2".
        const twinKey = `${sourceId}::${normalizeChannelName(raw.fullName || raw.name)}`;
        for (const twin of twinIndex.get(twinKey) ?? []) take(twin, false);
      }
    }
    if (!links.length) continue;
    groups.push({
      xmltvId: alias.xmltvId || `${slugify(alias.canonical)}.cl`,
      canonicalName: alias.canonical,
      altNames: dedupe(altNames.filter((n) => n !== alias.canonical)),
      logos: dedupeLogos(logos),
      links,
    });
  }

  // --- 2. Nombre normalizado idéntico.
  const byNormalized = new Map<string, RawChannel[]>();
  for (const [k, raw] of byKey) {
    if (claimed.has(k)) continue;
    const norm = normalizeChannelName(raw.fullName || raw.name);
    if (!norm) continue;
    const arr = byNormalized.get(norm) ?? [];
    arr.push(raw);
    byNormalized.set(norm, arr);
  }

  // Se procesan los grupos más poblados primero: fijan primero los casos
  // inequívocos y dejan menos margen a un emparejado difuso dudoso.
  const normEntries = [...byNormalized.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [norm, members] of normEntries) {
    const fresh = members.filter((m) => !claimed.has(key(m.sourceId, m.sourceChannelId)));
    if (!fresh.length) continue;
    for (const m of fresh) claimed.add(key(m.sourceId, m.sourceChannelId));
    groups.push(buildGroup(norm, fresh, 1));
  }

  // --- 3. Clave compacta: une los que solo difieren en separadores o en el
  // "TV" decorativo.
  //
  // "13_Rec"/"13rec" y "Etc"/"Etc TV HD" son el mismo canal, pero normalizados
  // quedan como "13 REC"/"13REC" y "ETC"/"ETC TV", y la similitud difusa se
  // queda en 0,67 en ambos casos. Comparar por clave compacta los une con
  // precisión, sin bajar el umbral general —que sí produciría falsos
  // positivos entre canales de verdad distintos.
  const byCompact = new Map<string, UnifiedChannel[]>();
  for (const g of groups) {
    const compact = channelMatchKey(g.canonicalName);
    if (!compact) continue;
    const arr = byCompact.get(compact) ?? [];
    arr.push(g);
    byCompact.set(compact, arr);
  }

  const absorbed = new Set<UnifiedChannel>();
  for (const peers of byCompact.values()) {
    if (peers.length < 2) continue;
    const [head, ...rest] = peers as [UnifiedChannel, ...UnifiedChannel[]];
    const headSources = new Set(head.links.map((l) => l.sourceId));
    for (const other of rest) {
      const otherSources = new Set(other.links.map((l) => l.sourceId));
      // Dos canales de la misma fuente con igual nombre compacto son señales
      // distintas que esa fuente ya separó; no se tocan.
      if ([...otherSources].some((s) => headSources.has(s))) continue;
      head.links.push(...other.links);
      head.altNames = dedupe([...head.altNames, other.canonicalName, ...other.altNames]);
      head.logos = dedupeLogos([...head.logos, ...other.logos]);
      for (const s of otherSources) headSources.add(s);
      absorbed.add(other);
    }
  }
  groups = groups.filter((g) => !absorbed.has(g));

  // --- 4. Similitud difusa entre grupos que quedaron de una sola fuente.
  //
  // Solo se intenta fusionar grupos que no comparten fuente: dos canales de la
  // misma fuente con nombres parecidos ("ESPN" / "ESPN 2") son distintos de
  // verdad, y fusionarlos sería un error.
  const fuzzyCandidates = groups.filter((g) => new Set(g.links.map((l) => l.sourceId)).size === 1);
  const merged = new Set<UnifiedChannel>();

  for (let i = 0; i < fuzzyCandidates.length; i++) {
    const a = fuzzyCandidates[i]!;
    if (merged.has(a)) continue;
    const aSources = new Set(a.links.map((l) => l.sourceId));
    const aNorm = normalizeChannelName(a.canonicalName);

    for (let j = i + 1; j < fuzzyCandidates.length; j++) {
      const b = fuzzyCandidates[j]!;
      if (merged.has(b)) continue;
      const bSources = new Set(b.links.map((l) => l.sourceId));
      if ([...bSources].some((s) => aSources.has(s))) continue;

      const score = diceCoefficient(aNorm, normalizeChannelName(b.canonicalName));
      if (score < threshold) continue;

      a.links.push(...b.links.map((l) => ({ ...l, confidence: score })));
      a.altNames = dedupe([...a.altNames, b.canonicalName, ...b.altNames]);
      a.logos = dedupeLogos([...a.logos, ...b.logos]);
      for (const s of bSources) aSources.add(s);
      merged.add(b);
    }
  }

  const finalGroups = groups.filter((g) => !merged.has(g));

  // xmltvId único y estable.
  const usedIds = new Set<string>();
  for (const g of finalGroups) {
    let id = g.xmltvId || `${slugify(g.canonicalName)}.cl`;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id.replace(/\.cl$/, '')}-${n}.cl`)) n++;
      id = `${id.replace(/\.cl$/, '')}-${n}.cl`;
    }
    usedIds.add(id);
    g.xmltvId = id;
  }

  finalGroups.sort((a, b) => {
    const na = minNumber(a);
    const nb = minNumber(b);
    if (na !== nb) return na - nb;
    return a.canonicalName.localeCompare(b.canonicalName, 'es');
  });

  const unlinked = finalGroups
    .filter((g) => new Set(g.links.map((l) => l.sourceId)).size === 1)
    .flatMap((g) =>
      g.links.map((l) => ({
        sourceId: l.sourceId,
        sourceChannelId: l.sourceChannelId,
        name: g.canonicalName,
        number: l.number,
      })),
    );

  const bySource: Record<string, number> = {};
  for (const g of finalGroups) {
    for (const s of new Set(g.links.map((l) => l.sourceId))) {
      bySource[s] = (bySource[s] ?? 0) + 1;
    }
  }

  return {
    channels: finalGroups,
    unlinked,
    stats: {
      total: finalGroups.length,
      multiSource: finalGroups.filter((g) => new Set(g.links.map((l) => l.sourceId)).size > 1).length,
      singleSource: finalGroups.filter((g) => new Set(g.links.map((l) => l.sourceId)).size === 1).length,
      manual: finalGroups.filter((g) => g.links.some((l) => l.manual)).length,
      bySource,
    },
  };
}

function minNumber(g: UnifiedChannel): number {
  const nums = g.links.map((l) => l.number).filter((n): n is number => typeof n === 'number');
  return nums.length ? Math.min(...nums) : Number.MAX_SAFE_INTEGER;
}

function buildGroup(normalized: string, members: RawChannel[], confidence: number): UnifiedChannel {
  // El nombre visible sale de la fuente de mayor prioridad, prefiriendo la
  // versión larga cuando existe: "TELEVISION NACIONAL" lee mejor que "TVN".
  const cfg = loadConfig();
  const priorityOf = (id: string): number =>
    cfg.sources.find((s) => s.id === id)?.priority ?? 99;

  const sorted = [...members].sort((a, b) => priorityOf(a.sourceId) - priorityOf(b.sourceId));
  const best = sorted[0]!;
  const canonicalName = displayName(best.fullName || best.name);

  const altNames = dedupe(
    members.flatMap((m) => [m.name, m.fullName]).filter((n): n is string => Boolean(n) && n !== canonicalName),
  );

  return {
    xmltvId: `${slugify(normalized)}.cl`,
    canonicalName,
    altNames,
    logos: dedupeLogos(members.flatMap((m) => m.logos)),
    links: members.map((m) => ({
      sourceId: m.sourceId,
      sourceChannelId: m.sourceChannelId,
      number: m.number,
      confidence,
      manual: false,
    })),
  };
}

/**
 * Nombre visible del canal.
 *
 * Se quita el sufijo de calidad: el canal unificado agrupa la señal SD y la
 * HD, así que anunciarlo como "Etc TV HD" describe mal lo que contiene. Los
 * nombres en MAYÚSCULAS de los operadores además se ven mal en una guía.
 */
function displayName(raw: string): string {
  const name = raw.replace(/\s*\b(HD|SD|FHD|UHD|4K|HDTV)\b\s*$/i, '').trim() || raw.trim();
  return titleCase(name);
}

function titleCase(name: string): string {
  if (name !== name.toUpperCase()) return name.trim();
  return name
    .toLowerCase()
    .replace(/\b([a-záéíóúñ])/g, (c) => c.toUpperCase())
    .replace(/\b(Hd|Sd|Tv|Hbo|Cnn|Espn|Tnt|Axn|Amc|Fx|Mtv|Dw)\b/g, (m) => m.toUpperCase())
    .trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function dedupeLogos(logos: ImageRef[]): ImageRef[] {
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (const l of logos) {
    if (!l?.url || seen.has(l.url) || isFallbackImage(l.url)) continue;
    seen.add(l.url);
    out.push(l);
  }
  return out;
}
