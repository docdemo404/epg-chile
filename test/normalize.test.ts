import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import {
  diceCoefficient,
  dropFallbackImages,
  isFallbackImage,
  isPresent,
  largestImage,
  normalizeChannelName,
  normalizeTitle,
  parseDirectvDateTime,
  toXmltvTime,
} from '../src/core/normalize.ts';

test('normalizeChannelName colapsa sufijos de calidad y acentos', () => {
  assert.equal(normalizeChannelName('TVN HD'), 'TVN');
  assert.equal(normalizeChannelName('T.V.N.'), 'TVN');
  assert.equal(normalizeChannelName('Chilevisión'), 'CHILEVISION');
  // Es la razón por la que TVN de DirecTV, Movistar y mi.tv acaban juntos.
  assert.equal(normalizeChannelName('TVN'), normalizeChannelName('tvn hd'));
});

test('normalizeChannelName no colapsa canales que sí son distintos', () => {
  assert.notEqual(normalizeChannelName('ESPN'), normalizeChannelName('ESPN 2'));
});

test('diceCoefficient distingue nombres parecidos de distintos', () => {
  assert.equal(diceCoefficient('TVN', 'TVN'), 1);
  assert.ok(diceCoefficient(normalizeTitle('Pampa ilusión'), normalizeTitle('Pampa ilusion')) > 0.9);
  assert.ok(diceCoefficient('ESPN', 'DISCOVERY') < 0.3);
});

test('isPresent trata la cadena vacía como ausente', () => {
  // Crítico para el merge: las fuentes devuelven "" en vez de null, y tomarlo
  // por válido dejaría programas sin sinopsis pese a que otra fuente la tiene.
  assert.equal(isPresent(''), false);
  assert.equal(isPresent('   '), false);
  assert.equal(isPresent([]), false);
  assert.equal(isPresent({}), false);
  assert.equal(isPresent('texto'), true);
  assert.equal(isPresent(['a']), true);
});

test('parseDirectvDateTime respeta el horario de invierno chileno (-04)', () => {
  // Julio en Chile es invierno: UTC-4. 14:00 local => 18:00 UTC.
  const ms = parseDirectvDateTime('7/27/2026 2:00:00 PM');
  assert.ok(ms !== null);
  assert.equal(DateTime.fromMillis(ms!, { zone: 'utc' }).toISO(), '2026-07-27T18:00:00.000Z');
});

test('parseDirectvDateTime respeta el horario de verano chileno (-03)', () => {
  // Enero es verano austral: UTC-3. 14:00 local => 17:00 UTC.
  // Un offset fijo desplazaría media guía dos veces al año.
  const ms = parseDirectvDateTime('1/15/2026 2:00:00 PM');
  assert.ok(ms !== null);
  assert.equal(DateTime.fromMillis(ms!, { zone: 'utc' }).toISO(), '2026-01-15T17:00:00.000Z');
});

test('parseDirectvDateTime maneja medianoche y mediodía en formato AM/PM', () => {
  const midnight = parseDirectvDateTime('7/27/2026 12:00:00 AM');
  const noon = parseDirectvDateTime('7/27/2026 12:00:00 PM');
  assert.equal(DateTime.fromMillis(midnight!, { zone: 'utc' }).toISO(), '2026-07-27T04:00:00.000Z');
  assert.equal(DateTime.fromMillis(noon!, { zone: 'utc' }).toISO(), '2026-07-27T16:00:00.000Z');
});

test('toXmltvTime emite el offset correcto en cada estación', () => {
  const winter = Date.UTC(2026, 6, 27, 18, 0, 0);
  const summer = Date.UTC(2026, 0, 15, 17, 0, 0);
  assert.equal(toXmltvTime(winter), '20260727140000 -0400');
  assert.equal(toXmltvTime(summer), '20260115140000 -0300');
});

test('largestImage elige la de mayor superficie', () => {
  const best = largestImage([
    { url: 'a', kind: 'poster', width: 300, height: 200 },
    { url: 'b', kind: 'poster', width: 1920, height: 1080 },
  ]);
  assert.equal(best?.url, 'b');
});

test('isFallbackImage descarta cualquier URL que mencione fallback', () => {
  // Las fuentes lo escriben de formas distintas; basta con que aparezca.
  assert.equal(isFallbackImage('https://cdn.mi.tv/fallback_movie.png'), true);
  assert.equal(isFallbackImage('https://cdn.tv/img/fallback.jpg'), true);
  assert.equal(isFallbackImage('https://cdn.tv/Fallback/poster.jpg'), true);
  assert.equal(isFallbackImage('https://cdn.tv/p.jpg?src=fallback'), true);
  assert.equal(isFallbackImage('https://cdn.tv/programas/pampa-ilusion.jpg'), false);
  assert.equal(isFallbackImage(undefined), false);
});

test('dropFallbackImages deja la lista sin imágenes de relleno', () => {
  // Sin este filtro el relleno gana el hueco en el merge y el programa se
  // queda sin la imagen real que sí traía otra fuente.
  const out = dropFallbackImages([
    { url: 'https://cdn.tv/fallback_serie.png', kind: 'poster' as const },
    { url: 'https://cdn.tv/real.jpg', kind: 'poster' as const },
  ]);
  assert.deepEqual(out.map((i) => i.url), ['https://cdn.tv/real.jpg']);
});
