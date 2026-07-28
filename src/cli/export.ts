import { statSync } from 'node:fs';
import { writeExport, type ExportFormat } from '../export/index.ts';
import { getProfileBySlug } from '../db/repo.ts';

/**
 * CLI de exportación.
 *
 *   npm run export -- --format=xml
 *   npm run export -- --format=xml.gz --profile=mi-seleccion
 *   npm run export -- --format=json --name=guia
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const format = (arg('format') ?? 'xml') as ExportFormat;
if (!['json', 'xml', 'xml.gz'].includes(format)) {
  console.error(`Formato no soportado: ${format} (usa json, xml o xml.gz)`);
  process.exit(1);
}

const profileSlug = arg('profile');
let channelIds: number[] | undefined;

if (profileSlug) {
  const profile = await getProfileBySlug(profileSlug);
  if (!profile) {
    console.error(`No existe el perfil "${profileSlug}"`);
    process.exit(1);
  }
  channelIds = profile.channelIds;
  console.log(`perfil: ${profile.name} (${channelIds.length} canales)`);
}

const path = await writeExport(format, { channelIds, includeProvenance: process.argv.includes('--provenance') }, arg('name'));
const size = statSync(path).size;
console.log(`escrito: ${path} (${(size / 1024).toFixed(1)} KB)`);
