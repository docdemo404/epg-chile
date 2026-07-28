import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import YAML from 'yaml';
import { CONFIG_DIR, ROOT, loadConfig } from '../core/config.ts';
import { defaultRange } from '../core/pipeline.ts';
import { generateExport, type ExportFormat } from '../export/index.ts';
import { getChannels, getCoverageStats, countProgrammesByChannel, getSourceStatuses } from '../db/repo.ts';

/**
 * Genera el sitio estático que se publica en GitHub Pages.
 *
 * En el despliegue estático no hay servidor: los enlaces permanentes son
 * archivos reales servidos por el CDN, y el panel funciona en modo lectura
 * sobre `channels.json`.
 *
 *   npm run build:site -- --out=dist-site
 */

const here = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(here, '..', 'panel');

interface ProfileDef {
  name: string;
  slug: string;
  all?: boolean;
  formats?: ExportFormat[];
  match?: { xmltvId?: string[]; namePattern?: string[] };
}

interface SiteConfig {
  site?: { title?: string; formats?: ExportFormat[] };
  profiles: ProfileDef[];
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const outDir = join(ROOT, arg('out') ?? 'dist-site');
const siteCfg = YAML.parse(readFileSync(join(CONFIG_DIR, 'profiles.yaml'), 'utf8')) as SiteConfig;
const cfg = loadConfig();
const defaultFormats: ExportFormat[] = siteCfg.site?.formats ?? ['xml', 'xml.gz'];

const channels = await getChannels();
const range = defaultRange();
const counts = await countProgrammesByChannel(range.from, range.to);
const coverage = await getCoverageStats(range.from, range.to);

/** Resuelve qué canales entran en un perfil. */
function resolveChannels(profile: ProfileDef): number[] {
  if (profile.all) return channels.map((c) => c.id);

  const wantedIds = new Set(profile.match?.xmltvId ?? []);
  const patterns = (profile.match?.namePattern ?? []).map((p) => new RegExp(p, 'i'));

  return channels
    .filter((c) => {
      if (wantedIds.has(c.xmltvId)) return true;
      return patterns.some((re) => re.test(c.canonicalName) || c.altNames.some((a) => re.test(a)));
    })
    .map((c) => c.id);
}

console.log(`Generando sitio en ${outDir}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'epg'), { recursive: true });

// --- Enlaces permanentes: un archivo por perfil y formato.
const published: {
  name: string;
  slug: string;
  channels: number;
  files: { format: string; path: string; bytes: number }[];
}[] = [];

for (const profile of siteCfg.profiles) {
  const ids = resolveChannels(profile);
  if (!ids.length) {
    // Un perfil vacío generaría una guía vacía sin avisar; mejor decirlo.
    console.warn(`  ! "${profile.name}" no casó con ningún canal, se omite`);
    continue;
  }

  const formats = profile.formats ?? defaultFormats;
  const files: { format: string; path: string; bytes: number }[] = [];

  for (const format of formats) {
    const result = await generateExport(format, { channelIds: ids });
    const rel = `epg/${profile.slug}.${format}`;
    writeFileSync(join(outDir, rel), result.body);
    files.push({ format, path: rel, bytes: result.body.length });
  }

  published.push({ name: profile.name, slug: profile.slug, channels: ids.length, files });
  const sizes = files.map((f) => `${f.format} ${(f.bytes / 1024).toFixed(0)}KB`).join(', ');
  console.log(`  ${profile.name.padEnd(18)} ${String(ids.length).padStart(4)} canales  ${sizes}`);
}

// --- Datos que consume el panel estático.
const channelsJson = {
  generatedAt: new Date().toISOString(),
  timezone: cfg.app.timezone,
  window: { from: range.from, to: range.to },
  stats: {
    channels: channels.length,
    multiSourceChannels: channels.filter((c) => c.sources.length > 1).length,
    programmes: coverage.total,
    coverage: {
      desc: pct(coverage.withDesc),
      image: pct(coverage.withImage),
      credits: pct(coverage.withCredits),
      category: pct(coverage.withCategory),
      episode: pct(coverage.withEpisode),
    },
  },
  sources: (await getSourceStatuses())
    .filter((s) => s.enabled === 1)
    .map((s) => ({
      id: s.id,
      enabled: true,
      priority: s.priority,
      channels: s.channel_count,
      programmes: s.programme_count,
      lastOkAt: s.last_ok_at,
      status: s.last_status,
    })),
  profiles: published,
  channels: channels.map((c) => ({
    id: c.id,
    xmltvId: c.xmltvId,
    name: c.canonicalName,
    altNames: c.altNames,
    numbers: c.numbers,
    logo: c.logos[0]?.url ?? null,
    sources: c.sources,
    programmes: counts.get(c.id) ?? 0,
  })),
};

function pct(n: number): number {
  return +((n / (coverage.total || 1)) * 100).toFixed(1);
}

writeFileSync(join(outDir, 'channels.json'), JSON.stringify(channelsJson), 'utf8');

// --- Panel. El mismo código sirve local y estático: detecta si hay API.
for (const file of ['index.html', 'panel.css', 'panel.js']) {
  cpSync(join(PANEL_DIR, file), join(outDir, file));
}

// Marca que hace que el panel arranque en modo estático.
writeFileSync(join(outDir, 'static.json'), JSON.stringify({ static: true }), 'utf8');

// GitHub Pages ignora las carpetas que empiezan por guion bajo si no está esto.
writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');

const total = published.reduce((sum, p) => sum + p.files.reduce((s, f) => s + f.bytes, 0), 0);
console.log(
  `\nListo: ${published.length} perfiles, ${(total / 1024 / 1024).toFixed(1)} MB` +
    ` · guía de ${DateTime.fromMillis(range.from).setZone(cfg.app.timezone).toFormat('dd/LL')}` +
    ` a ${DateTime.fromMillis(range.to).setZone(cfg.app.timezone).toFormat('dd/LL')}`,
);
console.log(`Tamaño del sitio: ${(dirSize(outDir) / 1024 / 1024).toFixed(1)} MB`);

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirRecursive(dir)) total += statSync(entry).size;
  return total;
}

function* readdirRecursive(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* readdirRecursive(p);
    else yield p;
  }
}
