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
};

const $ = (sel) => document.querySelector(sel);
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
      <div class="name"><span class="dot ${cls}"></span>${s.id}</div>
      <div class="meta">${s.channels} canales · ${s.programmes} progs</div>
      <div class="meta">${s.enabled ? `últ. ok: ${when}` : 'deshabilitada'}</div>`;
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

  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'channel' + (state.selected.has(c.id) ? ' selected' : '');
    row.dataset.id = c.id;

    const nums = Object.values(c.numbers);
    const tags = c.sources.map((s) => `<span class="tag src">${s}</span>`).join('');
    // Un canal vinculado pero sin emisiones suele indicar un alias mal puesto.
    const empty = c.programmes === 0 ? '<span class="tag warn">sin programación</span>' : '';

    row.innerHTML = `
      <input type="checkbox" ${state.selected.has(c.id) ? 'checked' : ''}>
      ${c.logo ? `<img src="${c.logo}" alt="" loading="lazy">` : '<img alt="">'}
      <div class="info">
        <div class="nm">${nums.length ? `<span class="tag">${nums[0]}</span> ` : ''}${c.name}</div>
        <div class="meta">${tags}${empty}<span>${c.programmes} progs</span></div>
      </div>`;

    row.querySelector('input').addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggle(c.id);
    });
    row.addEventListener('click', () => showPreview(c));
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
  $('#selected-counter').textContent = `${state.selected.size} seleccionados`;
}

// ------------------------------------------------------------ vista previa

async function showPreview(channel) {
  // En estático no hay endpoint de programas: publicar la guía completa como
  // JSON navegable multiplicaría el peso del sitio sin ganar mucho.
  if (state.static) return;
  state.activeChannel = channel;
  const box = $('#preview');
  box.innerHTML = '<p class="hint">Cargando…</p>';

  try {
    const programmes = await api(`/api/programmes?channel=${channel.id}&limit=40`);
    if (!programmes.length) {
      box.innerHTML = `<p class="hint">${channel.name} no tiene programación en la ventana actual.</p>`;
      return;
    }
    box.innerHTML = '';
    for (const p of programmes) {
      const el = document.createElement('div');
      el.className = 'prog';
      // La procedencia es lo que permite ver el merge funcionando: qué fuente
      // puso el título, cuál la sinopsis y cuál la imagen.
      const prov = Object.entries(p.provenance || {})
        .map(([field, src]) => `<span class="tag">${field}: ${src}</span>`)
        .join('');
      el.innerHTML = `
        ${p.image ? `<img src="${p.image}" alt="" loading="lazy">` : '<img alt="">'}
        <div class="body">
          <div class="when">${fmtTime(p.start)} – ${new Date(p.stop).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</div>
          <div class="ttl">${p.title}</div>
          ${p.subTitle ? `<div class="dsc">${p.subTitle}</div>` : ''}
          ${p.desc ? `<div class="dsc">${p.desc.slice(0, 220)}</div>` : ''}
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
      top.innerHTML = `<div class="phead"><div class="pname">${p.name} <span class="tag">${p.channels} canales</span></div></div>`;
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
    head.innerHTML = `<div class="pname">${p.name} <span class="tag">${p.channelIds.length} canales</span></div>`;
    head.title = 'Cargar esta selección de canales';
    head.addEventListener('click', () => {
      state.selected = new Set(p.channelIds);
      renderChannels();
      toast(`Cargada la selección de "${p.name}"`);
    });

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

    const top = document.createElement('div');
    top.className = 'ptop';
    top.append(head, del);

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
  if (ids.length < 2) return toast('Selecciona al menos dos canales para unificar', true);

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
        <div class="uname">${f.name}</div>
        <div class="meta">${
          f.error
            ? `<span class="tag warn">${f.error}</span>`
            : `<span class="tag">${f.format}</span><span>${f.channels} canales · ${f.programmes} progs · ${kb}</span>`
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

async function createLink() {
  const name = $('#profile-name').value.trim();
  if (!name) return toast('Ponle un nombre al enlace', true);
  if (!state.selected.size) return toast('Selecciona al menos un canal', true);

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

(async function init() {
  try {
    await detectMode();
    if (!state.static) renderAllLinks();
    const tasks = [loadSources(), loadStats(), loadChannels(), loadProfiles()];
    if (!state.static) tasks.push(loadUploads());
    await Promise.all(tasks);
  } catch (err) {
    toast(`No se pudo cargar el panel: ${err.message}`, true);
  }
})();
