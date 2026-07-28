import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Empaqueta la función de Vercel.
 *
 * Hace falta porque el builder de Vercel compila `api/index.ts` a `.js` pero
 * deja intactos los especificadores `../src/app.ts`, y no arrastra `src/`.
 * El resultado era un ERR_MODULE_NOT_FOUND en cada petición.
 *
 * esbuild resuelve todo el grafo de imports en un único archivo, así que el
 * runtime no tiene que resolver nada.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, '.vercel-build');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'api', 'index.ts')],
  outfile: join(root, 'api', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // libSQL carga binarios nativos por plataforma; empaquetarlo rompería esa
  // resolución. Se deja como dependencia externa, que Vercel sí instala.
  external: ['@libsql/client', '@libsql/*', 'libsql', '@vercel/blob'],
  banner: {
    // Algunas dependencias transitivas usan `require` en CommonJS; en un
    // bundle ESM hay que reponerlo.
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

// El panel se sirve con @fastify/static desde `join(here,'panel')`. En
// desarrollo eso es `src/panel`; junto al bundle tiene que ser `api/panel`.
cpSync(join(root, 'src', 'panel'), join(root, 'api', 'panel'), { recursive: true });

console.log('Bundle listo: api/index.js + api/panel/');
