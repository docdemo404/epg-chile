import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProgrammes } from '../src/core/programme-merge.ts';
import type { RawProgramme } from '../src/core/types.ts';

/**
 * Tests del merge — la prueba central del proyecto.
 *
 * Las fixtures reproducen la asimetría real medida contra las fuentes: una
 * fuente que trae imagen pero devuelve `description: ""`, y otra que trae la
 * sinopsis y el elenco. Si el relleno entre fuentes se rompe, esto falla.
 */

const H = 3_600_000;
const base = Date.UTC(2026, 6, 27, 18, 0, 0);

function prog(over: Partial<RawProgramme> & { sourceId: string }): RawProgramme {
  return {
    sourceChannelId: 'ch1',
    start: base,
    stop: base + H,
    title: 'Pampa ilusión',
    categories: [],
    images: [],
    externalIds: {},
    ...over,
  };
}

test('rellena la sinopsis vacía de una fuente con la de otra', () => {
  const conImagen = prog({
    sourceId: 'zapping',
    // Tal cual llega de la fuente: el campo existe pero viene vacío.
    desc: '',
    images: [{ url: 'https://cdn/poster.jpg', kind: 'poster', width: 1920, height: 1080 }],
  });
  const conSinopsis = prog({
    sourceId: 'movistar',
    desc: 'La hija exiliada de un empresario inglés regresa a casa.',
    credits: { actors: ['Álvaro Rudolphy'], directors: ['Vicente Sabatini'] },
    categories: ['Drama'],
  });

  const { programmes, stats } = mergeProgrammes([
    { channelId: 1, programmes: [conImagen, conSinopsis] },
  ]);

  assert.equal(programmes.length, 1, 'las dos emisiones deben fusionarse en una');
  const merged = programmes[0]!;

  assert.equal(merged.desc, 'La hija exiliada de un empresario inglés regresa a casa.');
  assert.equal(merged.provenance.desc, 'movistar');
  assert.equal(merged.images[0]?.url, 'https://cdn/poster.jpg');
  assert.deepEqual(merged.credits?.actors, ['Álvaro Rudolphy']);
  assert.deepEqual(merged.categories, ['Drama']);
  assert.deepEqual(merged.contributingSources.sort(), ['movistar', 'zapping']);
  assert.equal(stats.crossSourceMerges, 1);
});

test('empareja pese a un desfase de minutos entre fuentes', () => {
  const a = prog({ sourceId: 'movistar', desc: 'Sinopsis completa' });
  // Las fuentes no coinciden al segundo: 7 minutos de desfase es normal.
  const b = prog({ sourceId: 'zapping', start: base + 7 * 60_000, stop: base + H + 7 * 60_000 });

  const { programmes } = mergeProgrammes([{ channelId: 1, programmes: [a, b] }]);
  assert.equal(programmes.length, 1);
  assert.equal(programmes[0]!.desc, 'Sinopsis completa');
});

test('no fusiona dos emisiones distintas de la misma fuente', () => {
  const a = prog({ sourceId: 'movistar', title: 'Noticias' });
  const b = prog({ sourceId: 'movistar', title: 'Noticias', start: base + H, stop: base + 2 * H });

  const { programmes } = mergeProgrammes([{ channelId: 1, programmes: [a, b] }]);
  assert.equal(programmes.length, 2, 'la fuente ya las distinguió: deben seguir separadas');
});

test('no fusiona programas distintos que coinciden en horario', () => {
  const a = prog({ sourceId: 'movistar', title: 'Fútbol: River vs Barracas' });
  const b = prog({ sourceId: 'zapping', title: 'Documental sobre pingüinos' });

  const { programmes } = mergeProgrammes([{ channelId: 1, programmes: [a, b] }]);
  assert.equal(programmes.length, 1, 'la fuente principal manda y la rival se descarta');
  assert.equal(programmes[0]!.title, 'Fútbol: River vs Barracas');
});

test('la fuente principal fija el horario y la de respaldo no lo contradice', () => {
  // Movistar cubre 6 horas; zapping propone una parrilla rival de 2 horas.
  const principal = [
    prog({ sourceId: 'movistar', title: 'Bloque A', start: base, stop: base + 3 * H }),
    prog({ sourceId: 'movistar', title: 'Bloque B', start: base + 3 * H, stop: base + 6 * H }),
  ];
  const rival = [
    prog({ sourceId: 'zapping', title: 'Otra cosa', start: base + H, stop: base + 2 * H }),
  ];

  const { programmes, stats } = mergeProgrammes([
    { channelId: 1, programmes: [...principal, ...rival] },
  ]);

  assert.equal(programmes.length, 2);
  assert.equal(stats.discardedRivals, 1);
  // Sin esta regla, XMLTV saldría con emisiones solapadas.
  assert.ok(programmes[0]!.stop <= programmes[1]!.start, 'no debe haber solapes');
});

test('una fuente de respaldo sí cubre un hueco real de la principal', () => {
  const principal = [
    prog({ sourceId: 'movistar', title: 'Bloque A', start: base, stop: base + H }),
    prog({ sourceId: 'movistar', title: 'Bloque B', start: base + 3 * H, stop: base + 4 * H }),
  ];
  // Cae justo en el hueco de 2 horas que la principal no cubre.
  const relleno = prog({
    sourceId: 'zapping',
    title: 'Programa intermedio',
    start: base + H,
    stop: base + 3 * H,
  });

  const { programmes, stats } = mergeProgrammes([
    { channelId: 1, programmes: [...principal, relleno] },
  ]);

  assert.equal(programmes.length, 3);
  assert.equal(stats.gapsFilled, 1);
  assert.ok(programmes.some((p) => p.title === 'Programa intermedio'));
});

test('recorta el bloque comodín alrededor de la emisión concreta', () => {
  // Caso real de Movistar en ESPN: un "compacto" de 9 h que engloba eventos.
  const comodin = prog({
    sourceId: 'movistar',
    title: 'ESPN Compact',
    start: base,
    stop: base + 9 * H,
  });
  const evento = prog({
    sourceId: 'movistar',
    title: 'Fórmula 1: GP de Hungría',
    start: base + 3 * H,
    stop: base + 5 * H,
  });

  const { programmes } = mergeProgrammes([{ channelId: 1, programmes: [comodin, evento] }]);

  for (let i = 1; i < programmes.length; i++) {
    assert.ok(
      programmes[i]!.start >= programmes[i - 1]!.stop,
      'la línea de tiempo debe quedar sin solapes',
    );
  }
  const f1 = programmes.find((p) => p.title.includes('Fórmula 1'));
  assert.ok(f1, 'la emisión concreta debe conservarse íntegra');
  assert.equal(f1!.start, base + 3 * H);
  assert.equal(f1!.stop, base + 5 * H);
  // El comodín sobrevive recortado a los tramos libres, sin perder cobertura.
  const restos = programmes.filter((p) => p.title === 'ESPN Compact');
  assert.equal(restos.length, 2);
});

test('registra la procedencia de cada campo', () => {
  const a = prog({ sourceId: 'zapping', title: 'Título', images: [{ url: 'i', kind: 'poster' }] });
  const b = prog({ sourceId: 'movistar', title: 'Título', desc: 'Sinopsis' });

  const { programmes } = mergeProgrammes([{ channelId: 1, programmes: [a, b] }]);
  const prov = programmes[0]!.provenance;
  assert.equal(prov.desc, 'movistar');
  assert.equal(prov.images, 'zapping');
});
