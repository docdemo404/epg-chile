/**
 * Esquema de la guía EPG.
 *
 * Va como constante y no como archivo `.sql` suelto a propósito: al empaquetar
 * para Vercel todo el código colapsa en un único bundle, y un `readFileSync`
 * relativo dejaba de encontrar el archivo. Como constante viaja siempre con el
 * código.
 *
 * Se conserva la capa cruda (`raw_*`) además de la fusionada: permite
 * re-fusionar con otra prioridad sin volver a golpear las fuentes, y es la
 * herramienta de diagnóstico cuando una fuente cambia de formato.
 */
export const SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS raw_channels (
  source_id         TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS raw_programmes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id         TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS channels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  xmltv_id       TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL,
  alt_names_json TEXT NOT NULL DEFAULT '[]',
  logos_json     TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_links (
  channel_id        INTEGER NOT NULL,
  source_id         TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  number            INTEGER,
  confidence        REAL NOT NULL DEFAULT 1.0,
  manual            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, source_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_links_channel ON channel_links (channel_id);

CREATE TABLE IF NOT EXISTS programmes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS profiles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  channels_json TEXT NOT NULL DEFAULT '[]',
  options_json  TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

/*
 * Guías remotas añadidas por URL.
 *
 * Van en la base y no en un archivo de config porque el panel las escribe en
 * caliente y en Vercel el sistema de archivos es efímero: un YAML editado por
 * la función se perdería en la siguiente invocación. La base la comparten
 * Vercel —que las da de alta— y Actions —que las descarga en cada ingesta—,
 * que es justo lo que hace falta.
 *
 * Se diferencian de un archivo subido en que se vuelven a descargar en cada
 * ingesta: una URL vale la pena precisamente cuando su contenido cambia.
 */
CREATE TABLE IF NOT EXISTS feed_urls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_fetch_at INTEGER,
  last_status   TEXT,
  last_error    TEXT,
  channel_count INTEGER NOT NULL DEFAULT 0,
  programme_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ca_dictionary (
  pid        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;
