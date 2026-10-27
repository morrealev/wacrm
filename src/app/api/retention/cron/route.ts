import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { retentionCutoff } from '@/lib/retention/config'
import { purgeExpiredMessages, type RetentionStorage } from '@/lib/retention/purge'
import { sweepEmptyConversations, sweepOrphanContacts } from '@/lib/retention/sweep'

/**
 * Retention giornaliera (ROPA T-05, DEC-2026-10-27-002): cancella i
 * messaggi oltre `MESSAGE_RETENTION_MONTHS` (media su Storage inclusi,
 * con guardia anti-orfani), poi le conversazioni rimaste vuote e i
 * contatti senza più conversazioni.
 *
 * Stesso contratto operativo di `/api/automations/cron`: schedulato da
 * un pinger esterno (crontab del VPS) con il segreto condiviso in
 * `x-cron-secret` = `AUTOMATION_CRON_SECRET` — un solo segreto da
 * ruotare per tutti i cron. 503 se manca la configurazione (segreto O
 * termine): la retention è opt-in esplicito, mai un default implicito.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cutoff = retentionCutoff(process.env)
  if (!cutoff) {
    return NextResponse.json({ error: 'retention not configured' }, { status: 503 })
  }

  const admin = supabaseAdmin()
  const storage: RetentionStorage = admin.storage

  const purge = await purgeExpiredMessages({ db: admin, storage }, { cutoffIso: cutoff })
  const conversationsDeleted = await sweepEmptyConversations(admin, cutoff)
  const contactsDeleted = await sweepOrphanContacts(admin, cutoff)

  return NextResponse.json({
    cutoff,
    deleted: purge.deleted,
    storageRemoved: purge.storageRemoved,
    storageFailures: purge.storageFailures,
    conversationsDeleted,
    contactsDeleted,
  })
}
