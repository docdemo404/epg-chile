import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Construye el despliegue de Vercel con el Build Output API.
 *
 * Se llegó aquí descartando dos caminos que no funcionan:
 *
 *  1. Dejar que Vercel compile `api/index.ts` por su cuenta: transpila el
 *     archivo pero deja intactos los especificadores `../src/app.ts` y no
 *     arrastra `src/`, así que cada petición moría con ERR_MODULE_NOT_FOUND.
 *  2. Generar el bundle en `api/index.js` y declararlo en `functions`: Vercel
 *     valida ese patrón ANTES de ejecutar el build, cuando el archivo todavía
 *     no existe.
 *
 * El Build Output API evita ambos problemas: se emite directamente la
 * estructura final que Vercel despliega, sin que tenga que adivinar nada.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, '.vercel', 'output');
const fn = join(out, 'functions', 'index.func');

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

await build({
  entryPoints: [join(root, 'api', 'index.ts')],
  outfile: join(fn, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // libSQL resuelve binarios nativos por plataforma; empaquetarlo rompería esa
  // resolución. Se declara externo y se instala como dependencia normal.
  external: ['@libsql/client', '@libsql/*', 'libsql', '@vercel/blob'],
  banner: {
    // Dependencias transitivas que aún usan `require`: en un bundle ESM hay
    // que reponerlo.
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

// El panel se sirve con @fastify/static desde `join(here,'panel')`, y `here`
// dentro de la función es este directorio.
cpSync(join(root, 'src', 'panel'), join(fn, 'panel'), { recursive: true });

// La configuración se lee en tiempo de ejecución (fuentes, alias, perfiles).
cpSync(join(root, 'config'), join(fn, 'config'), { recursive: true });

// `type: module` para que el runtime cargue el bundle como ESM.
writeFileSync(join(fn, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.js',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      // La ingesta pesada corre en GitHub Actions; aquí solo se lee y se
      // sirve, pero generar la guía completa comprimida lleva unos segundos.
      maxDuration: 60,
    },
    null,
    2,
  ),
);

writeFileSync(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        // Todo lo sirve Fastify: el panel, la API y los enlaces permanentes.
        { src: '/(.*)', dest: '/index' },
      ],
    },
    null,
    2,
  ),
);

console.log('Build Output listo en .vercel/output');
