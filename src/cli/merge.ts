import { DateTime } from 'luxon';
import { loadConfig } from '../core/config.ts';
import { defaultRange, rebuildMerge } from '../core/pipeline.ts';
import { getChannels, getMergedProgrammes } from '../db/repo.ts';

/**
 * CLI de fusión.
 *
 *   npm run merge
 *   npm run merge -- --report
 *
 * El informe muestra cuántos campos vinieron de una fuente distinta a la que
 * ancla el horario: esa cifra es la medida directa de para qué sirve todo
 * este sistema.
 */

const cfg = loadConfig();
const range = defaultRange();
const stats = await rebuildMerge(range);

console.log('=== Fusión de programas ===');
console.log(`grupos procesados        : ${stats.groups}`);
console.log(`programas resultantes    : ${stats.output}`);
console.log(`fusiones entre fuentes   : ${stats.crossSourceMerges}`);
console.log(`huecos cubiertos por respaldo : ${stats.gapsFilled}`);
console.log(`horarios rivales descartados  : ${stats.discardedRivals}`);
console.log('fuente principal por canal:');
for (const [src, n] of Object.entries(stats.primaryBySource).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${src.padEnd(10)} ${n} canales`);
}
console.log('campos rellenados por otra fuente:');
if (Object.keys(stats.enrichedFields).length === 0) {
  console.log('  (ninguno)');
} else {
  for (const [field, n] of Object.entries(stats.enrichedFields).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${field.padEnd(12)} ${n}`);
  }
}

if (process.argv.includes('--report')) {
  const channels = await getChannels();
  const byId = new Map(channels.map((c) => [c.id, c]));
  const programmes = await getMergedProgrammes({ from: range.from, to: range.to });

  const total = programmes.length || 1;
  const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;
  console.log('\n--- Cobertura de la guía fusionada ---');
  console.log(`  descripción : ${pct(programmes.filter((p) => p.desc).length)}`);
  console.log(`  imagen      : ${pct(programmes.filter((p) => p.images.length).length)}`);
  console.log(`  categoría   : ${pct(programmes.filter((p) => p.categories.length).length)}`);
  console.log(`  elenco      : ${pct(programmes.filter((p) => p.credits?.actors.length).length)}`);
  console.log(`  episodio    : ${pct(programmes.filter((p) => p.episode).length)}`);

  // Ejemplos donde el merge realmente aportó: campos de más de una fuente.
  const enriched = programmes
    .filter((p) => p.contributingSources.length > 1)
    .filter((p) => new Set(Object.values(p.provenance)).size > 1);

  console.log(`\n--- Programas enriquecidos entre fuentes (${enriched.length}) ---`);
  for (const p of enriched.slice(0, 8)) {
    const ch = byId.get(p.channelId);
    const when = DateTime.fromMillis(p.start).setZone(cfg.app.timezone).toFormat('dd/LL HH:mm');
    console.log(`\n  ${when} · ${ch?.canonicalName ?? p.channelId} · ${p.title}`);
    console.log(`    fuentes: ${p.contributingSources.join(' + ')}`);
    console.log(
      `    origen por campo: ${Object.entries(p.provenance).map(([k, v]) => `${k}<-${v}`).join(', ')}`,
    );
    if (p.desc) console.log(`    desc: ${p.desc.slice(0, 110)}...`);
  }
}
