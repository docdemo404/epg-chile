/**
 * Modelo canónico compartido por todos los adaptadores.
 *
 * Los adaptadores traducen su fuente a estas formas y no saben nada del merge
 * ni del almacenamiento. Todo instante de tiempo que cruce esta frontera está
 * en UTC (epoch en milisegundos): la conversión desde la hora local chilena
 * ocurre dentro del adaptador y en ningún otro sitio.
 */

export interface ImageRef {
  url: string;
  /** poster vertical, videoFrame apaisado, banner, logo */
  kind: 'poster' | 'videoFrame' | 'banner' | 'logo';
  width?: number;
  height?: number;
}

export interface Credits {
  actors: string[];
  directors: string[];
  presenters?: string[];
}

export interface EpisodeRef {
  season?: number;
  episode?: number;
  /** Título del episodio, cuando la fuente lo distingue del título de la serie. */
  episodeTitle?: string;
}

/** Canal tal como lo entrega una fuente, antes de unificar. */
export interface RawChannel {
  sourceId: string;
  /** Identificador del canal dentro de la fuente (Pid, ChannelNumber, slug). */
  sourceChannelId: string;
  name: string;
  /** Nombre largo si la fuente lo distingue del corto. */
  fullName?: string;
  number?: number;
  logos: ImageRef[];
  isHD?: boolean;
  /** Respuesta original, para diagnóstico y re-procesado sin volver a la red. */
  raw?: unknown;
}

/** Emisión tal como la entrega una fuente, antes de fusionar. */
export interface RawProgramme {
  sourceId: string;
  sourceChannelId: string;
  /** UTC, epoch ms. */
  start: number;
  /** UTC, epoch ms. */
  stop: number;
  title: string;
  subTitle?: string;
  desc?: string;
  categories: string[];
  images: ImageRef[];
  credits?: Credits;
  /** Rating por edad ya resuelto a texto ("14", "TV-MA"). */
  rating?: string;
  episode?: EpisodeRef;
  seriesId?: string;
  /** IDs externos útiles para cruzar fuentes: tmsId de Gracenote, Pid de GVP. */
  externalIds: Record<string, string>;
  raw?: unknown;
}

/** Canal unificado, resultado de vincular canales de varias fuentes. */
export interface Channel {
  id: number;
  xmltvId: string;
  canonicalName: string;
  altNames: string[];
  /** Número de canal por fuente; las numeraciones no coinciden entre operadores. */
  numbers: Record<string, number>;
  logos: ImageRef[];
  /** Fuentes que cubren este canal. */
  sources: string[];
}

/**
 * De qué fuente salió cada campo del programa fusionado.
 * Sin esto es imposible depurar un dato raro sin volver a consultar las fuentes.
 */
export type Provenance = Partial<Record<keyof MergedProgrammeFields, string>>;

export interface MergedProgrammeFields {
  title: string;
  subTitle?: string;
  desc?: string;
  categories: string[];
  images: ImageRef[];
  credits?: Credits;
  rating?: string;
  episode?: EpisodeRef;
  seriesId?: string;
}

export interface MergedProgramme extends MergedProgrammeFields {
  channelId: number;
  start: number;
  stop: number;
  externalIds: Record<string, string>;
  provenance: Provenance;
  /** Fuentes que aportaron algún dato a este registro. */
  contributingSources: string[];
}

export interface FetchRange {
  /** UTC, epoch ms. */
  from: number;
  /** UTC, epoch ms. */
  to: number;
}

/**
 * Contrato de un adaptador. Añadir una fuente nueva es implementar esto y
 * registrarla en `config/sources.yaml`.
 */
export interface EpgSource {
  readonly id: string;
  fetchChannels(): Promise<RawChannel[]>;
  fetchProgrammes(range: FetchRange, channels: RawChannel[]): Promise<RawProgramme[]>;
}
