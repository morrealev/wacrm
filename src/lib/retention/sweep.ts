import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Seconda passata della retention (ROPA T-05, DEC-2026-10-27-002): le
 * conversazioni rimaste senza messaggi (la riga porta ancora
 * `last_message_text` — contenuto) e i contatti senza più conversazioni.
 *
 * Dopo la review del branch (I1-I4) la logica vive in due RPC SQL
 * (migration 061) come UNA delete atomica con i predicati ri-asseriti
 * dentro il `WHERE ... NOT EXISTS`:
 *
 * - niente cap PostgREST sulla verifica dei residui (I1): il NOT EXISTS
 *   è valutato dal planner, non da una select troncabile a max-rows;
 * - niente TOCTOU (I3): verifica e delete sono lo stesso statement;
 * - le FK non possono far fallire il batch (I2): una conversazione
 *   agganciata a un deal è ESCLUSA dal where, non incontrata dalla FK;
 * - il perimetro resta quello ratificato (I4): contatti con deal o con
 *   note NON si toccano — i loro termini sono «da definire» (gate
 *   Piruzza), quindi lo sweep non li decide per cascata.
 *
 * Questi wrapper restano sottili apposta: contratto (nome, parametro,
 * conteggio, errore) testato a fake; la semantica SQL è collaudata live
 * iniettando righe scadute, residue e agganciate.
 */

export type SweepResult = { deleted: number; error?: string };

export async function sweepEmptyConversations(
  db: SupabaseClient,
  cutoffIso: string,
): Promise<SweepResult> {
  const { data, error } = await db.rpc('retention_sweep_conversations', { cutoff: cutoffIso });
  if (error) {
    console.warn('[retention] sweep conversazioni fallito:', error.message);
    return { deleted: 0, error: `sweep conversazioni: ${error.message}` };
  }
  return { deleted: (data as number | null) ?? 0 };
}

export async function sweepOrphanContacts(
  db: SupabaseClient,
  cutoffIso: string,
): Promise<SweepResult> {
  const { data, error } = await db.rpc('retention_sweep_contacts', { cutoff: cutoffIso });
  if (error) {
    console.warn('[retention] sweep contatti fallito:', error.message);
    return { deleted: 0, error: `sweep contatti: ${error.message}` };
  }
  return { deleted: (data as number | null) ?? 0 };
}
