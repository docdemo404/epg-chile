/**
 * Pedirle a GitHub Actions que ingiera ahora.
 *
 * El reparto del proyecto es que Vercel lee y sirve, y Actions hace el trabajo
 * pesado (ver `puedeReconstruir` en `jobs.ts`). El agujero estaba en medio:
 * quien añadía una guía por URL desde el panel dejaba el alta guardada y tenía
 * que esperar al cron de cada 6 horas para verla, sin nada que lo dijera.
 *
 * Con esto el panel puede disparar el mismo workflow que corre por cron y la
 * guía entra en unos minutos. Es opcional a propósito: exige un token, y un
 * token es una decisión de quien despliega, no algo que el código deba dar por
 * hecho. Sin configurar, todo sigue funcionando y el aviso lo dice.
 *
 * Para activarlo, en las variables de entorno del proyecto en Vercel:
 *
 *   EPG_GITHUB_REPO   usuario/repositorio
 *   EPG_GITHUB_TOKEN  token con permiso de Actions (scope `workflow`)
 *
 * Opcionales: `EPG_GITHUB_WORKFLOW` (por defecto `epg.yml`) y `EPG_GITHUB_REF`
 * (por defecto `main`).
 */

export interface DispatchResult {
  lanzada: boolean;
  /** Por qué no se lanzó, para el registro; no se enseña tal cual. */
  motivo?: string;
  /** True si ni siquiera está configurado, que no es un error sino una opción. */
  sinConfigurar?: boolean;
}

export async function dispararIngesta(): Promise<DispatchResult> {
  const token = process.env.EPG_GITHUB_TOKEN;
  const repo = process.env.EPG_GITHUB_REPO;
  if (!token || !repo) return { lanzada: false, sinConfigurar: true, motivo: 'sin configurar' };

  const workflow = process.env.EPG_GITHUB_WORKFLOW ?? 'epg.yml';
  const ref = process.env.EPG_GITHUB_REF ?? 'main';

  // Con su propio plazo: si la API de GitHub se atasca, esto va dentro de una
  // petición del panel y no puede llevarse por delante la función entera.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'api-epg-cl',
        },
        body: JSON.stringify({ ref }),
        signal: controller.signal,
      },
    );
    // La API contesta 204 sin cuerpo cuando encola el workflow.
    if (res.status === 204) return { lanzada: true };
    return { lanzada: false, motivo: `GitHub respondió ${res.status} ${res.statusText}` };
  } catch (err) {
    return { lanzada: false, motivo: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
