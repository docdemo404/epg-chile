import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Localiza la raíz del proyecto.
 *
 * No basta con subir dos niveles desde este archivo: al empaquetar para
 * Vercel todo el código colapsa en un único `index.js`, y esa ruta relativa
 * apuntaría fuera del proyecto. Se prueban los candidatos y gana el primero
 * que realmente contenga la configuración.
 *
 * El candidato que importa en Vercel es `here`: el build copia `config/` DENTRO
 * de `index.func/`, al lado del bundle. Faltaba, y la lista solo acertaba de
 * rebote por `process.cwd()`, es decir, mientras la función arrancase con el
 * directorio de trabajo puesto en el suyo. El día que dejó de ser así,
 * `loadConfig()` empezó a lanzar ENOENT antes de registrar una sola ruta y la
 * app entera respondió 500, incluido `/health`, que ni siquiera toca la base.
 */
function findRoot(): string {
  const candidates = [
    join(here, '..', '..'), // src/core/config.ts en desarrollo
    here, // el bundle empaquetado: `config/` va JUNTO a index.js
    process.cwd(), // último recurso, si alguien arranca desde la raíz
    join(here, '..'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'config', 'sources.yaml'))) return c;
  }
  return candidates[0]!;
}

export const ROOT = findRoot();
export const CONFIG_DIR = join(ROOT, 'config');
export const DATA_DIR = process.env.EPG_DATA_DIR ?? join(ROOT, 'data');
export const EXPORT_DIR = process.env.EPG_EXPORT_DIR ?? join(ROOT, 'exports');
export const CACHE_DIR = process.env.EPG_CACHE_DIR ?? join(ROOT, 'cache');

export interface RateLimitConfig {
  concurrency: number;
  minDelayMs: number;
}

export interface SourceConfig {
  id: string;
  enabled: boolean;
  priority: number;
  baseUrl: string;
  refreshCron: string;
  rateLimit: RateLimitConfig;
  /**
   * Fuente aislada: sus canales nunca se unifican con los de otra fuente ni
   * intercambian metadatos con ellos. Es lo que corresponde a una guía de otro
   * país, donde un emparejado por nombre solo puede acertar por casualidad.
   */
  isolated?: boolean;
  /** Sufijo del xmltvId de sus canales. `cl` por defecto. */
  xmltvSuffix?: string;
  /** Sistema de calificación por edad que se declara en el XMLTV. `CL` por defecto. */
  ratingSystem?: string;
  [key: string]: unknown;
}

export interface AppConfig {
  app: {
    timezone: string;
    daysAhead: number;
    daysBehind: number;
    userAgent: string;
  };
  sources: SourceConfig[];
  fieldPriority: Record<string, string[]>;
  matching: {
    channelNameThreshold: number;
    programme: {
      minOverlapRatio: number;
      maxStartDriftMinutes: number;
      titleThreshold: number;
    };
  };
  http: {
    timeoutMs: number;
    retries: number;
    backoffBaseMs: number;
    cacheTtlMinutes: number;
  };
}

export interface AliasEntry {
  canonical: string;
  xmltvId: string;
  match: Record<string, (string | number)[]>;
}

export interface AliasConfig {
  channels: AliasEntry[];
  ignore?: { sources?: Record<string, (string | number)[]> };
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(force = false): AppConfig {
  if (cachedConfig && !force) return cachedConfig;
  const raw = readFileSync(join(CONFIG_DIR, 'sources.yaml'), 'utf8');
  cachedConfig = YAML.parse(raw) as AppConfig;
  return cachedConfig;
}

export function getSourceConfig(id: string): SourceConfig {
  const cfg = loadConfig();
  const found = cfg.sources.find((s) => s.id === id);
  if (!found) throw new Error(`Fuente no configurada en sources.yaml: ${id}`);
  return found;
}

const ALIAS_PATH = join(CONFIG_DIR, 'channel-aliases.yaml');

export function loadAliases(): AliasConfig {
  if (!existsSync(ALIAS_PATH)) return { channels: [] };
  const parsed = YAML.parse(readFileSync(ALIAS_PATH, 'utf8')) as AliasConfig | null;
  return { channels: parsed?.channels ?? [], ignore: parsed?.ignore };
}

/**
 * Persiste los alias. El panel llama aquí cuando resuelves un canal a mano,
 * de modo que la corrección sobreviva a las re-ingestas.
 */
export function saveAliases(aliases: AliasConfig): void {
  const doc = new YAML.Document(aliases);
  doc.commentBefore =
    ' Vínculos manuales entre canales de distintas fuentes.\n' +
    ' Tiene prioridad absoluta sobre el emparejado automático.\n' +
    ' Editado por el panel: los comentarios extensos viven en git.';
  writeFileSync(ALIAS_PATH, doc.toString({ lineWidth: 0 }), 'utf8');
}
