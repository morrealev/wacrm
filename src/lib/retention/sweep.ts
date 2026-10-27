import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Seconda passata della retention (ROPA T-05, DEC-2026-10-27-002): dopo
 * il purge dei messaggi restano due code di dati personali che nessuno
 * vede più dall'inbox:
 *
 * - conversazioni rimaste SENZA messaggi: la riga porta ancora
 *   `last_message_text` (contenuto!) e i metadati del rapporto;
 * - contatti senza più alcuna conversazione: nome e numero di qualcuno
 *   con cui non parliamo da oltre il termine.
 *
 * Criterio ratificato: oltre 24 mesi (conversazioni: `last_message_at`;
 * contatti: `updated_at`) E nessun residuo collegato. Le conversazioni
 * con `last_message_at` NULL (mai partite) non rientrano nel criterio
 * `lt` e restano: sono prive di contenuto e il contatto a monte verrà
 * comunque raccolto qui quando invecchia... ma solo se anche la
 * conversazione sparisce — per questo il caso è dichiarato nel ROPA, non
 * nascosto qui.
 */

const BATCH = 500;

/** Cancella le conversazioni oltre cutoff rimaste senza messaggi. Torna quante. */
export async function sweepEmptyConversations(
  db: SupabaseClient,
  cutoffIso: string,
): Promise<number> {
  const { data: candidates, error } = await db
    .from('conversations')
    .select('id')
    .lt('last_message_at', cutoffIso)
    .limit(BATCH);
  if (error) {
    console.warn('[retention] select conversazioni scadute fallita:', error.message);
    return 0;
  }
  const ids = (candidates ?? []).map((c) => (c as { id: string }).id);
  if (ids.length === 0) return 0;

  const { data: residui, error: resErr } = await db
    .from('messages')
    .select('conversation_id')
    .in('conversation_id', ids);
  if (resErr) {
    console.warn('[retention] verifica residui messaggi fallita:', resErr.message);
    return 0;
  }
  const occupate = new Set(
    (residui ?? []).map((m) => (m as { conversation_id: string }).conversation_id),
  );
  const svuotate = ids.filter((id) => !occupate.has(id));
  if (svuotate.length === 0) return 0;

  const { error: delErr } = await db.from('conversations').delete().in('id', svuotate);
  if (delErr) {
    console.warn('[retention] delete conversazioni fallita:', delErr.message);
    return 0;
  }
  return svuotate.length;
}

/** Cancella i contatti oltre cutoff senza più conversazioni. Torna quanti. */
export async function sweepOrphanContacts(
  db: SupabaseClient,
  cutoffIso: string,
): Promise<number> {
  const { data: candidates, error } = await db
    .from('contacts')
    .select('id')
    .lt('updated_at', cutoffIso)
    .limit(BATCH);
  if (error) {
    console.warn('[retention] select contatti scaduti fallita:', error.message);
    return 0;
  }
  const ids = (candidates ?? []).map((c) => (c as { id: string }).id);
  if (ids.length === 0) return 0;

  const { data: refs, error: refErr } = await db
    .from('conversations')
    .select('contact_id')
    .in('contact_id', ids);
  if (refErr) {
    console.warn('[retention] verifica conversazioni dei contatti fallita:', refErr.message);
    return 0;
  }
  const occupati = new Set(
    (refs ?? [])
      .map((r) => (r as { contact_id: string | null }).contact_id)
      .filter((v): v is string => v !== null),
  );
  const orfani = ids.filter((id) => !occupati.has(id));
  if (orfani.length === 0) return 0;

  const { error: delErr } = await db.from('contacts').delete().in('id', orfani);
  if (delErr) {
    console.warn('[retention] delete contatti fallita:', delErr.message);
    return 0;
  }
  return orfani.length;
}
