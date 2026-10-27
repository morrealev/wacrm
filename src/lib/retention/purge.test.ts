import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  chatMediaPathFromUrl,
  purgeExpiredMessages,
  type RetentionStorage,
} from './purge';

const CUTOFF = '2024-10-27T00:00:00.000Z';
const OLD = '2024-01-01T00:00:00.000Z';
const RECENT = '2026-10-01T00:00:00.000Z';

const publicUrl = (path: string) =>
  `https://example.supabase.co/storage/v1/object/public/chat-media/${path}`;

type FakeRow = { id: string; media_url: string | null; created_at: string };

/**
 * Fake delle catene Supabase usate dal purge. `events` registra l'ordine
 * (remove PRIMA di delete) e le delete per misurare il chunking.
 * `templates` simula message_templates.header_media_url (review C1).
 */
function fakeDb(
  rows: FakeRow[],
  events: string[],
  opts: { templates?: string[]; failSelect?: boolean; failDelete?: boolean } = {},
) {
  let messages = [...rows];
  const db = {
    from(table: string) {
      return {
        select(cols: string, selectOpts?: { count?: string; head?: boolean }) {
          if (table === 'messages' && selectOpts?.count === 'exact') {
            return {
              eq: async (_col: string, url: string) => ({
                count: messages.filter((m) => m.media_url === url).length,
                error: null,
              }),
            };
          }
          if (table === 'message_templates') {
            return {
              eq(_col: string, url: string) {
                return {
                  limit: async (_n: number) => ({
                    data: (opts.templates ?? []).includes(url) ? [{ id: 't1' }] : [],
                    error: null,
                  }),
                };
              },
            };
          }
          if (table === 'messages') {
            return {
              lt(_col: string, cutoff: string) {
                return {
                  order(_c: string, _o: { ascending: boolean }) {
                    return {
                      limit: async (n: number) => {
                        if (opts.failSelect) return { data: null, error: { message: 'select boom' } };
                        return {
                          data: messages
                            .filter((m) => m.created_at < cutoff)
                            .slice(0, n)
                            .map(({ id, media_url }) => ({ id, media_url })),
                          error: null,
                        };
                      },
                    };
                  },
                };
              },
            };
          }
          throw new Error(`select su tabella inattesa: ${table}/${cols}`);
        },
        delete() {
          return {
            in: async (_col: string, ids: string[]) => {
              if (opts.failDelete) return { error: { message: 'delete boom' } };
              events.push(`delete:${ids.length}`);
              messages = messages.filter((m) => !ids.includes(m.id));
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, remaining: () => messages };
}

function fakeStorage(events: string[], failPaths: Set<string> = new Set()) {
  const removed: string[] = [];
  const storage: RetentionStorage = {
    from(_bucket: string) {
      return {
        remove: async (paths: string[]) => {
          const p = paths[0];
          if (failPaths.has(p)) return { error: { message: 'storage boom' } };
          events.push(`remove:${p}`);
          removed.push(...paths);
          return { error: null };
        },
      };
    },
  };
  return { storage, removed };
}

describe('chatMediaPathFromUrl', () => {
  it('estrae il path solo dagli URL pubblici del bucket chat-media', () => {
    expect(chatMediaPathFromUrl(publicUrl('account-1/inbound/123-img.jpg'))).toBe(
      'account-1/inbound/123-img.jpg',
    );
  });
  it('ignora i proxy URL e i null (nessuna chiamata Storage da fare)', () => {
    expect(chatMediaPathFromUrl('/api/whatsapp/media/12345')).toBeNull();
    expect(chatMediaPathFromUrl(null)).toBeNull();
  });
  it('ignora gli URL di altri bucket', () => {
    expect(
      chatMediaPathFromUrl(
        'https://example.supabase.co/storage/v1/object/public/avatars/a.png',
      ),
    ).toBeNull();
  });
});

describe('purgeExpiredMessages', () => {
  it('cancella i messaggi oltre cutoff e lascia intatti i recenti', async () => {
    const events: string[] = [];
    const { db, remaining } = fakeDb(
      [
        { id: 'a', media_url: null, created_at: OLD },
        { id: 'b', media_url: null, created_at: OLD },
        { id: 'c', media_url: null, created_at: RECENT },
      ],
      events,
    );
    const { storage } = fakeStorage(events);
    const esito = await purgeExpiredMessages({ db, storage }, { cutoffIso: CUTOFF });
    expect(esito).toEqual({ deleted: 2, storageRemoved: 0, storageFailures: 0 });
    expect(remaining().map((m) => m.id)).toEqual(['c']);
  });

  it('media NON referenziato altrove: PRIMA la remove, POI la delete della riga', async () => {
    const events: string[] = [];
    const path = 'account-1/inbound/777-doc.pdf';
    const { db } = fakeDb(
      [{ id: 'm1', media_url: publicUrl(path), created_at: OLD }],
      events,
    );
    const { storage, removed } = fakeStorage(events);
    const esito = await purgeExpiredMessages({ db, storage }, { cutoffIso: CUTOFF });
    expect(esito).toEqual({ deleted: 1, storageRemoved: 1, storageFailures: 0 });
    expect(removed).toEqual([path]);
    expect(events).toEqual([`remove:${path}`, 'delete:1']);
  });

  it('C1: media condiviso con un messaggio RECENTE -> righe scadute cancellate, oggetto CONSERVATO', async () => {
    const events: string[] = [];
    const path = 'account-1/inbound/condiviso.png';
    const url = publicUrl(path);
    const { db, remaining } = fakeDb(
      [
        { id: 'v1', media_url: url, created_at: OLD },
        { id: 'v2', media_url: url, created_at: OLD },
        { id: 'r1', media_url: url, created_at: RECENT },
      ],
      events,
    );
    const { storage, removed } = fakeStorage(events);
    const esito = await purgeExpiredMessages({ db, storage }, { cutoffIso: CUTOFF });
    expect(esito).toEqual({ deleted: 2, storageRemoved: 0, storageFailures: 0 });
    expect(removed).toEqual([]); // l'oggetto cade quando scade l'ULTIMO referente
    expect(remaining().map((m) => m.id)).toEqual(['r1']);
  });

  it('C1: media usato come testata di un template -> oggetto CONSERVATO, riga cancellata', async () => {
    const events: string[] = [];
    const path = 'account-1/inbound/testata-template.png';
    const url = publicUrl(path);
    const { db, remaining } = fakeDb(
      [{ id: 'v1', media_url: url, created_at: OLD }],
      events,
      { templates: [url] },
    );
    const { storage, removed } = fakeStorage(events);
    const esito = await purgeExpiredMessages({ db, storage }, { cutoffIso: CUTOFF });
    expect(esito).toEqual({ deleted: 1, storageRemoved: 0, storageFailures: 0 });
    expect(removed).toEqual([]);
    expect(remaining()).toHaveLength(0);
  });

  it('se la remove fallisce la riga RESTA (niente orfani) e il resto del batch prosegue', async () => {
    const events: string[] = [];
    const sfortunato = 'account-1/inbound/bad.bin';
    const { db, remaining } = fakeDb(
      [
        { id: 'ko', media_url: publicUrl(sfortunato), created_at: OLD },
        { id: 'ok', media_url: null, created_at: OLD },
      ],
      events,
    );
    const { storage } = fakeStorage(events, new Set([sfortunato]));
    const esito = await purgeExpiredMessages({ db, storage }, { cutoffIso: CUTOFF });
    expect(esito).toEqual({ deleted: 1, storageRemoved: 0, storageFailures: 1 });
    expect(remaining().map((m) => m.id)).toEqual(['ko']); // ritenta al giro dopo
  });

  it('V2: le delete viaggiano a chunk (max 100 id per chiamata)', async () => {
    const events: string[] = [];
    const tanti: FakeRow[] = Array.from({ length: 150 }, (_, i) => ({
      id: `r${i}`,
      media_url: null,
      created_at: OLD,
    }));
    const { db, remaining } = fakeDb(tanti, events);
    const { storage } = fakeStorage(events);
    const esito = await purgeExpiredMessages(
      { db, storage },
      { cutoffIso: CUTOFF, batch: 150 },
    );
    expect(esito.deleted).toBe(150);
    expect(remaining()).toHaveLength(0);
    const deletes = events.filter((e) => e.startsWith('delete:'));
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    for (const d of deletes) expect(Number(d.split(':')[1])).toBeLessThanOrEqual(100);
  });

  it('I5: select fallita -> error valorizzato, nessun conteggio truffaldino', async () => {
    const events: string[] = [];
    const { db } = fakeDb([], events, { failSelect: true });
    const { storage } = fakeStorage(events);
    const esito = await purgeExpiredMessages({ db, storage }, { cutoffIso: CUTOFF });
    expect(esito.deleted).toBe(0);
    expect(esito.error).toMatch(/select/);
  });

  it('I5: delete fallita -> error valorizzato', async () => {
    const events: string[] = [];
    const { db } = fakeDb([{ id: 'a', media_url: null, created_at: OLD }], events, {
      failDelete: true,
    });
    const { storage } = fakeStorage(events);
    const esito = await purgeExpiredMessages({ db, storage }, { cutoffIso: CUTOFF });
    expect(esito.deleted).toBe(0);
    expect(esito.error).toMatch(/delete/);
  });
});
