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
