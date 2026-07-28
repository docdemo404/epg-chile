import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXmltv } from '../src/export/xmltv.ts';
import type { MergedProgramme } from '../src/core/types.ts';
import type { ChannelWithLinks } from '../src/db/repo.ts';

const channels: ChannelWithLinks[] = [
  {
    id: 1,
    xmltvId: 'tvn.cl',
    canonicalName: 'TVN',
    altNames: ['Televisión Nacional'],
    numbers: { movistar: 119 },
    logos: [{ url: 'https://cdn/tvn.png', kind: 'logo' }],
    sources: ['movistar', 'zapping'],
    links: [],
  },
];

const programmes: MergedProgramme[] = [
  {
    channelId: 1,
    start: Date.UTC(2026, 6, 27, 18, 0, 0),
    stop: Date.UTC(2026, 6, 27, 19, 30, 0),
    title: 'Pampa ilusión',
    subTitle: 'El destino los puso ahí',
    desc: 'Drama de época & <intriga>',
    categories: ['Drama', 'Telenovela'],
    images: [{ url: 'https://cdn/poster.jpg', kind: 'poster' }],
    credits: { actors: ['Álvaro Rudolphy'], directors: ['Vicente Sabatini'] },
    rating: '14',
    episode: { season: 1, episode: 5 },
    seriesId: '123',
    externalIds: { tmsId: 'SH010357350000' },
    provenance: { desc: 'movistar', images: 'zapping' },
    contributingSources: ['movistar', 'zapping'],
  },
];

test('el XMLTV incluye todos los metadatos disponibles', () => {
  const xml = buildXmltv(channels, programmes);

  assert.match(xml, /<!DOCTYPE tv SYSTEM "xmltv\.dtd">/);
  assert.match(xml, /<channel id="tvn\.cl">/);
  assert.match(xml, /<display-name lang="es">TVN<\/display-name>/);
  assert.match(xml, /<icon src="https:\/\/cdn\/tvn\.png" \/>/);
  assert.match(xml, /<title lang="es">Pampa ilusión<\/title>/);
  assert.match(xml, /<sub-title lang="es">El destino los puso ahí<\/sub-title>/);
  assert.match(xml, /<director>Vicente Sabatini<\/director>/);
  assert.match(xml, /<actor>Álvaro Rudolphy<\/actor>/);
  assert.match(xml, /<category lang="es">Drama<\/category>/);
  assert.match(xml, /<category lang="es">Telenovela<\/category>/);
  assert.match(xml, /<value>14<\/value>/);
  assert.match(xml, /<icon src="https:\/\/cdn\/poster\.jpg" \/>/);
});

test('los tiempos salen en hora de Santiago con su offset', () => {
  const xml = buildXmltv(channels, programmes);
  // 18:00 UTC en julio = 14:00 en Chile (-04).
  assert.match(xml, /start="20260727140000 -0400"/);
  assert.match(xml, /stop="20260727153000 -0400"/);
});

test('escapa los caracteres especiales del XML', () => {
  const xml = buildXmltv(channels, programmes);
  assert.match(xml, /Drama de época &amp; &lt;intriga&gt;/);
  assert.ok(!xml.includes('& <intriga>'), 'no debe quedar XML sin escapar');
});

test('emite episode-num en xmltv_ns (0-based) y onscreen', () => {
  const xml = buildXmltv(channels, programmes);
  assert.match(xml, /<episode-num system="xmltv_ns">0 \. 4 \. <\/episode-num>/);
  assert.match(xml, /<episode-num system="onscreen">S01E05<\/episode-num>/);
  // El tmsId de Gracenote permite a otros consumidores enriquecer por su cuenta.
  assert.match(xml, /<episode-num system="dd_progid">SH010357350000<\/episode-num>/);
});

test('el director va antes que el actor, como exige la DTD', () => {
  const xml = buildXmltv(channels, programmes);
  assert.ok(xml.indexOf('<director>') < xml.indexOf('<actor>'));
});

test('la procedencia solo aparece si se pide', () => {
  assert.ok(!buildXmltv(channels, programmes).includes('fuentes:'));
  const conProv = buildXmltv(channels, programmes, { includeProvenance: true });
  assert.match(conProv, /<!-- fuentes: [^>]*desc=movistar/);
});
