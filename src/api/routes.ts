import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { loadAliases, loadConfig, saveAliases, type AliasEntry } from '../core/config.ts';
import { slugify } from '../core/normalize.ts';
import { defaultRange, ingestSource, rebuildChannels, rebuildMerge } from '../core/pipeline.ts';
import { getJobState, isRunning, startRefresh } from '../core/jobs.ts';
import { isSupportedUpload, listUploads, parseBuffer } from '../sources/uploads.ts';
import { deleteFile, fileExists, safeName, writeFile } from '../core/storage.ts';
import { generateExport, type ExportFormat } from '../export/index.ts';
import {
  countProgrammesByChannel,
  deleteProfile,
  getChannels,
  getCoverageStats,
  getMergedProgrammes,
  getProfileBySlug,
  getRawChannels,
  getSourceStatuses,
  listProfiles,
  saveProfile,
} from '../db/repo.ts';

const FORMATS: ExportFormat[] = ['json', 'xml', 'xml.gz'];

function parseTime(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !value) return fallback;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== '') return asNumber;
  const dt = DateTime.fromISO(value);
  return dt.isValid ? dt.toMillis() : fallback;
}

export function registerApiRoutes(app: FastifyInstance): void {
  const cfg = loadConfig();

  // La guía cambia con cada ingesta. Sin esto el navegador reutiliza la
  // respuesta anterior y el panel sigue mostrando canales ya fusionados como
  // si estuvieran sueltos, que parece un fallo del emparejado sin serlo.
  // Los enlaces permanentes de /epg sí se cachean: van aparte.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, must-revalidate');
    }
    return payload;
  });

  // ---------------------------------------------------------------- estado
  app.get('/api/sources', async () => {
    const configured = new Map(cfg.sources.map((s) => [s.id, s]));
    return (await getSourceStatuses()).map((s) => ({
      id: s.id,
      enabled: s.enabled === 1,
      priority: s.priority,
      channels: s.channel_count,
      programmes: s.programme_count,
      lastRunAt: s.last_run_at,
      lastOkAt: s.last_ok_at,
      status: s.last_status,
      error: s.last_error,
      refreshCron: configured.get(s.id)?.refreshCron ?? null,
    }));
  });

  app.get('/api/stats', async () => {
    const channels = await getChannels();
    const range = defaultRange();
    const cov = await getCoverageStats(range.from, range.to);
    const total = cov.total || 1;
    const pct = (n: number): number => +((n / total) * 100).toFixed(1);
    return {
      channels: channels.length,
      multiSourceChannels: channels.filter((c) => c.sources.length > 1).length,
      programmes: cov.total,
      coverage: {
        desc: pct(cov.withDesc),
        image: pct(cov.withImage),
        credits: pct(cov.withCredits),
        category: pct(cov.withCategory),
        episode: pct(cov.withEpisode),
      },
      window: { from: range.from, to: range.to },
      timezone: cfg.app.timezone,
    };
  });

  // -------------------------------------------------------------- canales
  app.get('/api/channels', async () => {
    const channels = await getChannels();
    // Cuántas emisiones tiene cada canal en la ventana: el panel lo usa para
    // avisar de canales vinculados pero sin programación real.
    const range = defaultRange();
    const counts = await countProgrammesByChannel(range.from, range.to);
    return channels.map((c) => ({
      id: c.id,
      xmltvId: c.xmltvId,
      name: c.canonicalName,
      altNames: c.altNames,
      numbers: c.numbers,
      logo: c.logos[0]?.url ?? null,
      sources: c.sources,
      links: c.links,
      programmes: counts.get(c.id) ?? 0,
    }));
  });

  /** Canales crudos por fuente, para resolver vínculos a mano en el panel. */
  app.get('/api/raw-channels', async (req) => {
    const { source } = req.query as { source?: string };
    return (await getRawChannels(source)).map((c) => ({
      sourceId: c.sourceId,
      sourceChannelId: c.sourceChannelId,
      name: c.name,
      number: c.number ?? null,
      logo: c.logos[0]?.url ?? null,
    }));
  });

  // ------------------------------------------------------------ programas
  app.get('/api/programmes', async (req) => {
    const q = req.query as { channel?: string; from?: string; to?: string; limit?: string };
    const range = defaultRange();
    const from = parseTime(q.from, range.from);
    const to = parseTime(q.to, range.to);
    const channelIds = q.channel
      ? q.channel.split(',').map((v) => Number(v)).filter(Number.isFinite)
      : undefined;
    const limit = Math.min(Number(q.limit) || 500, 5000);

    const programmes = (await getMergedProgrammes({ from, to, channelIds })).slice(0, limit);
    return programmes.map((p) => ({
      channelId: p.channelId,
      start: p.start,
      stop: p.stop,
      title: p.title,
      subTitle: p.subTitle,
      desc: p.desc,
      categories: p.categories,
      image: p.images[0]?.url ?? null,
      images: p.images,
      credits: p.credits,
      rating: p.rating,
      episode: p.episode,
      externalIds: p.externalIds,
      provenance: p.provenance,
      sources: p.contributingSources,
    }));
  });

  // -------------------------------------------------------------- perfiles
  app.get('/api/profiles', async () => await listProfiles());

  app.post('/api/profiles', async (req, reply) => {
    const body = req.body as { name?: string; channelIds?: number[]; options?: Record<string, unknown> };
    const name = body.name?.trim();
    if (!name) return reply.code(400).send({ error: 'Falta el nombre del perfil' });
    const ids = (body.channelIds ?? []).filter((n) => Number.isFinite(n));
    if (!ids.length) return reply.code(400).send({ error: 'Selecciona al menos un canal' });
    return await saveProfile(name, slugify(name), ids, body.options ?? {});
  });

  app.delete('/api/profiles/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await deleteProfile(slug))) return reply.code(404).send({ error: 'Perfil no encontrado' });
    return { deleted: true };
  });

  // ------------------------------------------------------------ exportación
  /**
   * Descarga puntual desde el panel. Los canales van por querystring, así que
   * no hace falta guardar un perfil para probar una selección.
   */
  app.get('/api/export', async (req, reply) => {
    const q = req.query as { format?: string; channels?: string; provenance?: string };
    const format = (q.format ?? 'xml') as ExportFormat;
    if (!FORMATS.includes(format)) {
      return reply.code(400).send({ error: `Formato no soportado: ${q.format}` });
    }
    const channelIds = q.channels
      ? q.channels.split(',').map((v) => Number(v)).filter(Number.isFinite)
      : undefined;

    const result = await generateExport(format, {
      channelIds,
      includeProvenance: q.provenance === '1',
    });
    return reply
      .header('Content-Type', result.contentType)
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .send(result.body);
  });

  /**
   * URL estable por perfil, pensada para pegarla en Kodi o Tvheadend:
   *   /epg/mi-seleccion.xml.gz
   */
  app.get('/epg/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const match = file.match(/^(.+?)\.(json|xml\.gz|xml)$/);
    if (!match?.[1] || !match[2]) {
      return reply.code(400).send({ error: 'Usa /epg/{perfil}.{json|xml|xml.gz}' });
    }
    const [, slug, format] = match;

    // "all" exporta la guía completa sin necesidad de crear un perfil.
    let channelIds: number[] | undefined;
    if (slug !== 'all') {
      const profile = await getProfileBySlug(slug);
      if (!profile) return reply.code(404).send({ error: `No existe el perfil "${slug}"` });
      channelIds = profile.channelIds;
    }

    const result = await generateExport(format as ExportFormat, { channelIds });
    return reply
      .header('Content-Type', result.contentType)
      .header('Cache-Control', 'public, max-age=900')
      .send(result.body);
  });

  // ----------------------------------------------------------------- alias
  app.get('/api/aliases', async () => loadAliases());

  /**
   * Vincula a mano un canal de una fuente con un canal canónico y lo persiste
   * en channel-aliases.yaml, de modo que sobreviva a la próxima re-ingesta.
   */
  app.post('/api/aliases/link', async (req, reply) => {
    const body = req.body as {
      canonical?: string;
      xmltvId?: string;
      sourceId?: string;
      sourceChannelId?: string;
    };
    const { canonical, sourceId, sourceChannelId } = body;
    if (!canonical || !sourceId || !sourceChannelId) {
      return reply.code(400).send({ error: 'Faltan canonical, sourceId o sourceChannelId' });
    }

    const aliases = loadAliases();
    let entry = aliases.channels.find(
      (c) => c.canonical.toLowerCase() === canonical.toLowerCase(),
    );
    if (!entry) {
      entry = {
        canonical,
        xmltvId: body.xmltvId?.trim() || `${slugify(canonical)}.cl`,
        match: {},
      } satisfies AliasEntry;
      aliases.channels.push(entry);
    }
    const list = entry.match[sourceId] ?? [];
    if (!list.map(String).includes(sourceChannelId)) list.push(sourceChannelId);
    entry.match[sourceId] = list;

    saveAliases(aliases);
    // Re-unificar y re-fusionar para que el cambio se vea de inmediato.
    await rebuildChannels();
    await rebuildMerge();
    return { ok: true, entry };
  });

  // -------------------------------------------------------------- refresco
  /**
   * Dispara el refresco y responde al instante. La ingesta completa tarda
   * ~16 minutos; mantener la petición abierta la haría morir en cualquier
   * proxy y dejaba el botón del panel colgado.
   */
  app.post('/api/refresh', async (req, reply) => {
    const body = (req.body ?? {}) as { source?: string };
    if (isRunning()) {
      return reply.code(409).send({ error: 'Ya hay un refresco en curso', job: getJobState() });
    }
    return reply.code(202).send(startRefresh(body.source));
  });

  app.get('/api/refresh/status', async () => getJobState() ?? { running: false, steps: [] });

  app.post('/api/rebuild', async () => {
    const channels = await rebuildChannels();
    const merge = await rebuildMerge();
    return { channels: channels.stats, merge };
  });

  // -------------------------------------------------------------- uploads
  app.get('/api/uploads', async () => await listUploads());

  /**
   * Recibe un XMLTV (.xml/.xml.gz) o el JSON de este proyecto y lo incorpora
   * como una fuente más: participa en la unificación de canales y en la
   * fusión campo a campo igual que las automáticas.
   */
  app.post('/api/uploads', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'No llegó ningún archivo' });

    const safe = safeName(file.filename);
    if (!isSupportedUpload(safe)) {
      return reply.code(400).send({ error: 'Formato no soportado: usa .xml, .xml.gz o .json' });
    }

    const buf = await file.toBuffer();
    if (!buf.length) return reply.code(400).send({ error: 'El archivo está vacío' });

    // Se valida ANTES de guardar: así un archivo ilegible nunca llega al
    // almacenamiento ni ensucia la guía.
    let parsed;
    try {
      parsed = parseBuffer(safe, buf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `No se pudo interpretar: ${msg}` });
    }
    if (!parsed.channels.length && !parsed.programmes.length) {
      return reply.code(400).send({ error: 'El archivo no contiene canales ni programación' });
    }

    await writeFile(safe, buf);
    const info = {
      name: safe,
      bytes: buf.length,
      channels: parsed.channels.length,
      programmes: parsed.programmes.length,
    };

    await ingestSource('uploads');
    await rebuildChannels();
    const merge = await rebuildMerge();
    return { upload: info, programmes: merge.output };
  });

  app.delete('/api/uploads/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const safe = safeName(name);
    if (!(await fileExists(safe))) return reply.code(404).send({ error: 'No existe ese archivo' });
    await deleteFile(safe);
    await ingestSource('uploads');
    await rebuildChannels();
    await rebuildMerge();
    return { deleted: safe };
  });

  // ------------------------------------------------- unificación manual
  /**
   * Fusiona varios canales ya unificados en uno solo.
   *
   * Se persiste en channel-aliases.yaml, que tiene prioridad absoluta sobre
   * el emparejado automático: la corrección sobrevive a cualquier re-ingesta.
   */
  app.post('/api/channels/merge', async (req, reply) => {
    const body = req.body as { channelIds?: number[]; canonical?: string; xmltvId?: string };
    const ids = (body.channelIds ?? []).filter((n) => Number.isFinite(n));
    if (ids.length < 2) {
      return reply.code(400).send({ error: 'Selecciona al menos dos canales para unificar' });
    }

    const all = await getChannels();
    const targets = all.filter((c) => ids.includes(c.id));
    if (targets.length < 2) return reply.code(400).send({ error: 'Canales no encontrados' });

    // Por defecto se conserva el nombre y el id del canal con más fuentes:
    // suele ser el mejor identificado, y así los enlaces ya creados que
    // apuntaban a él siguen sirviendo.
    const primary = [...targets].sort(
      (a, b) => b.sources.length - a.sources.length || a.id - b.id,
    )[0]!;
    const canonical = body.canonical?.trim() || primary.canonicalName;
    const xmltvId = body.xmltvId?.trim() || primary.xmltvId;

    const aliases = loadAliases();
    // Se retiran de otras entradas los canales que ahora pertenecen a esta,
    // o quedarían reclamados por dos alias a la vez.
    const claimed = new Map<string, Set<string>>();
    for (const t of targets) {
      for (const l of t.links) {
        const set = claimed.get(l.sourceId) ?? new Set<string>();
        set.add(l.sourceChannelId);
        claimed.set(l.sourceId, set);
      }
    }
    for (const entry of aliases.channels) {
      if (entry.xmltvId === xmltvId) continue;
      for (const [sourceId, ids2] of Object.entries(entry.match ?? {})) {
        const drop = claimed.get(sourceId);
        if (!drop) continue;
        entry.match[sourceId] = ids2.filter((v) => !drop.has(String(v)));
      }
    }
    aliases.channels = aliases.channels.filter((e) =>
      Object.values(e.match ?? {}).some((v) => v.length > 0),
    );

    let entry = aliases.channels.find((c) => c.xmltvId === xmltvId);
    if (!entry) {
      entry = { canonical, xmltvId, match: {} } satisfies AliasEntry;
      aliases.channels.push(entry);
    }
    entry.canonical = canonical;
    for (const [sourceId, set] of claimed) {
      const list = new Set((entry.match[sourceId] ?? []).map(String));
      for (const v of set) list.add(v);
      entry.match[sourceId] = [...list];
    }

    saveAliases(aliases);
    const report = await rebuildChannels();
    await rebuildMerge();
    const merged = (await getChannels()).find((c) => c.xmltvId === xmltvId);
    return { ok: true, channel: merged, total: report.stats.total };
  });

  /** Deshace una unificación manual: quita la entrada de channel-aliases.yaml. */
  app.delete('/api/channels/merge/:xmltvId', async (req, reply) => {
    const { xmltvId } = req.params as { xmltvId: string };
    const aliases = loadAliases();
    const before = aliases.channels.length;
    aliases.channels = aliases.channels.filter((c) => c.xmltvId !== xmltvId);
    if (aliases.channels.length === before) {
      return reply.code(404).send({ error: 'Ese canal no tiene unificación manual' });
    }
    saveAliases(aliases);
    await rebuildChannels();
    await rebuildMerge();
    return { ok: true };
  });
}
