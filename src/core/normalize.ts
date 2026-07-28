import { DateTime } from 'luxon';
import type { ImageRef } from './types.ts';

/**
 * Normalización de texto y tiempo compartida por todos los adaptadores.
 */

/** Sufijos de calidad/señal que no distinguen un canal de otro. */
const QUALITY_SUFFIXES = /\b(HD|SD|FHD|UHD|4K|HDTV|TVHD)\b/gi;

/**
 * Nombre de canal reducido a su forma comparable: sin acentos, sin
 * puntuación, sin sufijos de calidad, en mayúsculas.
 *
 * "TVN HD" y "T.V.N." colapsan ambos a "TVN", que es lo que permite vincular
 * el mismo canal entre DirecTV, Movistar y mi.tv.
 */
export function normalizeChannelName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(QUALITY_SUFFIXES, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

  // Quitar la puntuación de un acrónimo lo deja como letras sueltas: "T.V.N."
  // acaba en "T V N" y ya no casaría con "TVN". Se vuelven a pegar las
  // secuencias de caracteres sueltos.
  return base.replace(/\b([A-Z0-9]) (?=[A-Z0-9]\b)/g, '$1');
}

/**
 * Forma compacta del nombre: como `normalizeChannelName` pero sin espacios.
 *
 * Las fuentes escriben el mismo canal con y sin separador ("13_Rec" frente a
 * "13rec", "TV+" frente a "TVMAS"). Comparar sin espacios los une con
 * precisión, mientras que la similitud difusa se quedaba en 0,67 y los dejaba
 * como canales distintos.
 */
export function compactChannelName(name: string): string {
  return normalizeChannelName(name).replace(/ /g, '');
}

/**
 * Clave de emparejado: forma compacta sin el "TV" decorativo.
 *
 * Las fuentes alternan "Etc" y "Etc TV HD" para el mismo canal. Quitar los
 * sufijos de calidad no basta porque queda "ETCTV" frente a "ETC", y la
 * similitud difusa se queda en 0,67.
 *
 * Solo se elimina si sobra algún otro token: si no, un canal llamado
 * literalmente "TV+" se quedaría sin nombre con el que compararse.
 */
export function channelMatchKey(name: string): string {
  const tokens = normalizeChannelName(name).split(' ').filter(Boolean);
  const meaningful = tokens.filter((t) => t !== 'TV');
  return (meaningful.length ? meaningful : tokens).join('');
}

/** Título reducido a forma comparable, para emparejar programas entre fuentes. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Coeficiente de Dice sobre bigramas. Devuelve 0..1.
 *
 * Se prefiere a la distancia de Levenshtein porque tolera mejor palabras
 * reordenadas o añadidas, que es el caso típico entre operadores
 * ("TVN" vs "TELEVISION NACIONAL DE CHILE").
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const ba = bigrams(a);
  const bb = bigrams(b);
  let intersection = 0;
  let sizeA = 0;
  for (const n of ba.values()) sizeA += n;
  let sizeB = 0;
  for (const n of bb.values()) sizeB += n;

  for (const [g, countA] of ba) {
    const countB = bb.get(g);
    if (countB) intersection += Math.min(countA, countB);
  }
  return (2 * intersection) / (sizeA + sizeB);
}

/** Slug estable para xmltvId y URLs de perfil. */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Convierte una hora local chilena a epoch ms UTC.
 *
 * Se usa la zona IANA `America/Santiago`, nunca un offset fijo: Chile cambia
 * entre -04 y -03 y un offset hardcodeado desplaza media guía dos veces al año.
 */
export function santiagoToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute?: number; second?: number },
  zone = 'America/Santiago',
): number {
  const dt = DateTime.fromObject(
    { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute ?? 0, second: parts.second ?? 0 },
    { zone },
  );
  if (!dt.isValid) {
    throw new Error(`Fecha local inválida: ${JSON.stringify(parts)} (${dt.invalidReason})`);
  }
  return dt.toMillis();
}

/**
 * Parsea el formato de fecha de DirecTV: "7/27/2026 2:00:00 PM".
 *
 * Viene sin marca de zona y es hora de Santiago. Es la conversión más
 * delicada del proyecto: un error aquí desplaza la guía completa.
 */
export function parseDirectvDateTime(value: string, zone = 'America/Santiago'): number | null {
  const m = value
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  const [, mo, d, y, h, mi, s, ampm] = m;
  let hour = Number(h);
  if (ampm) {
    const upper = ampm.toUpperCase();
    if (upper === 'PM' && hour !== 12) hour += 12;
    if (upper === 'AM' && hour === 12) hour = 0;
  }
  const dt = DateTime.fromObject(
    { year: Number(y), month: Number(mo), day: Number(d), hour, minute: Number(mi), second: Number(s) },
    { zone },
  );
  return dt.isValid ? dt.toMillis() : null;
}

/** Formatea epoch ms UTC al formato de XMLTV: `20260727140000 -0400`. */
export function toXmltvTime(epochMs: number, zone = 'America/Santiago'): string {
  return DateTime.fromMillis(epochMs, { zone: 'utc' }).setZone(zone).toFormat('yyyyLLddHHmmss ZZZ');
}

/** Elige la imagen de mayor superficie de entre las de un tipo dado. */
export function largestImage(images: ImageRef[], kind?: ImageRef['kind']): ImageRef | undefined {
  const pool = kind ? images.filter((i) => i.kind === kind) : images;
  if (!pool.length) return undefined;
  return pool.reduce((best, cur) => {
    const areaBest = (best.width ?? 0) * (best.height ?? 0);
    const areaCur = (cur.width ?? 0) * (cur.height ?? 0);
    return areaCur > areaBest ? cur : best;
  });
}

/**
 * Un valor cuenta como "presente" solo si aporta información.
 *
 * Crítico para el merge: DirecTV devuelve `description: ""` en vez de `null`,
 * así que tratar la cadena vacía como valor válido dejaría a la mitad de la
 * guía sin sinopsis pese a que Movistar sí la tiene.
 */
export function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** Normaliza URLs http:// a https:// cuando el host lo soporta. */
export function preferHttps(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice(7)}` : url;
}
