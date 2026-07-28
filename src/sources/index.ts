import { loadConfig } from '../core/config.ts';
import type { EpgSource } from '../core/types.ts';
import { BroadcastersSource } from './broadcasters.ts';
import { DirectvSource } from './directv.ts';
import { MitvSource } from './mitv.ts';
import { MovistarSource } from './movistar.ts';
import { TivifySource } from './tivify.ts';
import { UploadsSource } from './uploads.ts';
import { ZappingSource } from './zapping.ts';

/**
 * Registro de adaptadores. Añadir una fuente nueva es implementar `EpgSource`,
 * registrarla aquí y declararla en `config/sources.yaml`.
 *
 * `directv` sigue registrado pero va deshabilitado en sources.yaml: su guía
 * está tras un muro anti-bot de Radware. Se conserva por si alguna vez se
 * abre el acceso; reactivarlo es cambiar un `enabled`.
 */
const REGISTRY: Record<string, () => EpgSource> = {
  movistar: () => new MovistarSource(),
  zapping: () => new ZappingSource(),
  mitv: () => new MitvSource(),
  broadcasters: () => new BroadcastersSource(),
  uploads: () => new UploadsSource(),
  directv: () => new DirectvSource(),
  tivify: () => new TivifySource(),
};

export function createSource(id: string): EpgSource {
  const factory = REGISTRY[id];
  if (!factory) throw new Error(`Adaptador desconocido: ${id}`);
  return factory();
}

/** Fuentes habilitadas en sources.yaml, en orden de prioridad. */
export function enabledSources(): EpgSource[] {
  return loadConfig()
    .sources.filter((s) => s.enabled && REGISTRY[s.id])
    .sort((a, b) => a.priority - b.priority)
    .map((s) => createSource(s.id));
}

export { DirectvSource, MitvSource, MovistarSource, TivifySource };
