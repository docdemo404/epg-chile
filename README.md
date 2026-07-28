# API EPG Chile

Agregador de guía de programación de TV chilena. Reúne varias fuentes, unifica
los canales que se repiten entre ellas, **fusiona los metadatos campo a campo**
y publica la guía como XMLTV, XML.GZ o JSON en **enlaces permanentes** listos
para pegar en Kodi, Tvheadend, Jellyfin o Plex.

## Por qué existe

Ninguna fuente chilena está completa. Medido contra las APIs reales:

| Fuente | Acceso | Canales | Aporta |
|---|---|---|---|
| **Movistar TV** | REST JSON público (GVP ContentAPI de Telefónica) | 207 | Sinopsis en el 96 %, imagen 1920×1080, elenco, géneros, rating por edad, temporada/episodio |
| **mi.tv** | HTML + JSON-LD | 192 | Sinopsis en el 100 %, género, episodio |
| **Emisoras** (Mega, Canal 13, La Red) | HTML de cada canal | 3 | Parrilla de primera mano: va por delante ante cambios de última hora |
| ~~Zapping TV~~ | HTML | — | Desactivada: geobloqueo a Chile, ver más abajo |

Ninguna sola sirve, pero se complementan. El sistema toma la mejor versión de
cada dato y deja registrado de dónde salió.

Resultado actual: **265 canales, ~23.200 emisiones, 96 % con sinopsis, 85 % con
imagen, cero solapes.**

## Uso rápido

```bash
npm install
```

```bash
npm run fetch
```

```bash
npm run match && npm run merge
```

```bash
npm start
```

El panel queda en <http://localhost:3000/panel>.

Con Docker:

```bash
docker compose up -d
```

## Despliegue en Vercel

El reparto es deliberado: **Vercel sirve, GitHub Actions ingiere**. La ingesta
completa tarda ~16 minutos —mi.tv pide un archivo por canal y día— y eso no
cabe en los 60 s de una función serverless, pero sí en Actions, que permite
hasta 6 horas. Vercel solo lee la base y responde.

```
GitHub Actions  →  ingesta pesada, cada 6 h  →  escribe en Turso
Vercel          →  panel + enlaces permanentes  →  lee de Turso
Vercel Blob     →  archivos EPG que subes desde el panel
```

**1. Crear la base en Turso** (plan gratuito) y anotar la URL y el token.

**2. Variables de entorno en Vercel** — `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
y `BLOB_READ_WRITE_TOKEN`.

Esta última no se copia a mano: se crea un store Blob y se **vincula** al
proyecto, y es la vinculación la que inyecta la variable en los tres entornos.
Un store creado pero sin vincular no aparece en `vercel env ls` y el panel
sigue guardando en disco efímero. Vale la pena comprobarlo: `/api/stats`
devuelve `"storage":"blob"` cuando quedó bien y `"disk"` cuando no.

El CLI vincula el store al crearlo (`vercel blob create-store <nombre>`), pero
el paso de vinculación es interactivo y necesita TTY: en un entorno sin consola
crea el store y lo deja suelto. Desde el panel de Vercel, en Storage, el store
se conecta al proyecto sin ese problema.

**3. Los mismos valores como secrets del repo**, para que Actions escriba en la
misma base: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN`.

**4. Desplegar:**

```bash
vercel deploy --prod --prebuilt --archive=tgz
```

### Despliegue continuo

Hay dos formas y no son equivalentes. La recomendada es **conectar el
repositorio desde el panel de Vercel**: no hay ninguna credencial que guardar,
rotar ni filtrar, y eso pesa especialmente en un repositorio público. Un token
de Vercel puede leer las variables de entorno de la cuenta —o sea,
`TURSO_AUTH_TOKEN` y `BLOB_READ_WRITE_TOKEN`—, así que guardarlo en los
secrets equivale a dejar ahí la llave de todo el stack.

Se activa en dos pasos, ambos en el navegador: añadir GitHub en
<https://vercel.com/account/login-connections> y conectar el repositorio en los
ajustes Git del proyecto. A partir de ahí, cada push a `main` despliega solo.

Su punto flaco es que Vercel publica **sin comprobar nada**. Por eso
`.github/workflows/deploy.yml` verifica tipos y pruebas en cada push aunque el
despliegue no pase por él: no bloquea la publicación, pero avisa.

La otra forma es desplegar desde Actions, que sí es un portón —no publica si
algo falla— a cambio de gestionar el token. El workflow ya lo contempla y solo
necesita tres secrets; `VERCEL_ORG_ID` y `VERCEL_PROJECT_ID` salen de
`.vercel/project.json`, y el token se crea en
<https://vercel.com/account/tokens>:

```
VERCEL_TOKEN · VERCEL_ORG_ID · VERCEL_PROJECT_ID
```

Mientras falte `VERCEL_TOKEN` el workflow no falla: verifica igual y se salta
solo el despliegue, dejando la explicación en el resumen de la ejecución.

Sin `TURSO_DATABASE_URL` el proyecto cae a un archivo SQLite local, que es lo
que quieres en desarrollo y lo que usa el contenedor Docker. En Vercel, en
cambio, arranca igual pero el panel muestra un aviso con lo que falta: una
guía vacía por falta de configuración no debe parecer un fallo del agregador.

### Detalles del despliegue que costaron encontrar

Están resueltos en `scripts/build-vercel.mjs`, pero conviene saber por qué:

- **El builder de Vercel no sirve aquí.** Transpila `api/index.ts` pero deja
  intactos los especificadores `../src/app.ts` y no arrastra `src/`, así que
  cada petición moría con `ERR_MODULE_NOT_FOUND`. Se empaqueta con esbuild.
- **`functions` se valida antes del build**, así que no se puede declarar un
  archivo que genera el propio build. Por eso se emite directamente
  `.vercel/output` con el Build Output API.
- **El cliente Node de libSQL no vale**: carga un binario nativo por
  plataforma y el bundle se construye en una máquina distinta de la que lo
  ejecuta. Se sustituye por `@libsql/client/web`, que es JS puro y habla el
  protocolo de Turso.
- **El bundle se minifica** porque la API de subida de Vercel rechazaba los
  4,5 MB sin minificar con un error interno.
- **`--archive=tgz`** evita el mismo fallo de subida: manda un único tarball
  en vez de archivo por archivo.

### Alternativa sin servidor

`npm run build:site` genera un sitio estático con los enlaces ya construidos,
publicable en GitHub Pages, Netlify o Cloudflare Pages. El panel funciona en
modo lectura y, en vez de guardar perfiles, genera el YAML para pegar en
`config/profiles.yaml`. Sin base de datos y sin subida de archivos.

## Enlaces permanentes

En `/panel` se eligen los canales, se pone un nombre y se crea el enlace. La URL
es fija y siempre devuelve la guía al día: se pega una vez en el reproductor y
se actualiza sola.

```
http://localhost:3000/epg/mi-seleccion.xml.gz
http://localhost:3000/epg/mi-seleccion.xml
http://localhost:3000/epg/mi-seleccion.json
http://localhost:3000/epg/all.xml.gz      ← guía completa, sin crear nada
```

Los ids de canal se conservan entre recálculos, así que un enlace creado hoy
sigue sirviendo los mismos canales después de cada actualización.

### Editar un enlace publicado

Al pulsar un enlace en el panel se cargan sus canales y se entra en modo
edición: se añaden o quitan los que haga falta y se guarda. **El slug no se
recalcula**, ni siquiera al renombrar, porque la URL ya está pegada en el
reproductor de quien la usa y una edición no puede romperla. Un enlace cuyo
nombre y slug diverjan es preferible a un enlace muerto; para tener otra URL
se crea otro perfil.

El cambio tarda hasta un minuto en verse a través del CDN (ver abajo).

### Velocidad: caché en el CDN

Los enlaces permanentes se cachean en el borde de Vercel, que es de donde sale
casi toda la velocidad. Antes se mandaba `public, max-age=900`, que solo habla
con el navegador: el CDN obedece `s-maxage`, así que **cada petición llegaba a
la función y pagaba los ~7 s de materializar el XMLTV**, con `X-Vercel-Cache`
en MISS siempre.

Hay dos políticas porque los dos casos no se parecen:

| | `s-maxage` | `stale-while-revalidate` | Por qué |
|---|---|---|---|
| `/epg/all.*` | 900 s | 86 400 s | 2,5 MB que cuestan ~7 s de generar y solo cambian con una ingesta, cada 6 h. El SWR evita que nadie vuelva a esperar |
| `/epg/{perfil}.*` | 60 s | — | Subconjunto pequeño y barato. Aquí el SWR estorba: haría que la primera petición tras vencer el plazo siguiera dando la lista vieja tras editar |

Además se manda un **ETag** derivado de la versión de la guía y, en los
perfiles, de su fecha de edición. Se calcula con una sola agregación, antes de
generar nada, así que un reproductor que ya está al día recibe un **304 sin
cuerpo** en vez de un export completo.

Medido contra producción desde Chile: `all.xml.gz` pasó de **7,0 s a 0,73 s**
cacheado, y a **0,52 s con 0 bytes** cuando el cliente manda `If-None-Match`.
De esos 0,5 s, unos 0,39 son handshake y latencia de ida y vuelta.

## Cómo funciona la fusión

Es la parte que da valor y conviene entenderla.

**Por cada canal manda una fuente principal**, que decide qué programas existen
y a qué hora. Las demás actúan como respaldo: solo aportan metadatos a los
programas que ya existen, y únicamente entran por derecho propio si caen en un
hueco real de la principal.

Sin esa regla, dos fuentes que discrepan sobre la parrilla emiten ambas
versiones y el XMLTV sale con emisiones solapadas, que es lo que rompe la
visualización en Kodi. Medido: sin fuente principal aparecían **1.067 solapes
en 49 canales**; con ella, cero.

Manda el orden de `priority`, no el volumen de datos: los agregadores encadenan
sus emisiones sin huecos y siempre "cubren" más tiempo que el EPG del operador,
que sí deja huecos reales.

**La fusión es campo a campo, no registro a registro.** Para cada campo se toma
el primer valor presente según la prioridad configurada para ese campo. Un `""`
cuenta como ausente: las fuentes devuelven cadena vacía en vez de `null`, y
tratarla como válida dejaría media guía sin sinopsis.

Cada campo queda anotado con su origen (`provenance`), visible en el panel y en
el JSON. Sin eso es imposible depurar un dato raro.

## Unificación de canales

`TVN` (Movistar), `tvn` (Zapping) y `tvn` (mi.tv) son el mismo canal. La
cascada es: alias manual → nombre normalizado idéntico → clave compacta →
similitud difusa. Lo que no llega al umbral queda **sin vincular y visible en el
panel** en vez de fusionarse mal en silencio.

Nunca se empareja por número de canal: las numeraciones de los operadores no
coinciden entre sí.

Los vínculos manuales viven en `config/channel-aliases.yaml` y tienen prioridad
absoluta. El panel escribe ahí, así que las correcciones sobreviven a cualquier
re-ingesta. Nombrar un canal en un alias arrastra sus señales gemelas: Movistar
publica dos "CANAL 13 SPA" (SD y HD) y ambas pertenecen al mismo canal.

## Añadir tu propia guía

Desde `/panel` puedes subir un XMLTV (`.xml`, `.xml.gz`) o el JSON que exporta
este proyecto. Se incorpora como una fuente más: entra en la unificación de
canales y aporta metadatos igual que las automáticas, con la prioridad que le
des en `config/sources.yaml`.

El archivo se valida **antes** de guardarse, así que uno ilegible nunca llega
a ensuciar la guía. En local se guarda en `config/uploads/` —versionable en el
repo— y en Vercel en Blob storage.

### Por URL

En la misma sección del panel puedes pegar la **URL** de una guía en vez de
subir el archivo. La diferencia está en el ciclo de vida: un archivo subido es
una foto fija, mientras que **una URL se vuelve a descargar en cada ingesta**.
Es lo que quieres para una guía de terceros que se actualiza sola.

Se descarga y valida al darla de alta, igual que un archivo. El formato se
detecta por el contenido y no por la extensión, así que sirve una URL sin
extensión útil (`/epg?format=xml`). Cada guía se puede desactivar sin perder la
URL, y si una falla se registra el motivo y las demás siguen.

La lista vive en la base y no en un archivo de configuración: el panel la
escribe en caliente, y en Vercel un YAML editado por la función se perdería en
la siguiente invocación. Al estar en la base la comparten Vercel —que las da
de alta— y Actions —que las descarga en cada ingesta—.

Dos avisos que conviene tener presentes:

- **El panel no tiene autenticación**, así que quien llegue a él puede hacer
  que el servidor pida una URL. Por eso se rechazan las direcciones internas y
  reservadas —loopback, rangos privados, CGNAT y el `169.254.169.254` donde
  varias nubes sirven credenciales de instancia— resolviendo el dominio antes
  de descargar. Está cubierto en `test/feed-url.test.ts`.
- **Incorporar una guía grande puede pasarse de los 60 s** de una función en
  Vercel. El alta se persiste antes de recalcular, así que si la petición muere
  la URL ya quedó registrada y la siguiente ingesta de Actions —sin límite de
  tiempo— la recoge sola. Medido en local: una guía de 265 canales y 29.765
  emisiones tarda ~100 s en descargarse, fusionarse y reconstruirse.

## Unificar canales a mano

Cuando dos entradas son en realidad el mismo canal y el emparejado automático
no lo vio, se seleccionan en el panel y se pulsa **Unificar seleccionados**.

Queda escrito en `config/channel-aliases.yaml`, que tiene prioridad absoluta,
así que la corrección sobrevive a cualquier re-ingesta. Nombrar un canal
arrastra además sus señales gemelas: al unificar BabyTV, la señal HD de
Movistar se incorporó sola.

Nota: el panel reescribe ese archivo, así que los comentarios que le añadas a
mano se pierden. La documentación extensa vive en este README y en git.

## Configuración

`config/sources.yaml` — fuentes, prioridades globales y por campo, límites de
tasa, cron de refresco, ventana de días.

`config/channel-aliases.yaml` — vínculos manuales y canales a ignorar.

`config/profiles.yaml` — perfiles publicados en el despliegue estático.

## Comandos

```bash
npm run fetch -- --source=movistar --dry-run
```

`--dry-run` consulta la fuente e imprime cobertura de metadatos sin tocar la
base: es la forma rápida de comprobar que un adaptador sigue funcionando cuando
un sitio cambia.

```bash
npm run match -- --report
```

```bash
npm run merge -- --report
```

El informe de `merge` muestra cuántos campos vinieron de una fuente distinta a
la que ancla el horario: esa cifra es la medida directa de para qué sirve todo
esto.

```bash
npm test
```

## API

| Ruta | Qué hace |
|---|---|
| `GET /epg/{perfil}.{xml\|xml.gz\|json}` | Enlace permanente de un perfil |
| `GET /api/channels` | Canales unificados con sus fuentes |
| `GET /api/programmes?channel=&from=&to=` | Guía fusionada, con procedencia |
| `GET /api/sources` | Estado y última ejecución de cada fuente |
| `GET /api/stats` | Cobertura de metadatos |
| `POST /api/profiles` | Crear un enlace permanente |
| `PATCH /api/profiles/{slug}` | Editar canales o nombre sin cambiar la URL |
| `DELETE /api/profiles/{slug}` | Eliminar un enlace |
| `POST /api/refresh` | Forzar ingesta (`{"source":"movistar"}` o todas) |
| `POST /api/rebuild` | Recalcular sin descargar |
| `GET /api/uploads` · `POST` · `DELETE /api/uploads/{nombre}` | Guías subidas como archivo |
| `GET /api/feeds` | Guías remotas por URL, con su último resultado |
| `POST /api/feeds` | Añadir una URL (`{"url":"…","label":"…"}`) |
| `PATCH /api/feeds/{id}` | Activar o desactivar (`{"enabled":false}`) |
| `DELETE /api/feeds/{id}` | Quitar una guía remota |

## Añadir una fuente

1. Implementar `EpgSource` en `src/sources/` (`fetchChannels`, `fetchProgrammes`).
2. Registrarla en `src/sources/index.ts`.
3. Declararla en `config/sources.yaml`.

El adaptador solo normaliza a la forma canónica; no sabe nada de la fusión ni
del almacenamiento. Todo instante que cruce esa frontera va en UTC: la
conversión desde hora chilena ocurre dentro del adaptador y en ningún otro
sitio, con la zona IANA `America/Santiago` — nunca un offset fijo, porque Chile
cambia entre −04 y −03 y un offset fijo desplaza media guía dos veces al año.

## Fuentes y cortesía

Las fuentes son endpoints no documentados de terceros. Todo el tráfico sale por
un único cliente HTTP con límite de concurrencia, pausa entre peticiones,
respeto de `Retry-After`, `User-Agent` identificable y caché en disco. El
objetivo es refrescar la guía unas pocas veces al día.

Si una fuente falla, se conservan sus últimos datos buenos y la fusión sigue con
las demás: la guía nunca se degrada por una caída puntual.

**DirecTV está deshabilitado.** Su guía está protegida por Radware y responde
con una página de captcha a cualquier cliente automatizado. No se implementa
evasión del control anti-bot. El adaptador queda escrito en
`src/sources/directv.ts` por si el acceso se abre; reactivarlo es cambiar
`enabled: true` en `config/sources.yaml`.

**Zapping está deshabilitado por geobloqueo.** Responde 403 con el cuerpo
`Acceso denegado: País no permitido` a toda IP fuera de Chile. No es anti-bot
—el origen es nginx pelado, sin WAF, y el User-Agent da igual—: es el país.
Medido: desde el runner de GitHub Actions (Azure westus3) da 403; desde una
conexión residencial chilena, 200 y los 177 canales.

Esto choca de frente con el reparto del despliegue: la ingesta pesada vive en
Actions justamente porque no cabe en Vercel, y no existe cómputo gratuito con
salida en Chile. Reactivarla exige ingerir desde una IP chilena —una máquina
local, o un despliegue en una región de Santiago como `southamerica-west1` de
GCP o `sa-santiago-1` de Oracle—. Tunelizar por VPN sí funcionaría en
apariencia, pero es evasión del mismo tipo que la que se rechazó con DirecTV,
así que no se hace.

Lo que cuesta, medido sobre una fusión de 26.558 emisiones: **2.453 emisiones
exclusivas (9,2 %) en ~76 canales** que ninguna otra fuente trae. En metadatos
de programas compartidos no aportaba nada —0 en elenco, categoría, episodio,
rating y subtítulo—, porque su ventaja teórica, el personaje de cada actor,
depende de `fetchDetails` y estaba apagado.

Mega redacta su parrilla dentro de una nota editorial en vez de una grilla, así
que su parser es el más frágil del proyecto: si cambia la redacción deja de
aportar, sin afectar al resto de la guía.
