import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchChannels } from '../src/core/channel-match.ts';
import { channelMatchKey, normalizeChannelName } from '../src/core/normalize.ts';
import type { RawChannel } from '../src/core/types.ts';

/**
 * Tests de unificación de canales.
 *
 * Cada caso reproduce un fallo observado contra los datos reales: canales que
 * se veían duplicados en la guía porque las fuentes escriben el mismo canal
 * de formas distintas.
 */

function ch(sourceId: string, id: string, name: string, number?: number): RawChannel {
  return { sourceId, sourceChannelId: id, name, number, logos: [] };
}

function run(channels: RawChannel[]) {
  const bySource = new Map<string, RawChannel[]>();
  for (const c of channels) {
    const arr = bySource.get(c.sourceId) ?? [];
    arr.push(c);
    bySource.set(c.sourceId, arr);
  }
  return matchChannels(bySource);
}

test('la clave de emparejado ignora separadores y el "TV" decorativo', () => {
  // "13_Rec" vs "13rec": solo cambia un separador.
  assert.equal(channelMatchKey('13_Rec'), channelMatchKey('13rec'));
  // "Etc" vs "Etc TV HD": sobra un "TV" y un sufijo de calidad.
  assert.equal(channelMatchKey('Etc'), channelMatchKey('Etc TV HD'));
  // "T.V.N." vs "TVN": puntuación de acrónimo.
  assert.equal(channelMatchKey('T.V.N.'), channelMatchKey('TVN'));
});

test('no colapsa canales que de verdad son distintos', () => {
  assert.notEqual(channelMatchKey('ESPN'), channelMatchKey('ESPN 2'));
  assert.notEqual(channelMatchKey('Canal 13'), channelMatchKey('13C'));
  // "TV+" se queda en "TV": quitar el token lo dejaría sin nombre.
  assert.equal(channelMatchKey('TV+'), 'TV');
});

test('une el mismo canal escrito distinto en cada fuente', () => {
  const report = run([
    ch('movistar', 'LCH1', 'Etc TV HD', 240),
    ch('zapping', 'etc', 'Etc'),
    ch('mitv', 'etc-tv', 'ETC TV'),
  ]);
  assert.equal(report.channels.length, 1, 'las tres variantes son un solo canal');
  assert.deepEqual(
    [...new Set(report.channels[0]!.links.map((l) => l.sourceId))].sort(),
    ['mitv', 'movistar', 'zapping'],
  );
});

test('el nombre visible no arrastra el sufijo de calidad', () => {
  // El canal unificado agrupa SD y HD: anunciarlo como "HD" describiría mal
  // lo que contiene.
  const report = run([ch('movistar', 'LCH1', 'ETC TV HD'), ch('zapping', 'etc', 'Etc TV')]);
  assert.ok(!/\bHD\b/.test(report.channels[0]!.canonicalName));
});

test('agrupa las señales SD y HD que una fuente publica por separado', () => {
  // Movistar publica dos "CANAL 13 SPA" (LCH482 y LCH603) con nombre idéntico.
  const report = run([
    ch('movistar', 'LCH482', 'CANAL 13 SPA', 122),
    ch('movistar', 'LCH603', 'CANAL 13 SPA', 822),
  ]);
  assert.equal(report.channels.length, 1, 'son la misma señal en dos calidades');
  assert.equal(report.channels[0]!.links.length, 2);
});

test('no mezcla dos canales distintos de la misma fuente', () => {
  const report = run([
    ch('movistar', 'LCH1', 'ESPN', 500),
    ch('movistar', 'LCH2', 'ESPN 2', 501),
  ]);
  assert.equal(report.channels.length, 2, 'ESPN y ESPN 2 son canales distintos');
});

test('normalizeChannelName quita acentos y sufijos de calidad', () => {
  assert.equal(normalizeChannelName('Chilevisión HD'), 'CHILEVISION');
  assert.equal(normalizeChannelName('MEGA / MEGA HD'), 'MEGA MEGA');
});

/**
 * Aislamiento de fuentes.
 *
 * `tivify` va marcada como `isolated` en config/sources.yaml porque emite
 * canales españoles. Estos casos comprueban que la frontera aguanta los tres
 * caminos por los que un canal podría colarse al otro lado.
 */
test('una fuente aislada no se une a otra ni con el nombre idéntico', () => {
  const report = run([ch('movistar', 'LCH1', 'La 1'), ch('tivify', '5afe', 'La 1', 1)]);
  assert.equal(report.channels.length, 2, 'son canales de países distintos');
  for (const c of report.channels) {
    assert.equal(new Set(c.links.map((l) => l.sourceId)).size, 1);
  }
});

test('una fuente aislada tampoco se une por parecido tipográfico', () => {
  // Sin la frontera de dominio, "La Red" y "La 1" se comparan como cualquier
  // otro par de nombres y basta con que uno pase el umbral.
  const report = run([
    ch('movistar', 'LCH884', 'La Red', 12),
    ch('tivify', '5afe', 'La Sexta', 6),
    ch('tivify', '5aff', 'Antena 3', 3),
  ]);
  for (const c of report.channels) {
    const sources = new Set(c.links.map((l) => l.sourceId));
    assert.ok(!(sources.has('tivify') && sources.size > 1), `${c.canonicalName} cruzó la frontera`);
  }
});

test('los canales de una fuente aislada llevan su propio sufijo de xmltvId', () => {
  const report = run([ch('movistar', 'LCH1', 'Mega'), ch('tivify', '5afe', 'Telecinco', 5)]);
  const mega = report.channels.find((c) => c.canonicalName === 'Mega');
  const t5 = report.channels.find((c) => c.canonicalName === 'Telecinco');
  assert.match(mega!.xmltvId, /\.cl$/);
  assert.match(t5!.xmltvId, /\.es$/);
});

test('una fuente aislada sí agrupa sus propias señales gemelas', () => {
  // El aislamiento es entre fuentes, no dentro de una: Tivify publica dos
  // entradas "TV3 CAT" y siguen siendo el mismo canal.
  const report = run([ch('tivify', 'a', 'TV3 CAT', 301), ch('tivify', 'b', 'TV3 CAT', 302)]);
  assert.equal(report.channels.length, 1);
  assert.equal(report.channels[0]!.links.length, 2);
});

test('los canales de una fuente aislada no ensucian la lista de pendientes', () => {
  // No tienen con quién vincularse por definición: listarlos como pendientes
  // de revisión enterraría los chilenos que sí lo están.
  const report = run([
    ch('movistar', 'LCH9', 'Canal Regional Raro', 700),
    ch('tivify', '5afe', 'Cuatro', 4),
  ]);
  assert.deepEqual(
    report.unlinked.map((u) => u.sourceId),
    ['movistar'],
  );
});

test('los canales sin pareja quedan marcados para revisión', () => {
  const report = run([
    ch('movistar', 'LCH9', 'Canal Regional Raro', 700),
    ch('zapping', 'tvn', 'TVN'),
  ]);
  // Ninguno tiene contrapartida: ambos aparecen como pendientes de vincular
  // en el panel, en vez de fusionarse mal en silencio.
  assert.equal(report.stats.multiSource, 0);
  assert.equal(report.unlinked.length, 2);
});
