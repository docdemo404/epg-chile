import { defaultRange, ingestSource, rebuildChannels, rebuildMerge } from './pipeline.ts';
import { enabledSources } from '../sources/index.ts';

/**
 * Ejecución en segundo plano del refresco.
 *
 * La ingesta completa tarda ~16 minutos (mi.tv pide un archivo por canal y
 * día, con pausa de cortesía). Mantener abierta la petición HTTP todo ese
 * rato no funciona: los proxies de cualquier plataforma la cortan al minuto,
 * y en el panel el botón se quedaba colgado un cuarto de hora.
 *
 * Así que la petición dispara el trabajo y devuelve al instante; el progreso
 * se consulta aparte.
 */

export interface JobStep {
  sourceId: string;
  status: 'pendiente' | 'en curso' | 'ok' | 'error';
  channels?: number;
  programmes?: number;
  error?: string;
  durationMs?: number;
}

export interface JobState {
  id: number;
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  steps: JobStep[];
  result?: { channels: number; programmes: number };
  error?: string;
}

let current: JobState | null = null;
let counter = 0;

export function getJobState(): JobState | null {
  return current;
}

export function isRunning(): boolean {
  return current?.running === true;
}

/**
 * Lanza un refresco en segundo plano. Devuelve el estado inicial, o el del
 * trabajo ya en curso si lo hay: dos ingestas simultáneas se pisarían al
 * reconstruir la guía.
 */
export function startRefresh(sourceId?: string): JobState {
  if (current?.running) return current;

  const ids = sourceId ? [sourceId] : enabledSources().map((s) => s.id);
  const state: JobState = {
    id: ++counter,
    running: true,
    startedAt: Date.now(),
    steps: ids.map((id) => ({ sourceId: id, status: 'pendiente' })),
  };
  current = state;

  // Deliberadamente sin await: la respuesta HTTP no espera al trabajo.
  void (async () => {
    try {
      for (const step of state.steps) {
        step.status = 'en curso';
        const res = await ingestSource(step.sourceId, defaultRange());
        step.status = res.ok ? 'ok' : 'error';
        step.channels = res.channels;
        step.programmes = res.programmes;
        step.durationMs = res.durationMs;
        if (!res.ok) step.error = res.error;
      }

      // Se recalcula aunque alguna fuente haya fallado: las demás sí trajeron
      // datos nuevos y la guía debe reflejarlos.
      const channels = await rebuildChannels();
      const merge = await rebuildMerge();
      state.result = { channels: channels.stats.total, programmes: merge.output };
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return state;
}
