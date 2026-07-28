import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgeCode, utcDaysInRange } from '../src/sources/tivify.ts';

/**
 * Tivify sirve la guía en un archivo por día indexado por FECHA UTC, mientras
 * que la ventana que pide el proyecto va en horas de Santiago. Equivocarse en
 * esa traducción no rompe nada visible: simplemente falta el primer o el
 * último tramo de la guía, que es el fallo más difícil de notar.
 */
test('la ventana chilena se traduce a los días UTC que hay que descargar', () => {
  // 00:00 del 28 en Santiago (-04) son las 04:00 UTC del mismo día.
  const from = Date.UTC(2026, 6, 28, 4, 0, 0);
  const to = Date.UTC(2026, 6, 30, 3, 59, 0);
  assert.deepEqual(utcDaysInRange({ from, to }), ['2026/7/28', '2026/7/29', '2026/7/30']);
});

test('el recorrido de días cruza el cambio de mes y de año', () => {
  assert.deepEqual(
    utcDaysInRange({ from: Date.UTC(2026, 11, 31, 12, 0, 0), to: Date.UTC(2027, 0, 1, 12, 0, 0) }),
    ['2026/12/31', '2027/1/1'],
  );
});

test('una emisión que empieza antes del arranque de la ventana sigue en el recorrido', () => {
  // El archivo del día 28 es el que contiene la película que empezó a las
  // 23:30 del 28 y termina el 29: se descarga aunque la ventana arranque a
  // media tarde.
  const days = utcDaysInRange({ from: Date.UTC(2026, 6, 28, 20, 0, 0), to: Date.UTC(2026, 6, 29, 6, 0, 0) });
  assert.deepEqual(days, ['2026/7/28', '2026/7/29']);
});

test('el código de edad español se normaliza y "sin clasificar" no es un rating', () => {
  assert.equal(parseAgeCode('TP'), 'TP');
  assert.equal(parseAgeCode('tp'), 'TP');
  assert.equal(parseAgeCode('+12'), '+12');
  // La fuente alterna "Adultos" y "adultos" con "+18" para lo mismo.
  assert.equal(parseAgeCode('adultos'), '+18');
  assert.equal(parseAgeCode('Adultos'), '+18');
  // "SC" es *sin clasificar*: publicarlo pondría una etiqueta falsa en el
  // reproductor, así que la emisión sale sin rating.
  assert.equal(parseAgeCode('SC'), undefined);
  assert.equal(parseAgeCode(''), undefined);
  assert.equal(parseAgeCode(undefined), undefined);
});
