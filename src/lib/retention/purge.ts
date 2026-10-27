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
 * Un oggetto può però essere CONDIVISO: il media di testata di un
 * template viene persistito con lo stesso URL in ogni messaggio inviato
 * (send-message.ts, meta-send.ts) e nella riga del template stesso
 * (review C1). Prima della remove si verifica che nessun referente VIVO
 * resti: altri `messages` fuori dal batch o `message_templates`.
 * Se sì, si cancellano solo le righe scadute — l'oggetto cade quando
 * scade l'ultimo referente.
 *
 * La decorrenza è `messages.created_at` — la data del dato, non
 * l'orologio di quando la riga è ricomparsa (un restore da backup
 * rientra da solo nel purge).
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
  /** Valorizzato se una passata è fallita (I5): la route lo propaga come 500. */
  error?: string;
}

const PUBLIC_MARKER = `/storage/v1/object/public/${MIRROR_BUCKET}/`;

/** Le delete viaggiano a chunk: 500 UUID in query string sfiorano i limiti dei proxy (V2). */
const DELETE_CHUNK = 100;

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

/**
 * True se l'URL ha referenti VIVI oltre alle `inBatch` righe scadute:
 * altri messaggi (conteggio totale > batch) o la testata di un template.
 * In caso di dubbio (errore di verifica) risponde true: l'oggetto resta
 * e le righe con esso — un giro dopo si riprova con la verità in mano.
 */
async function hasLiveReferences(
  db: SupabaseClient,
  url: string,
  inBatch: number,
): Promise<boolean | 'unknown'> {
  const { count, error } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('media_url', url);
  if (error || count === null) return 'unknown';
  if (count > inBatch) return true;

  const { data, error: tplError } = await db
    .from('message_templates')
    .select('id')
    .eq('header_media_url', url)
    .limit(1);
  if (tplError) return 'unknown';
  return (data?.length ?? 0) > 0;
}

export async function purgeExpiredMessages(
  deps: PurgeDeps,
  opts: { cutoffIso: string; batch?: number },
): Promise<PurgeResult> {
  const { db, storage } = deps;
  const batch = opts.batch ?? 500;
  const esito: PurgeResult = { deleted: 0, storageRemoved: 0, storageFailures: 0 };

  const { data, error } = await db
    .from('messages')
    .select('id, media_url')
    .lt('created_at', opts.cutoffIso)
    .order('created_at', { ascending: true })
    .limit(batch);
  if (error) {
    esito.error = `select messaggi scaduti fallita: ${error.message}`;
    console.warn(`[retention] ${esito.error}`);
    return esito;
  }
  const rows = (data ?? []) as Array<{ id: string; media_url: string | null }>;
  if (rows.length === 0) return esito;

  // Raggruppa per URL: la decisione sull'oggetto è una sola anche se
  // dieci righe scadute lo condividono.
  const deletable: string[] = [];
  const byUrl = new Map<string, { path: string; ids: string[] }>();
  for (const row of rows) {
    const path = chatMediaPathFromUrl(row.media_url);
    if (!path) {
      deletable.push(row.id);
      continue;
    }
    const group = byUrl.get(row.media_url as string) ?? { path, ids: [] };
    group.ids.push(row.id);
    byUrl.set(row.media_url as string, group);
  }

  for (const [url, group] of byUrl) {
    const referenced = await hasLiveReferences(db, url, group.ids.length);
    if (referenced === 'unknown') {
      // Verifica fallita: non si cancella né l'oggetto né le righe —
      // cancellare le righe orfanerebbe l'oggetto per sempre.
      esito.storageFailures += 1;
      continue;
    }
    if (referenced) {
      deletable.push(...group.ids); // le righe scadute cadono, l'oggetto vive col suo ultimo referente
      continue;
    }
    const { error: removeError } = await storage.from(MIRROR_BUCKET).remove([group.path]);
    if (removeError) {
      console.warn(
        `[retention] remove Storage fallita per ${group.path}: ${removeError.message} — righe conservate, si ritenta al prossimo giro`,
      );
      esito.storageFailures += 1;
      continue;
    }
    esito.storageRemoved += 1;
    deletable.push(...group.ids);
  }

  for (let i = 0; i < deletable.length; i += DELETE_CHUNK) {
    const chunk = deletable.slice(i, i + DELETE_CHUNK);
    const { error: deleteError } = await db.from('messages').delete().in('id', chunk);
    if (deleteError) {
      esito.error = `delete messaggi fallita: ${deleteError.message}`;
      console.warn(`[retention] ${esito.error}`);
      continue; // gli altri chunk si tentano comunque
    }
    esito.deleted += chunk.length;
  }
  return esito;
}
