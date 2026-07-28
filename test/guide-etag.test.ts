import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_VERSION, guideEtag } from '../src/core/version.ts';

/**
 * Regresión de un fallo que costó caro: el ETag se construía solo con la
 * versión de los datos, así que un despliegue que cambiaba lo emitido con los
 * mismos datos —descartar las imágenes de relleno— no invalidaba nada y todos
 * los reproductores seguían recibiendo 304 con su copia vieja.
 *
 * Las dos propiedades tienen que cumplirse a la vez: cambiar cuando cambia
 * cualquier entrada, y NO cambiar cuando no cambia ninguna. Si solo importara
 * la primera bastaría con un valor aleatorio, y entonces cada reproductor se
 * bajaría la guía entera cada pocos minutos.
 */

const base = { slug: 'all', format: 'xml', guideVersion: '1785271135613-77770' };

test('el ETag cambia al cambiar el código aunque los datos sean idénticos', () => {
  const antes = guideEtag({ ...base, codeVersion: 'build1' });
  const despues = guideEtag({ ...base, codeVersion: 'build2' });
  assert.notEqual(antes, despues);
});

test('el ETag cambia al fusionar de nuevo aunque el código sea el mismo', () => {
  const antes = guideEtag({ ...base, codeVersion: 'build1' });
  const despues = guideEtag({ ...base, guideVersion: '1785300000000-77801', codeVersion: 'build1' });
  assert.notEqual(antes, despues);
});

test('el ETag cambia al editar los canales de un perfil', () => {
  const antes = guideEtag({ ...base, slug: 'mi-seleccion', profileVersion: '.100' });
  const despues = guideEtag({ ...base, slug: 'mi-seleccion', profileVersion: '.200' });
  assert.notEqual(antes, despues);
});

test('el ETag se repite si no cambió nada, que es lo que sostiene el 304', () => {
  assert.equal(
    guideEtag({ ...base, codeVersion: 'build1' }),
    guideEtag({ ...base, codeVersion: 'build1' }),
  );
});

test('perfil y formato entran en el ETag', () => {
  const xml = guideEtag({ ...base, codeVersion: 'build1' });
  const gz = guideEtag({ ...base, format: 'xml.gz', codeVersion: 'build1' });
  const perfil = guideEtag({ ...base, slug: 'deportes', codeVersion: 'build1' });
  assert.equal(new Set([xml, gz, perfil]).size, 3);
});

test('el ETag es una cadena entrecomillada, como exige HTTP', () => {
  const etag = guideEtag({ ...base, codeVersion: 'build1' });
  assert.match(etag, /^"[^"]+"$/);
});

test('siempre hay versión de código, también fuera del bundle', () => {
  // En local no existe BUILD_ID; el valor de reserva no puede quedar vacío ni
  // ser "undefined", o el ETag dejaría de distinguir despliegues.
  assert.ok(CODE_VERSION.length > 0);
  assert.doesNotMatch(CODE_VERSION, /undefined|null/);
});
