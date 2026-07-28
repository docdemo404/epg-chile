# API EPG Chile

Agregador de guía de programación de TV chilena. Reúne varias fuentes, unifica
los canales que se repiten entre ellas, **fusiona los metadatos campo a campo**
y publica la guía como XMLTV, XML.GZ o JSON en **enlaces permanentes** listos
para pegar en Kodi, Tvheadend, Jellyfin o Plex.

Lleva además la guía de **España** (Tivify), que viaja aparte: es una fuente
aislada y no se fusiona con nada chileno. Ver [Guía de España](#guía-de-españa).

## Por qué existe

Ninguna fuente chilena está completa. Medido contra las APIs reales:

| Fuente | Acceso | Canales | Aporta |
|---|---|---|---|
| **Movistar TV** | REST JSON público (GVP ContentAPI de Telefónica) | 207 | Sinopsis en el 96 %, imagen 1920×1080, elenco, géneros, rating por edad, temporada/episodio |
| **mi.tv** | HTML + JSON-LD | 192 | Sinopsis en el 100 %, género, episodio |
| **Emisoras** (Mega, Canal 13, La Red) | HTML de cada canal | 3 | Parrilla de primera mano: va por delante ante cambios de última hora |
| ~~Zapping TV~~ | HTML | — | Desactivada: geobloqueo a Chile, ver más abajo |
| **Parrilla fija** | JSON semanal en una URL | 1 | Canales locales sin EPG en ningún operador: su horario se repite cada semana |
| **Tivify** (España) | JSON del CDN de TVUP | 303 | Guía española completa. **Aislada**: no se fusiona con las chilenas |

Ninguna sola sirve, pero se complementan. El sistema toma la mejor versión de
cada dato y deja registrado de dónde salió.

Resultado actual: **570 canales —267 chilenos y 303 españoles—, ~56.900
emisiones, 97 % con sinopsis, 89 % con imagen, cero solapes.**

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

**El repositorio está conectado al proyecto de Vercel**, así que cada push a
`main` despliega solo. Es la forma elegida a propósito frente a desplegar desde
Actions: no hay ninguna credencial que guardar, rotar ni filtrar, y eso pesa
especialmente en un repositorio público. Un token de Vercel puede leer las
variables de entorno de la cuenta —o sea, `TURSO_AUTH_TOKEN` y
`BLOB_READ_WRITE_TOKEN`—, así que guardarlo en los secrets equivale a dejar
ahí la llave de todo el stack.

En este modo Vercel compila por su cuenta ejecutando el `buildCommand` de
`vercel.json`, que emite el Build Output igual que en local.

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

- **El builder de Vercel no sirve aquí.** Transpila el entrypoint pero deja
  intactos los especificadores `./app.ts` y no arrastra `src/`, así que cada
  petición moría con `ERR_MODULE_NOT_FOUND`. Se empaqueta con esbuild.
- **El entrypoint NO puede vivir en `api/`.** Ese directorio es una convención
  y Vercel construye lo que encuentre ahí *además* del Build Output que emite
  este proyecto, pisando el enrutado. Desplegando con `--prebuilt` no se nota,
  porque esa fase se salta; al conectar el repositorio a Git salió a la luz de
  golpe: la primera compilación hecha por Vercel dejó **404 en toda la API y
  500 en el panel**. Por eso está en `src/vercel-entry.ts`.
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

Una fuente marcada como `isolated` queda fuera de todo esto: no comparte canal
con nadie, así que nunca hay nada que fusionar. Ver [Guía de España](#guía-de-españa).

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

## Canales de parrilla fija

Los canales locales pequeños no salen en ningún operador ni tienen una web que
scrapear, pero sí publican un **horario semanal que se repite**: todos los
lunes lo mismo, otro bloque el fin de semana. La fuente `weekly` toma ese
horario y lo expande a fechas concretas dentro de la ventana de la guía.

La parrilla **vive fuera del repositorio**, en la URL que declara cada canal en
`config/sources.yaml`, y se vuelve a descargar en cada ingesta. Así el horario
se corrige editando ese archivo, sin tocar el código ni volver a desplegar.

```yaml
- id: weekly
  channels:
    - id: diferencia-tv
      name: Diferencia TV
      fullName: Diferencia Radio TV
      logo: https://…
      url: https://…/parrilla.json
```

El archivo agrupa los bloques por periodo. Solo hace falta la hora de inicio:

```json
{
  "canal": "Diferencia TV",
  "programacion": {
    "lunes_a_viernes": {
      "bloques": [
        { "hora": "08:00", "programa": "Inicio de Transmisiones" },
        { "hora": "22:00", "programa": "Noche de Películas",
          "descripcion": "…", "imagen": { "url": "https://…" } }
      ]
    },
    "sabado_y_domingo": { "bloques": [] }
  }
}
```

Cuatro decisiones que conviene conocer:

- **Cada bloque termina donde empieza el siguiente**, aunque el siguiente sea
  del día de después. Por eso el cierre de transmisiones cubre la madrugada
  entera hasta el inicio del día siguiente, en vez de dejar un hueco que el
  reproductor muestra como "sin información".
- **Una hora que retrocede es la madrugada siguiente.** El bloque de las 00:30
  que va detrás del de las 23:45 pertenece al día de después; situarlo en el
  suyo lo adelantaría 24 horas.
- **El periodo más específico gana.** Si hay un `lunes_a_domingo` y además un
  `domingo`, el domingo manda ese. Se aceptan las formas en que se escribe una
  parrilla a mano: `lunes_a_viernes`, `sábado y domingo`, `todos los días`, e
  incluso rangos que dan la vuelta a la semana (`viernes a lunes`).
- **Las imágenes se comprueban antes de publicarlas.** En las demás fuentes las
  URLs salen del CDN del operador; aquí las escribe a mano quien mantiene el
  archivo. Se verifica cada URL distinta una vez por ingesta —una docena por
  canal— y la que no responde no entra: una imagen muerta deja al reproductor
  esperando algo que no va a llegar. Ante un fallo de red se conserva.

`priority` va por detrás de las fuentes con horarios reales a propósito: una
parrilla fija describe la intención del canal, no lo que se emitió. Si algún
día un operador publica EPG de uno de estos canales, manda el suyo y la
parrilla fija se queda rellenando los huecos.

## Guía de España

Tivify emite canales **españoles**, así que entra como fuente **aislada**
(`isolated: true` en `config/sources.yaml`) y no se mezcla con nada chileno.

La unificación trabaja por **dominios**: cada fuente aislada forma el suyo y
sus canales solo pueden agruparse entre ellos. Toda la cascada lo respeta —el
alias manual incluido, que tampoco puede cruzar la frontera—, y como un canal
español nunca comparte canal unificado con uno chileno, tampoco hay forma de
que le preste ni le tome un metadato en el merge.

No es una precaución teórica. El nombre es la única señal que hay para vincular
canales, y entre países distintos esa señal miente: "La 1" contra "La Red",
"TV3" contra "TV+", "Cuatro" contra "Canal 13". Sin la frontera saldrían
canales con media parrilla de cada país, y eso no se ve venir mirando la guía:
parece un canal normal con la programación cambiada.

La separación se nota en tres sitios:

- Los ids XMLTV españoles acaban en **`.es`** y los chilenos en `.cl`, así que
  ni siquiera pueden colisionar dentro del mismo archivo.
- Los canales españoles van **en bloque al final** de la lista, en el panel y
  en el export. El número de canal solo significa algo dentro de su parrilla:
  intercalar por número los 303 españoles entre los chilenos deja la guía
  ilegible.
- No aparecen entre los **pendientes de vincular** del panel. No tienen con
  quién vincularse por definición, y listarlos enterraría los chilenos que sí
  esperan revisión.

El rating también viaja con su país: la calificación española (`TP`, `+12`) se
publica como `<rating system="ES">` y la chilena sigue en `system="CL"`. Lo
declara `ratingSystem` en la configuración de cada fuente.

**Cómo se obtiene.** `www.tivify.tv/canales` es una SPA sin HTML útil; la guía
sale del CDN de TVUP, que es de donde la lee la propia web, con el carrier
anónimo —el que ve quien entra sin cuenta—. No hay autenticación, ni geobloqueo,
ni nada que evadir:

```
{cdn}/media/carrier/{carrierId}/channels.json      · 320 canales
{cdn}/media/carrier/{carrierId}/epg/{a}/{m}/{d}.json · un día completo, todos los canales
{cdn}/media/genres.es.json · {cdn}/media/categories.es.json
```

Es la fuente más barata en peticiones y la más cara en bytes: **un request por
día** cubre los 303 canales, pero cada archivo pesa de 10 a 15 MB. Por eso el
cron va espaciado y la ingesta corre en Actions, no en la función serverless.

Medido: **310 canales, 27.133 emisiones en 4 días, 99 % con sinopsis, 92 % con
imagen, 97 % con categoría**. Las horas llegan en ISO con `Z`, así que aquí no
hay conversión de zona que pueda desplazar la guía.

Dos rarezas de la fuente que el adaptador tiene que absorber: un mismo evento
viene repetido dentro del archivo del día —mismo `eventId`, distinto `_id`— y
otra vez en el archivo de cada día que atraviesa, así que se deduplica por
`eventId`; y los canales sin guía real traen un único evento de 24 h con el
nombre del canal, que el resolutor de solapes recorta o descarta cuando hay
programación de verdad.

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

Tres claves por fuente gobiernan el aislamiento: `isolated` la saca de la
unificación, `xmltvSuffix` cambia la terminación de sus ids XMLTV (`es` en vez
de `cl`) y `ratingSystem` declara el sistema de calificación por edad que se
publica en el XMLTV.

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

Si la fuente es de **otro país**, además `isolated: true` y su propio
`xmltvSuffix`. El adaptador no cambia en nada: el aislamiento vive entero en la
unificación de canales.

## Fuentes y cortesía

Las fuentes son endpoints no documentados de terceros. Todo el tráfico sale por
un único cliente HTTP con límite de concurrencia, pausa entre peticiones,
respeto de `Retry-After`, `User-Agent` identificable y caché en disco. El
objetivo es refrescar la guía unas pocas veces al día.

Si una fuente falla, se conservan sus últimos datos buenos y la fusión sigue con
las demás: la guía nunca se degrada por una caída puntual.

**Tivify** es la excepción amable del lote: sirve la guía en archivos estáticos
de su CDN, sin autenticación, sin geobloqueo y sin anti-bot. La contrapartida
es el volumen —10 a 15 MB por día— y de ahí que su cron sea el más espaciado
de todos pese a ser el que menos peticiones hace.

**DirecTV está deshabilitado.** Su guía está protegida por Radware Bot Manager
(ShieldSquare) y responde con un desafío de JavaScript a cualquier cliente
automatizado. No se implementa evasión del control anti-bot. El adaptador queda
escrito en `src/sources/directv.ts` por si el acceso se abre; reactivarlo es
cambiar `enabled: true` en `config/sources.yaml`.

Reinvestigado a fondo el 2026-07-28, desde una conexión residencial chilena.
El dato existe y está vigente: cargada en un navegador real, la guía muestra la
grilla chilena completa del día. El adaptador también es correcto —el grabber de
`iptv-org/epg` para DirecTV Argentina y Uruguay usa exactamente el mismo método,
los mismos parámetros y las mismas dos trampas (`filtersScreenFilters: [""]` e
`isHd: ""`) que ya están implementadas—. Lo único que falta es pasar el control
anti-bot, y eso solo lo logra un navegador que ejecute el JS del desafío.

Qué se midió, todo con `User-Agent` identificable:

- **Todo el dominio está detrás del WAF.** `www.directv.cl`, `directv.cl` sin
  `www`, `/guia/guia.aspx`, `/guia/` y `/movil/ProgramGuide` responden `302` a
  `validate.perfdrive.com` con `Server: rdwr`. Solo `robots.txt` y `sitemap.xml`
  pasan. No es un bloqueo del endpoint JSON: es del host entero.
- **El sitio nuevo también.** La guía migró a `directvla.com/cl`, que está detrás
  del mismo WAF. El `baseUrl` del config apunta al host antiguo, pero da igual:
  ambos bloquean.
- **Suplantar el `User-Agent` no alcanza.** Con un UA de Chrome, `directvla.com`
  sigue devolviendo el `302` al desafío. La vía barata no funciona.
- **No hay tolerancia por sesión.** Tres peticiones con tarro de cookies limpio,
  espaciadas: las tres bloqueadas. No existe un margen inicial que permita un
  goteo lento y cortés.
- **Los sitios hermanos no sirven.** `.com.ar`, `.com.co`, `.com.pe`, `.com.ec`
  y `.com.uy` responden a las primeras peticiones y luego escalan al mismo
  desafío. Y aunque quedaran abiertos, cada despliegue sirve la grilla de su
  país: `PGCulture=es-CL` sobre el host argentino no cambia el catálogo.
- **DGO queda fuera.** No es alcanzable desde aquí (`dgo.com` resuelve pero no
  completa conexión, ni por cliente HTTP ni por navegador) y su guía vive tras
  una suscripción, así que exigiría credenciales.

La única forma conocida de entrar —la que usa `iptv-org`— es pedir primero la
página HTML para cosechar las cookies `__uzm*` que emite Radware y reenviarlas
en el POST junto a una huella de Chrome (`sec-ch-ua`, `uzlc: true`). Eso es
evasión del control anti-bot, exactamente lo que este proyecto no hace, ni aquí
ni en Zapping. Las rutas legítimas que quedan son pedir acceso a DirecTV/Vrio, o
alimentar la guía por las vías que el panel ya ofrece: subir un XMLTV o registrar
una guía remota por URL.

Un hallazgo útil para el día que el acceso se abra: además del `GetProgramming`
de `guia.aspx` que usa el adaptador —bloques de 3 horas para toda la grilla—
existe `guia/ChannelDetail.aspx/GetProgramming`, que devuelve **un día completo
de un solo canal en una sola petición**. Cambia el nombre del contenedor
(`filterParameters`, no `filterParam`) y añade `isChannelDetails: "Y"`,
`channelNum` y `channelName`, con `time: 0`. El parser de `iptv-org` lee
`description` de ahí, así que quizá ese endpoint sí traiga la sinopsis que el de
bloques deja siempre vacía. Sin acceso no se pudo verificar.

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
