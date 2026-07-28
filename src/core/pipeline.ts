import { DateTime } from 'luxon';
import { loadConfig } from './config.ts';
import { matchChannels, type MatchReport } from './channel-match.ts';
import { groupByChannel, mergeProgrammes, type MergeStats } from './programme-merge.ts';
import { createSource, enabledSources } from '../sources/index.ts';
import {
  getChannelLinkIndex,
  getRawChannels,
  getRawProgrammesInWindow,
  markSourceRun,
  purgeOldProgrammes,
  replaceChannels,
  replaceMergedProgrammes,
  saveRawChannels,
  saveRawProgrammes,
} from '../db/repo.ts';
import type { FetchRange, RawChannel } from './types.ts';

/**
 * Orquestación: ingesta -> unificación de canales -> merge.
 *
 * Cada etapa es independiente y re-ejecutable. Si una fuente cae, se conservan
 * sus últimos datos buenos en la capa cruda y el merge sigue con las demás:
 * la guía nunca se degrada por una caída puntual.
 */

export function defaultRange(): FetchRange {
  const cfg = loadConfig();
  const zone = cfg.app.timezone;
  const now = DateTime.now().setZone(zone);
  return {
    from: now.startOf('day').toMillis(),
    to: now.plus({ days: cfg.app.daysAhead }).endOf('day').toMillis(),
  };
}

export interface IngestResult {
  sourceId: string;
  ok: boolean;
  channels: number;
  programmes: number;
  error?: string;
  durationMs: number;
}

/** Ingesta de una fuente hacia la capa cruda. */
export async function ingestSource(sourceId: string, range = defaultRange()): Promise<IngestResult> {
  const started = Date.now();
  try {
    const source = createSource(sourceId);
    const channels = await source.fetchChannels();
    if (channels.length) await saveRawChannels(sourceId, channels);

    const programmes = await source.fetchProgrammes(range, channels);
    if (programmes.length) await saveRawProgrammes(sourceId, programmes);

    await markSourceRun(sourceId, 'ok');
    return {
      sourceId,
      ok: true,
      channels: channels.length,
      programmes: programmes.length,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markSourceRun(sourceId, 'error', message);
    return {
      sourceId,
      ok: false,
      channels: 0,
      programmes: 0,
      error: message,
      durationMs: Date.now() - started,
    };
  }
}

/** Ingesta de todas las fuentes habilitadas. Un fallo no detiene al resto. */
export async function ingestAll(range = defaultRange()): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const source of enabledSources()) {
    results.push(await ingestSource(source.id, range));
  }
  return results;
}

/** Recalcula la unificación de canales a partir de la capa cruda. */
export async function rebuildChannels(): Promise<MatchReport> {
  const bySource = new Map<string, RawChannel[]>();
  for (const source of enabledSources()) {
    bySource.set(source.id, await getRawChannels(source.id));
  }
  const report = matchChannels(bySource);
  await replaceChannels(report.channels);
  return report;
}

/** Recalcula los programas fusionados para una ventana. */
export async function rebuildMerge(range = defaultRange()): Promise<MergeStats> {
  const raw = await getRawProgrammesInWindow(range.from, range.to);
  const linkIndex = await getChannelLinkIndex();
  const inputs = groupByChannel(raw, linkIndex);
  const { programmes, stats } = mergeProgrammes(inputs);
  await replaceMergedProgrammes(range.from, range.to, programmes);
  return stats;
}

export interface RefreshResult {
  ingest: IngestResult[];
  channels: MatchReport['stats'];
  merge: MergeStats;
  purged: number;
}

/** Ciclo completo: ingesta, unificación, merge y purga de lo viejo. */
export async function refreshAll(range = defaultRange()): Promise<RefreshResult> {
  const cfg = loadConfig();
  const ingest = await ingestAll(range);
  const channels = (await rebuildChannels()).stats;
  const merge = await rebuildMerge(range);
  const cutoff = DateTime.now()
    .setZone(cfg.app.timezone)
    .minus({ days: cfg.app.daysBehind })
    .startOf('day')
    .toMillis();
  const purged = await purgeOldProgrammes(cutoff);
  return { ingest, channels, merge, purged };
}
