import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { expandSchedule, weekdaysFromLabel } from '../src/sources/weekly.ts';

/**
 * Parrillas fijas: el horario se escribe una vez y hay que situarlo en fechas
 * concretas. Todo lo que puede salir mal está en esa expansión — el día que
 * cambia a medianoche, el periodo que cambia el sábado y la hora de Chile—,
 * así que es lo que cubren estas pruebas.
 */

const ZONE = 'America/Santiago';

/** Parrilla mínima con la forma del archivo real. */
const schedule = {
  canal: 'Canal de prueba',
  programacion: {
    lunes_a_viernes: {
      periodo: 'Lunes a Viernes',
      bloques: [
        { hora: '08:00', programa: 'Apertura' },
        { hora: '22:00', programa: 'Película' },
        { hora: '00:30', programa: 'Cierre' },
      ],
    },
    sabado_y_domingo: {
      periodo: 'Sábado y Domingo',
      bloques: [
        { hora: '09:00', programa: 'Apertura fin de semana' },
        { hora: '23:00', programa: 'Cine' },
      ],
    },
  },
};

const local = (ms: number): string =>
  DateTime.fromMillis(ms, { zone: 'utc' }).setZone(ZONE).toFormat('ccc HH:mm');

function expand(fromISO: string, toISO: string) {
  const from = DateTime.fromISO(fromISO, { zone: ZONE }).toMillis();
  const to = DateTime.fromISO(toISO, { zone: ZONE }).toMillis();
  return expandSchedule(schedule, { from, to }, ZONE)
    .filter((p) => p.start >= from && p.start < to)
    .map((p) => `${local(p.start)} ${p.block.programa}`);
}

test('la etiqueta del periodo se traduce a días de la semana', () => {
  assert.deepEqual(weekdaysFromLabel('lunes_a_viernes'), [1, 2, 3, 4, 5]);
  assert.deepEqual(weekdaysFromLabel('Sábado y Domingo'), [6, 7]);
  assert.deepEqual(weekdaysFromLabel('domingo'), [7]);
  assert.deepEqual(weekdaysFromLabel('todos los días'), [1, 2, 3, 4, 5, 6, 7]);
  // Un rango puede dar la vuelta a la semana.
  assert.deepEqual(weekdaysFromLabel('viernes a lunes'), [1, 5, 6, 7]);
});

test('el bloque de madrugada cae en el día siguiente, no en el de su parrilla', () => {
  // El 2026-07-28 es martes. Lo que se ve a las 00:30 del martes es el cierre
  // de la parrilla del LUNES; el del martes ya cae el miércoles y por eso no
  // aparece en este día. Situar cada bloque en el día de su fila lo adelantaría
  // 24 horas.
  const dia = expand('2026-07-28T00:00', '2026-07-29T00:00');
  assert.deepEqual(dia, ['Tue 00:30 Cierre', 'Tue 08:00 Apertura', 'Tue 22:00 Película']);
});

test('el fin de semana cambia de parrilla y el viernes cierra con la suya', () => {
  // Del viernes al sábado: el cierre de las 00:30 del sábado todavía es del
  // viernes, y a partir de las 09:00 manda ya la parrilla de fin de semana.
  const finde = expand('2026-07-31T00:00', '2026-08-02T00:00');
  assert.deepEqual(finde, [
    'Fri 00:30 Cierre',
    'Fri 08:00 Apertura',
    'Fri 22:00 Película',
    'Sat 00:30 Cierre',
    'Sat 09:00 Apertura fin de semana',
    'Sat 23:00 Cine',
  ]);
});

test('la parrilla se repite igual cada semana', () => {
  const semana1 = expand('2026-07-28T00:00', '2026-07-29T00:00');
  const semana2 = expand('2026-08-04T00:00', '2026-08-05T00:00');
  assert.deepEqual(semana1, semana2, 'dos martes consecutivos emiten lo mismo');
});

test('un periodo más específico gana al que cubre toda la semana', () => {
  const conExcepcion = {
    programacion: {
      todos_los_dias: { bloques: [{ hora: '10:00', programa: 'Genérico' }] },
      domingo: { bloques: [{ hora: '10:00', programa: 'Especial del domingo' }] },
    },
  };
  const from = DateTime.fromISO('2026-08-02T00:00', { zone: ZONE }).toMillis(); // domingo
  const to = DateTime.fromISO('2026-08-03T00:00', { zone: ZONE }).toMillis();
  const out = expandSchedule(conExcepcion, { from, to }, ZONE).filter(
    (p) => p.start >= from && p.start < to,
  );
  assert.deepEqual(
    out.map((p) => p.block.programa),
    ['Especial del domingo'],
  );
});

test('el cambio de hora de Chile no desplaza la parrilla', () => {
  // Chile adelanta el reloj la madrugada del 2026-09-06: las 08:00 siguen
  // siendo las 08:00 locales el día antes y el día después, aunque el offset
  // UTC cambie de -04 a -03.
  const cambio = expandSchedule(
    schedule,
    {
      from: DateTime.fromISO('2026-09-04T00:00', { zone: ZONE }).toMillis(),
      to: DateTime.fromISO('2026-09-09T00:00', { zone: ZONE }).toMillis(),
    },
    ZONE,
  );
  const aperturas = cambio
    .filter((p) => p.block.programa?.startsWith('Apertura'))
    .map((p) => local(p.start));
  assert.ok(
    aperturas.every((a) => a.endsWith('08:00') || a.endsWith('09:00')),
    `alguna apertura se desplazó: ${aperturas.join(', ')}`,
  );
});
