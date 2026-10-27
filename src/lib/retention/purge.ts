import type { SupabaseClient } from '@supabase/supabase-js';
import { MIRROR_BUCKET } from '@/lib/whatsapp/mirror-inbound-media';

/**
 * Retention dei messaggi (ROPA T-05, DEC-2026-10-27-002): cancella i
 * messaggi più vecchi del cutoff, rimuovendo PRIMA l'eventuale copia del
 * media in `chat-media`. L'ordine è il punto: cancellare la riga e poi
 * fallire sullo Storage lascerebbe un orfano di dati personali che
 * nessun giro successivo saprebbe più ritrovare. Quindi: se la remove
 * fallisce, la riga resta e il giro successivo riprova.
 *
 * Il chiamante (route cron) passa un cutoff già calcolato: la decorrenza
 * è `messages.created_at` — la data del dato, non l'orologio di quando
 * la riga è ricomparsa (un restore da backup rientra da solo nel purge).
 */

/** Superficie Storage minima, fake-abile nei test (stesso pattern di MirrorStorage). */
export interface RetentionStorage {
  from(bucket: string): {
    remove(paths: string[]): Promise<{ error: { message: string } | null }>;
  };
}

export interface PurgeDeps {
  /** Client service-role: il purge bypassa RLS per costruzione. */
  db: SupabaseClient;
  storage: RetentionStorage;
}

export interface PurgeResult {
  deleted: number;
  storageRemoved: number;
  storageFailures: number;
}

const PUBLIC_MARKER = `/storage/v1/object/public/${MIRROR_BUCKET}/`;

/**
 * Path dentro `chat-media` di un `media_url`, o `null` per tutto il
 * resto (proxy URL `/api/whatsapp/media/...`, altri bucket, null): in
 * quei casi non c'è nessun oggetto nostro da rimuovere.
 */
export function chatMediaPathFromUrl(mediaUrl: string | null): string | null {
  if (!mediaUrl) return null;
  const idx = mediaUrl.indexOf(PUBLIC_MARKER);
  if (idx === -1) return null;
  const raw = mediaUrl.slice(idx + PUBLIC_MARKER.length).split(/[?#]/)[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function purgeExpiredMessages(
  deps: PurgeDeps,
  opts: { cutoffIso: string; batch?: number },
): Promise<PurgeResult> {
  const { db, storage } = deps;
  const batch = opts.batch ?? 500;

  const { data, error } = await db
    .from('messages')
    .select('id, media_url')
    .lt('created_at', opts.cutoffIso)
    .order('created_at', { ascending: true })
    .limit(batch);
  if (error) {
    console.warn('[retention] select messaggi scaduti fallita:', error.message);
    return { deleted: 0, storageRemoved: 0, storageFailures: 0 };
  }
  const rows = (data ?? []) as Array<{ id: string; media_url: string | null }>;
  if (rows.length === 0) return { deleted: 0, storageRemoved: 0, storageFailures: 0 };

  const deletable: string[] = [];
  let storageRemoved = 0;
  let storageFailures = 0;

  for (const row of rows) {
    const path = chatMediaPathFromUrl(row.media_url);
    if (!path) {
      deletable.push(row.id);
      continue;
    }
    // Una remove per riga, non in blocco: così un solo oggetto
    // indisponibile non tiene in ostaggio l'intero batch.
    const { error: removeError } = await storage.from(MIRROR_BUCKET).remove([path]);
    if (removeError) {
      console.warn(
        `[retention] remove Storage fallita per ${path} (riga ${row.id}): ${removeError.message} — riga conservata, si ritenta al prossimo giro`,
      );
      storageFailures++;
      continue;
    }
    storageRemoved++;
    deletable.push(row.id);
  }

  if (deletable.length === 0) return { deleted: 0, storageRemoved, storageFailures };

  const { error: deleteError } = await db.from('messages').delete().in('id', deletable);
  if (deleteError) {
    console.warn('[retention] delete messaggi fallita:', deleteError.message);
    return { deleted: 0, storageRemoved, storageFailures };
  }
  return { deleted: deletable.length, storageRemoved, storageFailures };
}
