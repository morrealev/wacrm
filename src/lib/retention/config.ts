/**
 * Configurazione della retention (ROPA T-05, DEC-2026-10-27-002).
 *
 * `MESSAGE_RETENTION_MONTHS` è un opt-in ESPLICITO: senza un intero
 * positivo la retention non parte e l'endpoint risponde 503, come il
 * pattern `cron not configured` di automations. Il default implicito
 * sarebbe la scelta sbagliata in entrambe le direzioni: cancellare
 * senza che nessuno l'abbia chiesto, o tenere per sempre credendo di
 * cancellare.
 */
export function retentionCutoff(
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): string | null {
  const raw = env.MESSAGE_RETENTION_MONTHS;
  if (!raw) return null;
  const months = Number(raw);
  if (!Number.isInteger(months) || months <= 0) return null;
  const cutoff = new Date(now);
  const giorno = cutoff.getUTCDate();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  // setUTCMonth normalizza il giorno inesistente IN AVANTI (31 marzo - 1
  // mese -> 3 marzo): cancellerebbe PRIMA del termine. La direzione
  // conservativa è l'ultimo giorno del mese inteso (review M1).
  if (cutoff.getUTCDate() !== giorno) cutoff.setUTCDate(0);
  return cutoff.toISOString();
}
