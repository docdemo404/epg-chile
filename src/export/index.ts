import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { EXPORT_DIR, loadConfig } from '../core/config.ts';
import { getChannels, getMergedProgrammes, type ChannelWithLinks } from '../db/repo.ts';
import type { MergedProgramme } from '../core/types.ts';
import { buildXmltv, type XmltvOptions } from './xmltv.ts';

export type ExportFormat = 'json' | 'xml' | 'xml.gz';

export interface ExportOptions extends XmltvOptions {
  /** IDs de canales unificados; vacío o ausente = todos. */
  channelIds?: number[];
  from?: number;
  to?: number;
}

export interface ExportResult {
  format: ExportFormat;
  body: Buffer;
  contentType: string;
  filename: string;
  stats: { channels: number; programmes: number };
}

/** Construye JSON con el modelo canónico completo, incluida la procedencia. */
export function buildJson(
  channels: ChannelWithLinks[],
  programmes: MergedProgramme[],
): string {
  const cfg = loadConfig();
  const byId = new Map(channels.map((c) => [c.id, c]));
  return JSON.stringify(
    {
      generator: 'api-epg-cl',
      generatedAt: new Date().toISOString(),
      timezone: cfg.app.timezone,
      channels: channels.map((c) => ({
        id: c.xmltvId,
        name: c.canonicalName,
        altNames: c.altNames,
        numbers: c.numbers,
        logos: c.logos,
        sources: c.sources,
      })),
      programmes: programmes.map((p) => {
        const ch = byId.get(p.channelId);
        return {
          channel: ch?.xmltvId ?? String(p.channelId),
          start: new Date(p.start).toISOString(),
          stop: new Date(p.stop).toISOString(),
          title: p.title,
          subTitle: p.subTitle,
          desc: p.desc,
          categories: p.categories,
          images: p.images,
          credits: p.credits,
          rating: p.rating,
          episode: p.episode,
          seriesId: p.seriesId,
          externalIds: p.externalIds,
          // De qué fuente salió cada campo: la clave para depurar la guía.
          provenance: p.provenance,
          sources: p.contributingSources,
        };
      }),
    },
    null,
    2,
  );
}

export async function generateExport(format: ExportFormat, opts: ExportOptions = {}): Promise<ExportResult> {
  const cfg = loadConfig();
  const zone = opts.timezone ?? cfg.app.timezone;

  const allChannels = await getChannels();
  // `undefined` significa "toda la guía"; una lista explícita filtra, aunque
  // quede vacía. Tratar la lista vacía como "todos" hacía que un perfil cuyos
  // canales ya no existen sirviera la guía completa en silencio.
  const wanted = opts.channelIds === undefined ? null : new Set(opts.channelIds);
  const channels = wanted ? allChannels.filter((c) => wanted.has(c.id)) : allChannels;

  const from = opts.from ?? DateTime.now().setZone(zone).minus({ days: cfg.app.daysBehind }).startOf('day').toMillis();
  const to = opts.to ?? DateTime.now().setZone(zone).plus({ days: cfg.app.daysAhead }).endOf('day').toMillis();

  const programmes = channels.length
    ? await getMergedProgrammes({ from, to, channelIds: channels.map((c) => c.id) })
    : [];

  const stats = { channels: channels.length, programmes: programmes.length };
  const stamp = DateTime.now().setZone(zone).toFormat('yyyyLLdd-HHmm');

  if (format === 'json') {
    return {
      format,
      body: Buffer.from(buildJson(channels, programmes), 'utf8'),
      contentType: 'application/json; charset=utf-8',
      filename: `epg-${stamp}.json`,
      stats,
    };
  }

  const xml = buildXmltv(channels, programmes, opts);
  if (format === 'xml') {
    return {
      format,
      body: Buffer.from(xml, 'utf8'),
      contentType: 'application/xml; charset=utf-8',
      filename: `epg-${stamp}.xml`,
      stats,
    };
  }

  return {
    format: 'xml.gz',
    body: gzipSync(Buffer.from(xml, 'utf8'), { level: 9 }),
    contentType: 'application/gzip',
    filename: `epg-${stamp}.xml.gz`,
    stats,
  };
}

/** Escribe el export a disco y devuelve la ruta. */
export async function writeExport(
  format: ExportFormat,
  opts: ExportOptions = {},
  name?: string,
): Promise<string> {
  const result = await generateExport(format, opts);
  mkdirSync(EXPORT_DIR, { recursive: true });
  const filename = name ? `${name}.${format}` : result.filename;
  const path = join(EXPORT_DIR, filename);
  writeFileSync(path, result.body);
  return path;
}

export { buildXmltv };
