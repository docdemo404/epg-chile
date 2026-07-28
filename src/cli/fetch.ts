import { DateTime } from 'luxon';
import { loadConfig } from '../core/config.ts';
import { defaultRange, ingestSource } from '../core/pipeline.ts';
import { createSource, enabledSources } from '../sources/index.ts';

/**
 * CLI de ingesta.
 *
 *   npm run fetch -- --source=movistar
 *   npm run fetch -- --source=directv --dry-run
 *   npm run fetch                       (todas las fuentes habilitadas)
 *
 * `--dry-run` consulta la fuente e imprime un resumen sin tocar la base:
 * es la forma rápida de comprobar que un adaptador sigue funcionando.
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? '' : undefined;
}

async function dryRun(sourceId: string): Promise<void> {
  const cfg = loadConfig();
  const range = defaultRange();
  const source = createSource(sourceId);

  console.log(`\n=== ${sourceId} (dry-run) ===`);
  console.log(
    `ventana: ${DateTime.fromMillis(range.from).setZone(cfg.app.timezone).toFormat('yyyy-LL-dd HH:mm ZZ')}` +
      ` -> ${DateTime.fromMillis(range.to).setZone(cfg.app.timezone).toFormat('yyyy-LL-dd HH:mm ZZ')}`,
  );

  const channels = await source.fetchChannels();
  console.log(`canales: ${channels.length}`);
  for (const c of channels.slice(0, 10)) {
    console.log(`  ${String(c.number ?? '—').padStart(5)} | ${c.sourceChannelId.padEnd(12)} | ${c.name}`);
  }
  if (channels.length > 10) console.log(`  ... y ${channels.length - 10} más`);

  const programmes = await source.fetchProgrammes(range, channels);
  console.log(`programas: ${programmes.length}`);

  // Cobertura de metadatos: el dato que decide qué aporta esta fuente al merge.
  const total = programmes.length || 1;
  const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;
  const withDesc = programmes.filter((p) => p.desc && p.desc.trim()).length;
  const withImage = programmes.filter((p) => p.images.length > 0).length;
  const withCredits = programmes.filter((p) => (p.credits?.actors.length ?? 0) > 0).length;
  const withCategory = programmes.filter((p) => p.categories.length > 0).length;
  const withRating = programmes.filter((p) => p.rating).length;
  const withEpisode = programmes.filter((p) => p.episode).length;

  console.log('cobertura de metadatos:');
  console.log(`  descripción : ${withDesc} (${pct(withDesc)})`);
  console.log(`  imagen      : ${withImage} (${pct(withImage)})`);
  console.log(`  elenco      : ${withCredits} (${pct(withCredits)})`);
  console.log(`  categoría   : ${withCategory} (${pct(withCategory)})`);
  console.log(`  rating      : ${withRating} (${pct(withRating)})`);
  console.log(`  episodio    : ${withEpisode} (${pct(withEpisode)})`);

  const sample = programmes.find((p) => p.desc) ?? programmes[0];
  if (sample) {
    console.log('\nejemplo:');
    console.log(
      `  ${DateTime.fromMillis(sample.start).setZone(cfg.app.timezone).toFormat('dd/LL HH:mm')}` +
        `-${DateTime.fromMillis(sample.stop).setZone(cfg.app.timezone).toFormat('HH:mm')}` +
        ` | ${sample.title}`,
    );
    if (sample.desc) console.log(`  desc: ${sample.desc.slice(0, 160)}`);
    if (sample.categories.length) console.log(`  cat: ${sample.categories.join(', ')}`);
    if (sample.credits?.actors.length) console.log(`  elenco: ${sample.credits.actors.slice(0, 5).join(', ')}`);
    if (sample.images.length) console.log(`  img: ${sample.images[0]!.url}`);
  }
}

async function main(): Promise<void> {
  const only = arg('source');
  const isDry = arg('dry-run') !== undefined;
  const ids = only ? [only] : enabledSources().map((s) => s.id);

  for (const id of ids) {
    if (isDry) {
      await dryRun(id);
      continue;
    }
    const res = await ingestSource(id);
    const label = res.ok ? 'ok' : 'ERROR';
    console.log(
      `[${label}] ${res.sourceId}: ${res.channels} canales, ${res.programmes} programas (${(res.durationMs / 1000).toFixed(1)}s)` +
        (res.error ? ` — ${res.error}` : ''),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
