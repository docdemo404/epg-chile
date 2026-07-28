-- Esquema de la guía EPG.
--
-- Se conserva siempre la capa cruda (raw_*) además de la fusionada. Eso
-- permite re-fusionar con otra prioridad sin volver a golpear las fuentes, y
-- es la herramienta de diagnóstico cuando una fuente cambia de formato.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  priority      INTEGER NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,
  last_ok_at    INTEGER,
  last_status   TEXT,
  last_error    TEXT,
  channel_count INTEGER DEFAULT 0,
  programme_count INTEGER DEFAULT 0
);

-- Canales tal como los entrega cada fuente, sin unificar.
CREATE TABLE IF NOT EXISTS raw_channels (
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_channel_id TEXT NOT NULL,
  name              TEXT NOT NULL,
  full_name         TEXT,
  number            INTEGER,
  logos_json        TEXT NOT NULL DEFAULT '[]',
  is_hd             INTEGER NOT NULL DEFAULT 0,
  raw_json          TEXT,
  fetched_at        INTEGER NOT NULL,
  PRIMARY KEY (source_id, source_channel_id)
);

-- Emisiones tal como las entrega cada fuente. `start`/`stop` en epoch ms UTC.
CREATE TABLE IF NOT EXISTS raw_programmes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_channel_id TEXT NOT NULL,
  start             INTEGER NOT NULL,
  stop              INTEGER NOT NULL,
  title             TEXT NOT NULL,
  sub_title         TEXT,
  desc              TEXT,
  categories_json   TEXT NOT NULL DEFAULT '[]',
  images_json       TEXT NOT NULL DEFAULT '[]',
  credits_json      TEXT,
  rating            TEXT,
  episode_json      TEXT,
  series_id         TEXT,
  external_ids_json TEXT NOT NULL DEFAULT '{}',
  raw_json          TEXT,
  fetched_at        INTEGER NOT NULL,
  UNIQUE (source_id, source_channel_id, start, title)
);

CREATE INDEX IF NOT EXISTS idx_raw_prog_lookup
  ON raw_programmes (source_id, source_channel_id, start);
CREATE INDEX IF NOT EXISTS idx_raw_prog_window
  ON raw_programmes (start, stop);

-- Canales unificados.
CREATE TABLE IF NOT EXISTS channels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  xmltv_id       TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL,
  alt_names_json TEXT NOT NULL DEFAULT '[]',
  logos_json     TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);

-- Vínculo entre un canal unificado y su representación en cada fuente.
-- `manual = 1` marca los que vienen de channel-aliases.yaml: el emparejado
-- automático nunca los pisa.
CREATE TABLE IF NOT EXISTS channel_links (
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_channel_id TEXT NOT NULL,
  number            INTEGER,
  confidence        REAL NOT NULL DEFAULT 1.0,
  manual            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, source_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_links_channel ON channel_links (channel_id);

-- Programas fusionados, listos para exportar.
CREATE TABLE IF NOT EXISTS programmes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  start             INTEGER NOT NULL,
  stop              INTEGER NOT NULL,
  title             TEXT NOT NULL,
  sub_title         TEXT,
  desc              TEXT,
  categories_json   TEXT NOT NULL DEFAULT '[]',
  images_json       TEXT NOT NULL DEFAULT '[]',
  credits_json      TEXT,
  rating            TEXT,
  episode_json      TEXT,
  series_id         TEXT,
  external_ids_json TEXT NOT NULL DEFAULT '{}',
  provenance_json   TEXT NOT NULL DEFAULT '{}',
  sources_json      TEXT NOT NULL DEFAULT '[]',
  merged_at         INTEGER NOT NULL,
  UNIQUE (channel_id, start)
);

CREATE INDEX IF NOT EXISTS idx_programmes_window ON programmes (start, stop);
CREATE INDEX IF NOT EXISTS idx_programmes_channel ON programmes (channel_id, start);

-- Perfiles de exportación guardados desde el panel.
CREATE TABLE IF NOT EXISTS profiles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  channels_json TEXT NOT NULL DEFAULT '[]',
  options_json  TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Diccionario de PIDs de Movistar (PER=persona, GEN=género, AGE=rating).
-- Se resuelven una vez y se reusan: son estables y ahorran miles de requests.
CREATE TABLE IF NOT EXISTS ca_dictionary (
  pid        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
