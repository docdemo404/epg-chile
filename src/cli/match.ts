import { rebuildChannels } from '../core/pipeline.ts';

/**
 * CLI de unificación de canales.
 *
 *   npm run match
 *   npm run match -- --report
 *
 * El informe lista los canales vinculados entre varias fuentes y, sobre todo,
 * los que quedaron sueltos: esos son los candidatos a alias manual en
 * config/channel-aliases.yaml o a resolver desde el panel.
 */

const wantsReport = process.argv.includes('--report');

const report = await rebuildChannels();
const { stats } = report;

console.log('=== Unificación de canales ===');
console.log(`canales unificados : ${stats.total}`);
console.log(`  multi-fuente     : ${stats.multiSource}`);
console.log(`  una sola fuente  : ${stats.singleSource}`);
console.log(`  con alias manual : ${stats.manual}`);
console.log('cobertura por fuente:');
for (const [src, n] of Object.entries(stats.bySource)) {
  console.log(`  ${src.padEnd(10)} ${n}`);
}

if (wantsReport) {
  const multi = report.channels.filter(
    (c) => new Set(c.links.map((l) => l.sourceId)).size > 1,
  );
  console.log(`\n--- Vinculados entre fuentes (${multi.length}) ---`);
  for (const c of multi) {
    const detail = c.links
      .map((l) => `${l.sourceId}:${l.sourceChannelId}${l.manual ? '*' : ''}`)
      .join(' + ');
    const conf = Math.min(...c.links.map((l) => l.confidence)).toFixed(2);
    console.log(`  ${c.canonicalName.padEnd(28)} ${detail}  (conf ${conf})`);
  }

  console.log(`\n--- Sin vincular (${report.unlinked.length}) ---`);
  console.log('Candidatos a alias manual; el panel los muestra para resolver.');
  const bySource = new Map<string, typeof report.unlinked>();
  for (const u of report.unlinked) {
    const arr = bySource.get(u.sourceId) ?? [];
    arr.push(u);
    bySource.set(u.sourceId, arr);
  }
  for (const [src, list] of bySource) {
    console.log(`  ${src} (${list.length}):`);
    for (const u of list.slice(0, 25)) {
      console.log(`    ${String(u.number ?? '—').padStart(5)} ${u.sourceChannelId.padEnd(14)} ${u.name}`);
    }
    if (list.length > 25) console.log(`    ... y ${list.length - 25} más`);
  }
}
