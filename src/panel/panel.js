/* Panel de la guía EPG. Sin framework: el estado cabe en unas pocas variables
   y así el panel se sirve como estático desde la misma app. */

const state = {
  channels: [],
  selected: new Set(),
  profiles: [],
  activeChannel: null,
  /**
   * En el sitio publicado no hay servidor: el panel lee `channels.json` y,
   * en vez de guardar perfiles, genera el YAML para pegar en el repo. El
   * mismo archivo sirve local y estático, así que no hay dos panels que
   * mantener sincronizados.
   */
  static: false,
  data: null,
  /** Perfil que se está editando, o null si se está creando uno nuevo. */
  editing: null,
};

const $ = (sel) => document.querySelector(sel);

/**
 * Escapa texto que se interpola en `innerHTML`.
 *
 * Los nombres de canal y los títulos vienen de XMLTV de terceros, así que un
 * `&` o un `<` en el nombre ya rompía el marcado antes de plantearse nada peor.
 */
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

const fmtTime = (ms) =>
  new Date(ms).toLocaleString('es-CL', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  return res.json();
}

/** Detecta si el panel corre sobre el servidor o sobre el sitio publicado. */
async function detectMode() {
  try {
    const res = await fetch('static.json', { cache: 'no-store' });
    if (res.ok) {
      state.static = true;
      state.data = await (await fetch('channels.json', { cache: 'no-store' })).json();
      document.body.classList.add('is-static');
      return;
    }
  } catch {
    // Sin static.json: estamos sobre el servidor, con API completa.
  }
  state.static = false;
}

// ------------------------------------------------------------------ fuentes

async function loadSources() {
  const sources = state.static ? state.data.sources : await api('/api/sources');
  const box = $('#sources');
  box.innerHTML = '';

  const select = $('#filter-source');
  const current = select.value;
  select.innerHTML = '<option value="">Todas las fuentes</option>';

  for (const s of sources) {
    const cls = !s.enabled ? 'off' : s.status === 'ok' ? 'ok' : s.status === 'error' ? 'error' : 'off';
    const when = s.lastOkAt ? fmtTime(s.lastOkAt) : 'nunca';
    const card = document.createElement('div');
    card.className = 'source-card';
    card.innerHTML = `
      <div class="name"><span class="dot ${cls}"></span>${esc(s.id)}</div>
      <div class="meta">${s.channels} canales · ${s.programmes} progs</div>
      <div class="meta">${s.enabled ? `últ. ok: ${esc(when)}` : 'deshabilitada'}</div>`;
    if (s.error) card.title = s.error;
    box.appendChild(card);

    if (s.enabled) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.id;
      select.appendChild(opt);
    }
  }
  select.value = current;
}

async function loadStats() {
  const s = state.static ? state.data.stats : await api('/api/stats');
  const zone = state.static ? state.data.timezone : s.timezone;
  let text =
    `${s.channels} canales (${s.multiSourceChannels} con respaldo) · ${s.programmes} programas · ` +
    `${s.coverage.desc}% con sinopsis, ${s.coverage.image}% con imagen · ${zone}`;
  if (state.static) {
    const when = new Date(state.data.generatedAt).toLocaleString('es-CL', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    text += ` · actualizado ${when}`;
  }
  $('#subtitle').textContent = text;

  // Sin base persistente la guía se vacía en cada arranque en frío. Decirlo
  // evita que parezca que el agregador no encuentra canales.
  const warn = $('#no-db');
  if (warn) {
    warn.hidden = !s.ephemeral;
    // El mensaje del servidor dice exactamente qué falta; es más útil que el
    // texto genérico del HTML.
    const detail = warn.querySelector('.detail');
    if (detail) detail.textContent = s.setupError || '';
  }
}

// ------------------------------------------------------------------ canales

async function loadChannels() {
  state.channels = state.static ? state.data.channels : await api('/api/channels');
  renderChannels();
}

function visibleChannels() {
  const q = $('#search').value.trim().toLowerCase();
  const source = $('#filter-source').value;
  const link = $('#filter-link').value;

  return state.channels.filter((c) => {
    if (source && !c.sources.includes(source)) return false;
    if (link === 'multi' && c.sources.length < 2) return false;
    if (link === 'single' && c.sources.length !== 1) return false;
    if (link === 'empty' && c.programmes > 0) return false;
    if (!q) return true;
    const haystack = [c.name, ...c.altNames, c.xmltvId].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

function renderChannels() {
  const list = visibleChannels();
  const box = $('#channel-list');
  box.innerHTML = '';

  // Filtrar hasta no dejar nada dejaba un hueco en blanco, sin decir que el
  // culpable era el filtro y no la falta de canales.
  if (!list.length) {
    box.innerHTML = state.channels.length
      ? '<p class="empty">Ningún canal coincide con el filtro. ' +
        '<button type="button" class="linkish" id="clear-filters">Quitar los filtros</button></p>'
      : '<p class="empty">Todavía no hay canales. Lanza una actualización de fuentes.</p>';
    $('#clear-filters')?.addEventListener('click', () => {
      $('#search').value = '';
      $('#filter-source').value = '';
      $('#filter-link').value = '';
      renderChannels();
    });
    $('#channel-counter').textContent = `0 de ${state.channels.length}`;
    updateSelectedCounter();
    return;
  }

  for (const c of list) {
    const row = document.createElement('div');
    row.className =
      'channel' +
      (state.selected.has(c.id) ? ' selected' : '') +
      (state.activeChannel?.id === c.id ? ' peeking' : '');
    row.dataset.id = c.id;

    const nums = Object.values(c.numbers);
    const tags = c.sources.map((s) => `<span class="tag src">${esc(s)}</span>`).join('');
    // Un canal vinculado pero sin emisiones suele indicar un alias mal puesto.
    const empty = c.programmes === 0 ? '<span class="tag warn">sin programación</span>' : '';

    row.innerHTML = `
      <input type="checkbox" ${state.selected.has(c.id) ? 'checked' : ''}
             aria-label="Marcar ${esc(c.name)}">
      ${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy">` : '<img alt="">'}
      <div class="info">
        <div class="nm">${nums.length ? `<span class="tag">${esc(nums[0])}</span> ` : ''}${esc(c.name)}</div>
        <div class="meta">${tags}${empty}<span>${c.programmes} progs</span></div>
      </div>
      <button type="button" class="peek" title="Ver la programación de ${esc(c.name)}">Ver</button>`;

    // La casilla no lleva manejador propio a propósito: su clic burbujea hasta
    // la fila, que alterna el estado y repinta el listado. Si además llamara a
    // `toggle`, marcar por la casilla contaría dos veces y no haría nada.
    row.querySelector('.peek').addEventListener('click', (ev) => {
      ev.stopPropagation();
      showPreview(c);
    });
    row.addEventListener('click', () => toggle(c.id));
    box.appendChild(row);
  }

  $('#channel-counter').textContent = `${list.length} de ${state.channels.length}`;
  updateSelectedCounter();
}

function toggle(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderChannels();
}

function updateSelectedCounter() {
  const n = state.selected.size;
  $('#selected-counter').textContent =
    n === 0 ? 'ningún canal marcado' : n === 1 ? '1 canal marcado' : `${n} canales marcados`;

  // La barra solo aparece cuando hay algo marcado: en reposo no estorba, y al
  // marcar el primer canal se hace evidente que existe un paso siguiente.
  const bar = $('#selbar');
  if (bar) {
    bar.hidden = n === 0;
    $('#selbar-n').textContent = String(n);
  }
  renderEditingBar();
}

// ------------------------------------------------- edición de enlaces

/**
 * Edita un enlace ya publicado.
 *
 * Se reutiliza la misma selección de canales que sirve para crear: entrar en
 * modo edición es cargar los canales del perfil y recordar a cuál pertenecen.
 * Al guardar se manda un PATCH, que cambia los canales sin tocar el slug: la
 * URL que ya está pegada en el reproductor no puede cambiar.
 */
function startEditing(profile) {
  state.editing = { slug: profile.slug, name: profile.name };
  state.selected = new Set(profile.channelIds);
  renderChannels();
  toast(`Editando "${profile.name}" — cambia los canales y guarda`);
  $('#editing-bar')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function stopEditing() {
  state.editing = null;
  state.selected.clear();
  renderChannels();
}

function renderEditingBar() {
  const bar = $('#editing-bar');
  if (!bar) return;
  const create = $('#create-box');
  if (!state.editing) {
    bar.hidden = true;
    if (create) create.hidden = false;
    return;
  }
  bar.hidden = false;
  // Crear y editar a la vez confundiría sobre qué hace el botón.
  if (create) create.hidden = true;
  $('#editing-name').textContent = `«${state.editing.name}»`;
  $('#editing-count').textContent = `${state.selected.size} canales`;
}

async function saveEdit() {
  if (!state.editing) return;
  if (!state.selected.size) return toast('Deja al menos un canal', true);

  const btn = $('#btn-save-edit');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    const p = await api(`/api/profiles/${encodeURIComponent(state.editing.slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ channelIds: [...state.selected] }),
    });
    toast(`"${p.name}" actualizado: ${p.channelIds.length} canales`);
    state.editing = null;
    state.selected.clear();
    await loadProfiles();
    renderChannels();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar cambios';
  }
}

// ------------------------------------------------------------ vista previa

async function showPreview(channel) {
  // En estático no hay endpoint de programas: publicar la guía completa como
  // JSON navegable multiplicaría el peso del sitio sin ganar mucho.
  if (state.static) return;
  state.activeChannel = channel;

  // Se marca la fila sin volver a pintar el listado: un re-render perdería el
  // scroll justo cuando acabas de encontrar el canal que buscabas.
  for (const el of document.querySelectorAll('.channel.peeking')) el.classList.remove('peeking');
  document.querySelector(`.channel[data-id="${channel.id}"]`)?.classList.add('peeking');

  const label = $('#preview-of');
  if (label) label.textContent = channel.name;

  const box = $('#preview');
  box.innerHTML = '<p class="hint">Cargando…</p>';

  try {
    const programmes = await api(`/api/programmes?channel=${channel.id}&limit=40`);
    if (!programmes.length) {
      box.innerHTML = `<p class="hint">${esc(channel.name)} no tiene programación en la ventana actual.</p>`;
      return;
    }
    box.innerHTML = '';
    for (const p of programmes) {
      const el = document.createElement('div');
      el.className = 'prog';
      // La procedencia es lo que permite ver el merge funcionando: qué fuente
      // puso el título, cuál la sinopsis y cuál la imagen.
      const prov = Object.entries(p.provenance || {})
        .map(([field, src]) => `<span class="tag">${esc(field)}: ${esc(src)}</span>`)
        .join('');
      el.innerHTML = `
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<img alt="">'}
        <div class="body">
          <div class="when">${fmtTime(p.start)} – ${new Date(p.stop).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</div>
          <div class="ttl">${esc(p.title)}</div>
          ${p.subTitle ? `<div class="dsc">${esc(p.subTitle)}</div>` : ''}
          ${p.desc ? `<div class="dsc">${esc(p.desc.slice(0, 220))}</div>` : ''}
          <div class="prov">${prov}</div>
        </div>`;
      box.appendChild(el);
    }
  } catch (err) {
    box.innerHTML = `<p class="hint">No se pudo cargar: ${err.message}</p>`;
  }
}

// ----------------------------------------------------------------- perfiles

const FORMATS = ['xml', 'xml.gz', 'json'];

/** URL absoluta: es la que se pega en Kodi o Tvheadend, no una ruta relativa. */
function epgUrl(slug, format) {
  return `${window.location.origin}/epg/${slug}.${format}`;
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copiado`);
  } catch {
    // Sin permiso de portapapeles (o sin HTTPS): al menos se deja visible.
    window.prompt('Copia el enlace:', text);
  }
}

function linkButtons(slug) {
  const wrap = document.createElement('div');
  wrap.className = 'links';
  for (const format of FORMATS) {
    const url = epgUrl(slug, format);
    const btn = document.createElement('button');
    btn.className = 'linkbtn';
    btn.type = 'button';
    btn.title = url;
    btn.innerHTML = `<span>${format}</span><span class="copy">copiar</span>`;
    btn.addEventListener('click', () => copy(url, format));
    wrap.appendChild(btn);
  }
  return wrap;
}

function renderAllLinks() {
  const box = $('#all-links');
  box.innerHTML = '';
  box.appendChild(linkButtons('all'));
}

async function loadProfiles() {
  const box = $('#profiles');
  box.innerHTML = '';

  if (state.static) {
    // Los perfiles publicados salen de config/profiles.yaml y ya son archivos
    // reales en el sitio: solo hay que enseñar sus enlaces.
    state.profiles = state.data.profiles ?? [];
    if (!state.profiles.length) {
      box.innerHTML = '<p class="hint">No hay perfiles publicados.</p>';
      return;
    }
    for (const p of state.profiles) {
      const el = document.createElement('div');
      el.className = 'profile';
      const top = document.createElement('div');
      top.className = 'ptop';
      top.innerHTML = `<div class="phead"><div class="pname">${esc(p.name)} <span class="tag">${p.channels} canales</span></div></div>`;
      el.append(top, staticLinkButtons(p.files));
      box.appendChild(el);
    }
    return;
  }

  state.profiles = await api('/api/profiles');
  if (!state.profiles.length) {
    box.innerHTML = '<p class="hint">Todavía no has creado ningún enlace.</p>';
    return;
  }

  for (const p of state.profiles) {
    const el = document.createElement('div');
    el.className = 'profile';

    const head = document.createElement('div');
    head.className = 'phead';
    head.innerHTML = `<div class="pname">${esc(p.name)} <span class="tag">${p.channelIds.length} canales</span></div>`;
    head.title = 'Editar los canales de este enlace';
    head.addEventListener('click', () => startEditing(p));

    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.textContent = 'Editar';
    edit.title = 'Cambiar los canales de este enlace sin cambiar su URL';
    edit.addEventListener('click', () => startEditing(p));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Eliminar enlace';
    del.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar el enlace "${p.name}"? Dejará de funcionar en tus reproductores.`)) return;
      await api(`/api/profiles/${p.slug}`, { method: 'DELETE' });
      toast('Enlace eliminado');
      loadProfiles();
    });

    const acts = document.createElement('div');
    acts.className = 'pacts';
    acts.append(edit, del);

    const top = document.createElement('div');
    top.className = 'ptop';
    top.append(head, acts);

    el.append(top, linkButtons(p.slug));
    box.appendChild(el);
  }
}

/** Enlaces de un perfil ya publicado como archivo estático. */
function staticLinkButtons(files) {
  const wrap = document.createElement('div');
  wrap.className = 'links';
  for (const f of files ?? []) {
    const url = new URL(f.path, window.location.href).href;
    const btn = document.createElement('button');
    btn.className = 'linkbtn';
    btn.type = 'button';
    btn.title = url;
    const kb = f.bytes > 1024 * 1024
      ? `${(f.bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(f.bytes / 1024)} KB`;
    btn.innerHTML = `<span>${f.format}</span><span class="copy">${kb} · copiar</span>`;
    btn.addEventListener('click', () => copy(url, f.format));
    wrap.appendChild(btn);
  }
  return wrap;
}

/**
 * En estático no se puede guardar nada en el servidor, así que la selección
 * se convierte en el YAML que hay que pegar en config/profiles.yaml. Al
 * siguiente build, el enlace existe como archivo.
 */
function profileYaml(name, ids) {
  const byId = new Map(state.channels.map((c) => [c.id, c]));
  // Se referencia por xmltvId, no por id numérico: el id depende de la base,
  // que en CI se reconstruye entera en cada ejecución.
  const xmltvIds = ids
    .map((id) => byId.get(id)?.xmltvId)
    .filter(Boolean)
    .sort();
  const slug = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

  return [
    `  - name: ${name}`,
    `    slug: ${slug}`,
    '    match:',
    '      xmltvId:',
    ...xmltvIds.map((x) => `        - ${x}`),
  ].join('\n');
}

// ------------------------------------------------- unificar canales a mano

/**
 * Fusiona los canales seleccionados en uno solo.
 *
 * Se persiste en channel-aliases.yaml, que tiene prioridad absoluta sobre el
 * emparejado automático: la corrección sobrevive a cualquier re-ingesta.
 */
async function unifySelected() {
  const ids = [...state.selected];
  if (ids.length < 2) return toast('Marca al menos dos canales para unificar', true);

  const byId = new Map(state.channels.map((c) => [c.id, c]));
  const picked = ids.map((id) => byId.get(id)).filter(Boolean);
  // Se propone el que más fuentes tiene: suele ser el mejor identificado, y
  // conservar su id mantiene vivos los enlaces que ya apuntaban a él.
  const suggested = [...picked].sort((a, b) => b.sources.length - a.sources.length)[0];

  const name = window.prompt(
    `Unificar estos ${picked.length} canales:\n\n` +
      picked.map((c) => `· ${c.name} (${c.sources.join('+')})`).join('\n') +
      '\n\nNombre del canal resultante:',
    suggested.name,
  );
  if (name === null) return;

  try {
    const res = await api('/api/channels/merge', {
      method: 'POST',
      body: JSON.stringify({
        channelIds: ids,
        canonical: name.trim() || suggested.name,
        xmltvId: suggested.xmltvId,
      }),
    });
    state.selected.clear();
    await Promise.all([loadChannels(), loadStats()]);
    toast(`Unificado en "${res.channel?.name ?? name}" · ahora ${res.total} canales`);
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------ guías propias

async function loadUploads() {
  if (state.static) return;
  const box = $('#uploads');
  let files = [];
  try {
    files = await api('/api/uploads');
  } catch {
    box.innerHTML = '<p class="hint">No se pudo leer la lista de archivos.</p>';
    return;
  }

  $('#uploads-counter').textContent = files.length ? `${files.length} archivo(s)` : '';
  if (!files.length) {
    box.innerHTML = '<p class="hint">Todavía no has subido ninguna guía.</p>';
    return;
  }

  box.innerHTML = '';
  for (const f of files) {
    const el = document.createElement('div');
    el.className = 'upload' + (f.error ? ' bad' : '');
    const kb = f.bytes > 1024 * 1024
      ? `${(f.bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(f.bytes / 1024)} KB`;
    el.innerHTML = `
      <div class="uinfo">
        <div class="uname">${esc(f.name)}</div>
        <div class="meta">${
          f.error
            ? `<span class="tag warn">${esc(f.error)}</span>`
            : `<span class="tag">${esc(f.format)}</span><span>${f.channels} canales · ${f.programmes} progs · ${kb}</span>`
        }</div>
      </div>
      <button class="del" title="Quitar">×</button>`;
    el.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`¿Quitar "${f.name}"? Sus datos dejarán de aparecer en la guía.`)) return;
      try {
        await api(`/api/uploads/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
        toast('Archivo quitado');
        await Promise.all([loadUploads(), loadChannels(), loadStats(), loadSources()]);
      } catch (err) {
        toast(err.message, true);
      }
    });
    box.appendChild(el);
  }
}

async function uploadFile(file) {
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  toast(`Subiendo ${file.name}…`);
  try {
    // Sin Content-Type manual: el navegador debe poner el boundary correcto.
    const res = await fetch('/api/uploads', { method: 'POST', body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    toast(`${body.upload.name}: ${body.upload.channels} canales, ${body.upload.programmes} progs`);
    await Promise.all([loadUploads(), loadChannels(), loadStats(), loadSources()]);
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * Guías remotas por URL.
 *
 * Se construyen con nodos y `textContent` en vez de `innerHTML`: la etiqueta y
 * la URL las escribe quien usa el panel y volverían aquí sin escapar.
 */
async function loadFeeds() {
  const box = $('#feeds');
  if (!box) return;
  let feeds;
  try {
    feeds = await api('/api/feeds');
  } catch {
    box.textContent = '';
    return;
  }

  box.textContent = '';
  if (!feeds.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Todavía no has añadido ninguna guía por URL.';
    box.appendChild(p);
    return;
  }

  for (const f of feeds) {
    const el = document.createElement('div');
    el.className = 'upload' + (f.lastStatus === 'error' ? ' bad' : '');

    const info = document.createElement('div');
    info.className = 'uinfo';

    const name = document.createElement('div');
    name.className = 'uname';
    name.textContent = f.label;
    if (!f.enabled) name.textContent += ' (desactivada)';

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (f.lastStatus === 'error') {
      const tag = document.createElement('span');
      tag.className = 'tag warn';
      tag.textContent = f.lastError || 'error';
      meta.appendChild(tag);
    } else {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'url';
      const stats = document.createElement('span');
      stats.textContent = `${f.channels} canales · ${f.programmes} progs`;
      meta.append(tag, stats);
    }

    const link = document.createElement('div');
    link.className = 'meta';
    link.textContent = f.url;
    link.title = f.url;

    info.append(name, meta, link);

    const toggle = document.createElement('button');
    toggle.className = 'del';
    toggle.title = f.enabled ? 'Desactivar' : 'Activar';
    toggle.textContent = f.enabled ? '⏸' : '▶';
    toggle.addEventListener('click', async () => {
      try {
        await api(`/api/feeds/${f.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !f.enabled }),
        });
        toast(f.enabled ? 'Guía desactivada' : 'Guía activada');
        await Promise.all([loadFeeds(), loadChannels(), loadStats(), loadSources()]);
      } catch (err) {
        toast(err.message, true);
      }
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Quitar';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      if (!confirm(`¿Quitar "${f.label}"? Sus datos dejarán de aparecer en la guía.`)) return;
      try {
        await api(`/api/feeds/${f.id}`, { method: 'DELETE' });
        toast('Guía quitada');
        await Promise.all([loadFeeds(), loadChannels(), loadStats(), loadSources()]);
      } catch (err) {
        toast(err.message, true);
      }
    });

    el.append(info, toggle, del);
    box.appendChild(el);
  }
}

async function addFeed() {
  const urlInput = $('#feed-url');
  const labelInput = $('#feed-label');
  const url = urlInput.value.trim();
  if (!url) return toast('Pon una URL', true);

  const btn = $('#btn-add-feed');
  btn.disabled = true;
  btn.textContent = 'Comprobando…';
  try {
    const body = await api('/api/feeds', {
      method: 'POST',
      body: JSON.stringify({ url, label: labelInput.value.trim() || undefined }),
    });
    if (body.warning) toast(body.warning, true);
    else toast(`${body.feed.label}: ${body.feed.channels} canales, ${body.feed.programmes} progs`);
    urlInput.value = '';
    labelInput.value = '';
    await Promise.all([loadFeeds(), loadChannels(), loadStats(), loadSources()]);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Añadir';
  }
}

// -------------------------------------------------------------------- eventos

$('#search').addEventListener('input', renderChannels);
$('#filter-source').addEventListener('change', renderChannels);
$('#filter-link').addEventListener('change', renderChannels);

$('#sel-all').addEventListener('click', () => {
  for (const c of visibleChannels()) state.selected.add(c.id);
  renderChannels();
});
$('#sel-none').addEventListener('click', () => {
  state.selected.clear();
  renderChannels();
});
$('#sel-multi').addEventListener('click', () => {
  state.selected.clear();
  for (const c of state.channels) if (c.sources.length > 1) state.selected.add(c.id);
  renderChannels();
});

$('#selbar-clear').addEventListener('click', () => {
  state.selected.clear();
  renderChannels();
});
// El paso 2 está en la otra columna y en móvil queda debajo del listado: el
// botón lleva hasta él y deja el cursor donde toca escribir.
$('#selbar-go').addEventListener('click', () => {
  $('#links-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!state.editing) $('#profile-name').focus({ preventScroll: true });
});

async function createLink() {
  const name = $('#profile-name').value.trim();
  if (!name) return toast('Ponle un nombre al enlace', true);
  if (!state.selected.size) return toast('Marca al menos un canal', true);

  if (state.static) {
    const yaml = profileYaml(name, [...state.selected]);
    $('#yaml-out').textContent = yaml;
    $('#yaml-box').hidden = false;
    await copy(yaml, 'YAML');
    return;
  }

  try {
    const profile = await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name, channelIds: [...state.selected] }),
    });
    $('#profile-name').value = '';
    await loadProfiles();
    // El enlace recién creado se copia solo: es lo que la persona va a pegar.
    await copy(epgUrl(profile.slug, 'xml.gz'), 'Enlace');
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btn-save-profile').addEventListener('click', createLink);
$('#profile-name').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') createLink();
});

$('#btn-save-edit')?.addEventListener('click', saveEdit);
$('#btn-cancel-edit')?.addEventListener('click', stopEditing);

$('#btn-rebuild').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Recalculando…';
  try {
    const r = await api('/api/rebuild', { method: 'POST' });
    toast(`${r.channels.total} canales · ${r.merge.output} programas`);
    await Promise.all([loadChannels(), loadStats(), loadSources()]);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Recalcular';
  }
});

$('#btn-refresh').addEventListener('click', async (ev) => {
  if (!confirm('Descarga de todas las fuentes. Puede tardar varios minutos. ¿Continuar?')) return;
  const btn = ev.currentTarget;
  btn.disabled = true;

  try {
    await api('/api/refresh', { method: 'POST' });
  } catch (err) {
    // 409 significa que ya había un refresco corriendo: se sigue igualmente,
    // porque lo que interesa es ver su progreso.
    if (!/en curso/i.test(err.message)) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = 'Actualizar fuentes';
      return;
    }
  }

  // El POST vuelve al instante; el progreso real se consulta aparte.
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    let job;
    try {
      job = await api('/api/refresh/status');
    } catch {
      break;
    }
    const done = job.steps.filter((s) => s.status === 'ok' || s.status === 'error').length;
    const current = job.steps.find((s) => s.status === 'en curso');
    btn.textContent = current
      ? `${current.sourceId}… (${done}/${job.steps.length})`
      : `Actualizando… (${done}/${job.steps.length})`;

    if (!job.running) {
      const failed = job.steps.filter((s) => s.status === 'error');
      toast(
        failed.length
          ? `Terminado, con ${failed.length} fuente(s) en error: ${failed.map((f) => f.sourceId).join(', ')}`
          : `Guía actualizada: ${job.result?.programmes ?? '?'} programas`,
        failed.length > 0,
      );
      break;
    }
  }

  await Promise.all([loadChannels(), loadStats(), loadSources(), loadUploads()]);
  btn.disabled = false;
  btn.textContent = 'Actualizar fuentes';
});

// ------------------------------------------------------------------- arranque

$('#btn-unify').addEventListener('click', unifySelected);

$('#btn-browse').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (ev) => {
  uploadFile(ev.target.files[0]);
  ev.target.value = '';
});

const dropzone = $('#dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (ev) => {
    ev.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (ev) => {
    ev.preventDefault();
    dropzone.classList.remove('over');
  });
}
dropzone.addEventListener('drop', (ev) => uploadFile(ev.dataTransfer.files[0]));

$('#btn-add-feed').addEventListener('click', addFeed);
// Enter en cualquiera de los dos campos añade, que es lo que espera cualquiera
// que acabe de pegar una URL.
for (const id of ['#feed-url', '#feed-label']) {
  $(id).addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') addFeed();
  });
}

(async function init() {
  try {
    await detectMode();
    if (!state.static) renderAllLinks();
    const tasks = [loadSources(), loadStats(), loadChannels(), loadProfiles()];
    if (!state.static) tasks.push(loadUploads(), loadFeeds());
    await Promise.all(tasks);
  } catch (err) {
    toast(`No se pudo cargar el panel: ${err.message}`, true);
  }
})();
