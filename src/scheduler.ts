import cron from 'node-cron';
import { loadConfig } from './core/config.ts';
import { ingestSource, rebuildChannels, rebuildMerge } from './core/pipeline.ts';

/**
 * Refresco automático de la guía.
 *
 * Cada fuente tiene su propio cron en sources.yaml, desfasado del resto para
 * no dispararlas todas a la vez. Tras cada ingesta se re-unifican canales y
 * se re-fusiona: así el resultado incorpora lo nuevo sin esperar al resto.
 *
 * Si una fuente falla, `ingestSource` ya captura el error y deja intactos sus
 * últimos datos buenos en la capa cruda; la fusión sigue adelante con las
 * demás y la guía nunca se degrada por una caída puntual.
 */

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export function startScheduler(log: Logger): void {
  const cfg = loadConfig();
  const zone = cfg.app.timezone;
  let running = false;

  for (const source of cfg.sources) {
    if (!source.enabled || !source.refreshCron) continue;
    if (!cron.validate(source.refreshCron)) {
      log.warn(`Cron inválido para ${source.id}: "${source.refreshCron}" — no se programa`);
      continue;
    }

    cron.schedule(
      source.refreshCron,
      async () => {
        // Un candado simple evita que dos fuentes reconstruyan a la vez.
        if (running) {
          log.warn(`Refresco de ${source.id} omitido: ya hay uno en curso`);
          return;
        }
        running = true;
        try {
          const result = await ingestSource(source.id);
          if (!result.ok) {
            log.error(`Ingesta de ${source.id} falló: ${result.error}`);
            return;
          }
          log.info(
            `Ingesta de ${source.id}: ${result.channels} canales, ${result.programmes} programas`,
          );
          await rebuildChannels();
          const merge = await rebuildMerge();
          log.info(`Guía recalculada: ${merge.output} programas`);
        } catch (err) {
          log.error(`Error inesperado refrescando ${source.id}: ${String(err)}`);
        } finally {
          running = false;
        }
      },
      { timezone: zone },
    );

    log.info(`Programado ${source.id} con cron "${source.refreshCron}" (${zone})`);
  }
}
