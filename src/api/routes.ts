import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { loadAliases, loadConfig, saveAliases, type AliasEntry } from '../core/config.ts';
import { slugify } from '../core/normalize.ts';
import { guideEtag } from '../core/version.ts';
import { defaultRange, rebuildChannels, rebuildMerge } from '../core/pipeline.ts';
import {
  getJobState,
  isRunning,
  puedeReconstruir,
  startRefresh,
  type JobState,
} from '../core/jobs.ts';
import { dispararIngesta } from '../core/dispatch.ts';
import { isEphemeral } from '../db/client.ts';
import { fetchFeed, isSupportedUpload, listUploads, parseBuffer } from '../sources/uploads.ts';
import { deleteFile, fileExists, safeName, storageKind, writeFile } from '../core/storage.ts';
import { generateExport, type ExportFormat } from '../export/index.ts';
import {
  addFeedUrl,
  countProgrammesByChannel,
  deleteFeedUrl,
  deleteProfile,
  getChannels,
  getCoverageStats,
  getFeedUrl,
  getGuideVersion,
  getMergedProgrammes,
  getProfileBySlug,
  getRawChannels,
  getSourceStatuses,
  listFeedUrls,
  listProfiles,
  renameProfile,
  saveProfile,
  setFeedUrlEnabled,
  updateProfileChannels,
} from '../db/repo.ts';

const FORMATS: ExportFormat[] = ['json', 'xml', 'xml.gz'];

/**
 * Paciencia al descargar una guía remota mientras alguien espera al otro lado.
 *
 * Los valores de `sources.yaml` (30 s por intento y 3 reintentos con backoff)
 * suman más de dos minutos en el peor caso, por encima de los 60 s que dura una
 * función en Vercel: una URL lenta o caída no daba un error legible, daba un
 * 504 del gateway. Con esto lo peor que puede pasar son ~25 s y un mensaje que
 * explica qué falló. La ingesta de fondo sigue usando la paciencia larga, que
 * ahí sí sobra el tiempo.
 */
const PACIENCIA_PANEL = { timeoutMs: 12_000, retries: 1 };

/**
 * Pone en marcha la reconstrucción que exige cualquier cambio en las guías
 * —alta o baja de una URL, activarla, subir o borrar un archivo— y describe
 * qué va a pasar, sin esperarla.
 *
 * No se espera porque no cabe: reingerir `uploads` vuelve a descargar cada
 * guía remota, reescribe la capa cruda y refunde la ventana entera. Son
 * minutos contra los 60 s de una función, así que hacerlo dentro de la
 * petición terminaba en 504 —y encima confundía, porque el cambio sí había
 * quedado guardado—.
 *
 * Dónde ocurre el trabajo depende de dónde corra esto (ver `puedeReconstruir`):
 * con un proceso vivo detrás, aquí mismo en segundo plano; en una función de
 * Vercel, en GitHub Actions, porque allí ni empezar es buena idea.
 */
async function incorporar(): Promise<{ job: JobState | null; note: string }> {
  if (puedeReconstruir()) {
    const enCurso = isRunning();
    return {
      job: startRefresh('uploads'),
      note: enCurso
        ? 'Ya había una actualización en curso: la guía se recalculará al terminar.'
        : 'Incorporando a la guía…',
    };
  }

  const res = await dispararIngesta();
  if (res.lanzada) {
    return {
      job: null,
      note: 'Lanzada la ingesta en GitHub Actions: la guía tarda unos minutos en reflejarlo.',
    };
  }
  if (!res.sinConfigurar) console.warn(`  ! No se pudo lanzar la ingesta: ${res.motivo}`);
  return {
    job: null,
    note:
      'Guardado. La guía lo recogerá en la próxima ingesta, o antes si lanzas a mano el ' +
      'workflow «Actualizar guía EPG» en GitHub Actions.',
  };
}

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
      // Sin base persistente la guía sale vacía tras cada arranque en frío.
      // Se avisa explícitamente para que no parezca un fallo del agregador.
      ephemeral: isEphemeral(),
      storage: storageKind(),
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

  /**
   * Edita un enlace ya publicado: cambia sus canales, su nombre, o ambos.
   *
   * El slug NO se recalcula aunque cambie el nombre. Es deliberado: la URL ya
   * está pegada en el reproductor de quien lo usa, y una edición no puede
   * romperla. Un enlace cuyo nombre y slug divergen es preferible a un enlace
   * muerto; para tener otra URL se crea otro perfil.
   */
  app.patch('/api/profiles/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as { name?: unknown; channelIds?: unknown };

    const quiereCanales = Array.isArray(body.channelIds);
    const nombre = typeof body.name === 'string' ? body.name.trim() : undefined;
    if (!quiereCanales && !nombre) {
      return reply.code(400).send({ error: 'Manda `channelIds`, `name` o ambos' });
    }

    let profile = await getProfileBySlug(slug);
    if (!profile) return reply.code(404).send({ error: 'Perfil no encontrado' });

    if (quiereCanales) {
      const ids = (body.channelIds as unknown[])
        .map(Number)
        .filter((n) => Number.isInteger(n));
      if (!ids.length) return reply.code(400).send({ error: 'Selecciona al menos un canal' });
      profile = await updateProfileChannels(slug, ids);
    }
    if (nombre) profile = await renameProfile(slug, nombre);

    return profile;
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
    let profileVersion = '';
    if (slug !== 'all') {
      const profile = await getProfileBySlug(slug);
      if (!profile) return reply.code(404).send({ error: `No existe el perfil "${slug}"` });
      channelIds = profile.channelIds;
      // Entra en el ETag: sin esto, editar los canales de un enlace no
      // invalidaría nada y el reproductor seguiría recibiendo la lista vieja.
      profileVersion = `.${profile.updatedAt}`;
    }

    /*
     * Caché en el CDN, que es de donde sale casi toda la velocidad.
     *
     * Antes se mandaba `public, max-age=900`, que solo habla con el navegador:
     * el CDN de Vercel obedece `s-maxage`, así que cada petición llegaba a la
     * función y pagaba los ~7 s de materializar el XMLTV. `X-Vercel-Cache` era
     * MISS siempre.
     *
     * `stale-while-revalidate` es lo que quita el pico: pasados los 15 min el
     * CDN entrega igual la copia vieja al instante y refresca por detrás, así
     * que nadie vuelve a esperar la generación. A cambio, un cliente puede ver
     * una guía hasta unos minutos vieja; para una parrilla que se reconstruye
     * cada 6 horas y cubre varios días, es intrascendente.
     */
    /*
     * Dos políticas, porque los dos casos no se parecen.
     *
     * `all` es la guía entera: 2,5 MB comprimidos que cuestan ~7 s de
     * generar y que solo cambian con una ingesta, cada 6 h. Se cachea holgado
     * y con `stale-while-revalidate`, que es lo que evita que nadie vuelva a
     * esperar esos 7 s.
     *
     * Un perfil es un subconjunto pequeño, barato de generar, y lo edita una
     * persona que quiere ver el resultado. Aquí `stale-while-revalidate`
     * estorba: haría que la primera petición tras vencer el plazo siguiera
     * devolviendo la lista vieja. Sin él, pasados 60 s se regenera y el cambio
     * aparece. El coste es despreciable y a cambio editar un enlace se
     * comporta como uno espera.
     */
    const esGuiaCompleta = slug === 'all';
    reply.header(
      'Cache-Control',
      esGuiaCompleta
        ? 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400'
        : 'public, max-age=30, s-maxage=60',
    );

    // ETag antes de generar nada: los reproductores consultan el enlace cada
    // pocos minutos y casi siempre la guía no ha cambiado. Contestar 304 evita
    // el export entero y manda cero bytes de cuerpo.
    //
    // Lleva la versión del código además de la de los datos: un despliegue
    // puede cambiar lo que se emite sin que haya nueva fusión, y sin esto el
    // 304 dejaba a todos los clientes con la copia anterior. Ver `version.ts`.
    const etag = guideEtag({
      slug,
      format,
      guideVersion: await getGuideVersion(),
      profileVersion,
    });
    reply.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();

    const result = await generateExport(format as ExportFormat, { channelIds });
    return reply.header('Content-Type', result.contentType).send(result.body);
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
    if (!puedeReconstruir()) {
      const res = await dispararIngesta();
      if (res.lanzada) {
        return reply
          .code(202)
          .send({ dispatched: true, note: 'Lanzada la ingesta en GitHub Actions.' });
      }
      return reply.code(503).send({
        error:
          'La ingesta no cabe en una función de Vercel; la hace GitHub Actions. ' +
          'Lanza el workflow «Actualizar guía EPG» desde GitHub.',
      });
    }
    if (isRunning()) {
      return reply.code(409).send({ error: 'Ya hay un refresco en curso', job: getJobState() });
    }
    return reply.code(202).send(startRefresh(body.source));
  });

  app.get('/api/refresh/status', async () => getJobState() ?? { running: false, steps: [] });

  /*
   * Recalcular sin descargar. Mismo techo que el refresco: refundir la ventana
   * reescribe ~100.000 filas y no cabe en los 60 s de una función, así que allí
   * se deriva a Actions en vez de dejar la guía a medio reconstruir.
   */
  app.post('/api/rebuild', async (_req, reply) => {
    if (!puedeReconstruir()) {
      const res = await dispararIngesta();
      if (res.lanzada) {
        return reply
          .code(202)
          .send({ dispatched: true, note: 'Lanzada la ingesta en GitHub Actions.' });
      }
      return reply.code(503).send({
        error:
          'Recalcular no cabe en una función de Vercel. Lanza el workflow ' +
          '«Actualizar guía EPG» desde GitHub Actions.',
      });
    }
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

    return reply.code(202).send({ upload: info, ...(await incorporar()) });
  });

  app.delete('/api/uploads/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const safe = safeName(name);
    if (!(await fileExists(safe))) return reply.code(404).send({ error: 'No existe ese archivo' });
    await deleteFile(safe);
    return reply.code(202).send({ deleted: safe, ...(await incorporar()) });
  });

  // -------------------------------------------------------- guías por URL
  app.get('/api/feeds', async () => await listFeedUrls());

  /**
   * Da de alta una guía remota por URL.
   *
   * A diferencia de un archivo subido, la URL se vuelve a descargar en cada
   * ingesta: sirve para guías de terceros que se actualizan solas. Se descarga
   * y valida ANTES de guardarla, por el mismo motivo que con los archivos —una
   * URL que no sirve no debe quedar dada de alta— y además se comprueba que no
   * apunte a una dirección interna.
   */
  app.post('/api/feeds', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: unknown; label?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) return reply.code(400).send({ error: 'Falta la URL' });

    const label =
      typeof body.label === 'string' && body.label.trim()
        ? body.label.trim()
        : // Sin nombre, se usa el del archivo remoto; si tampoco, el dominio.
          (() => {
            try {
              const u = new URL(url);
              return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '') || u.hostname;
            } catch {
              return url;
            }
          })();

    let parsed;
    try {
      parsed = await fetchFeed(url, label, PACIENCIA_PANEL);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    // El alta se persiste ANTES de tocar la guía: un corte entre una cosa y la
    // otra debe dejar la URL registrada y la guía intacta, nunca al revés.
    const feed = await addFeedUrl(url, label, {
      channels: parsed.channels.length,
      programmes: parsed.programmes.length,
    });

    return reply.code(202).send({ feed, ...(await incorporar()) });
  });

  app.delete('/api/feeds/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Id inválido' });
    if (!(await deleteFeedUrl(id))) return reply.code(404).send({ error: 'No existe esa guía' });
    return reply.code(202).send({ deleted: id, ...(await incorporar()) });
  });

  /** Activa o desactiva una guía sin perder la URL ni su historial. */
  app.patch('/api/feeds/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Id inválido' });
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'Falta `enabled` (true o false)' });
    }
    if (!(await setFeedUrlEnabled(id, enabled))) {
      return reply.code(404).send({ error: 'No existe esa guía' });
    }
    return reply.code(202).send({ feed: await getFeedUrl(id), ...(await incorporar()) });
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
