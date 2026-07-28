import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeFeedUrl } from '../src/sources/uploads.ts';

/**
 * El panel no tiene autenticación y `assertSafeFeedUrl` es lo único que impide
 * usar el servidor como puente hacia la red interna. Conviene que sus casos
 * límite estén fijados: un fallo aquí no se nota en el uso normal.
 */

async function rechaza(url: string, motivo: RegExp): Promise<void> {
  await assert.rejects(() => assertSafeFeedUrl(url), motivo, `debería rechazar ${url}`);
}

test('rechaza esquemas que no son http o https', async () => {
  await rechaza('file:///etc/passwd', /http o https/);
  await rechaza('ftp://ejemplo.com/guia.xml', /http o https/);
  // `javascript:` y `data:` llegarían desde un campo de texto sin más.
  await rechaza('data:text/xml,<tv></tv>', /http o https/);
});

test('rechaza texto que no es una URL', async () => {
  await rechaza('no soy una url', /no es válida/);
  await rechaza('', /no es válida/);
});

test('rechaza loopback y direcciones privadas por IP literal', async () => {
  const interna = /interna o reservada/;
  await rechaza('http://127.0.0.1/guia.xml', interna);
  await rechaza('http://10.0.0.5/guia.xml', interna);
  await rechaza('http://192.168.1.1/guia.xml', interna);
  await rechaza('http://172.16.0.1/guia.xml', interna);
  await rechaza('http://172.31.255.255/guia.xml', interna);
  await rechaza('http://0.0.0.0/guia.xml', interna);
});

test('rechaza el endpoint de metadatos de instancia', async () => {
  // 169.254.169.254 sirve credenciales de la máquina en AWS, GCP y Azure: es
  // el destino clásico de un SSRF y el que más caro sale.
  await rechaza('http://169.254.169.254/latest/meta-data/', /interna o reservada/);
});

test('rechaza IPv6 loopback, enlace local y IPv4 mapeada', async () => {
  const interna = /interna o reservada/;
  await rechaza('http://[::1]/guia.xml', interna);
  await rechaza('http://[fe80::1]/guia.xml', interna);
  await rechaza('http://[fc00::1]/guia.xml', interna);
  await rechaza('http://[::ffff:127.0.0.1]/guia.xml', interna);
});

test('rechaza rangos que no son de internet pública', async () => {
  const interna = /interna o reservada/;
  await rechaza('http://100.64.0.1/guia.xml', interna); // CGNAT
  await rechaza('http://224.0.0.1/guia.xml', interna); // multicast
  await rechaza('http://255.255.255.255/guia.xml', interna);
});

test('acepta una IP pública', async () => {
  // Sin red: una IP literal no pasa por DNS, así que la prueba es estable.
  const url = await assertSafeFeedUrl('https://1.1.1.1/guia.xml.gz');
  assert.equal(url.hostname, '1.1.1.1');
  assert.equal(url.protocol, 'https:');
});

test('conserva la ruta y la query, que suelen llevar el formato', async () => {
  const url = await assertSafeFeedUrl('https://8.8.8.8/epg?format=xml&days=7');
  assert.equal(url.pathname, '/epg');
  assert.equal(url.searchParams.get('format'), 'xml');
});
