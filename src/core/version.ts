/**
 * Identidad del código en ejecución, y con ella la de las cachés.
 *
 * Existe por un fallo real: el ETag de los enlaces permanentes se construía
 * solo con la versión de los datos (`getGuideVersion`, que es la marca de la
 * última fusión). Al desplegar un cambio que altera lo que se emite con los
 * MISMOS datos —empezar a descartar las imágenes de relleno— el ETag no se
 * movió, así que cada reproductor recibía 304 y seguía sirviendo su copia
 * vieja. El arreglo estaba en producción y no llegaba a nadie; solo se
 * destrabó al forzar una fusión, horas después.
 *
 * La regla que se deriva: el ETag debe cambiar cuando cambie CUALQUIERA de las
 * dos entradas del XMLTV, los datos o el código que los formatea.
 */

/**
 * Marca de build que inyecta esbuild al empaquetar (`scripts/build-vercel.mjs`).
 *
 * Tiene que ser constante para todo el despliegue: en Vercel conviven varias
 * instancias de la misma función, y si cada una calculase su propia marca
 * darían ETags distintos para el mismo contenido y ninguna caché acertaría.
 */
const BUILD_ID = process.env.BUILD_ID;

/**
 * Fuera del bundle no hay marca de build. Se usa el arranque del proceso, que
 * cambia en cada reinicio —y `npm run dev` reinicia al guardar—, de modo que
 * tocar el código sigue invalidando el ETag mientras se desarrolla.
 *
 * Este camino nunca se toma en Vercel, donde el bundle trae `BUILD_ID`. Si
 * llegara a tomarse, `VERCEL_DEPLOYMENT_ID` sigue siendo estable por
 * despliegue y evita el problema de las instancias.
 */
export const CODE_VERSION: string =
  BUILD_ID ?? process.env.VERCEL_DEPLOYMENT_ID ?? `dev${Date.now().toString(36)}`;

/**
 * ETag de un enlace permanente `/epg/{perfil}.{formato}`.
 *
 * Junta las tres cosas que pueden cambiar el archivo servido: los datos
 * (`guideVersion`), la selección de canales del perfil (`profileVersion`) y el
 * código que lo genera (`codeVersion`). Dos peticiones con las tres iguales
 * deben dar el mismo ETag, o el 304 dejaría de funcionar y cada reproductor se
 * bajaría la guía entera cada pocos minutos.
 */
export function guideEtag(parts: {
  slug: string;
  format: string;
  guideVersion: string;
  profileVersion?: string;
  codeVersion?: string;
}): string {
  const { slug, format, guideVersion, profileVersion = '', codeVersion = CODE_VERSION } = parts;
  return `"${slug}.${format}.${guideVersion}${profileVersion}.${codeVersion}"`;
}
