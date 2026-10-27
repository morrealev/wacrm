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
 * Fake minimale della catena Supabase usata dal purge. `events` registra
 * l'ordine delle operazioni, così si può asserire che lo Storage venga
 * ripulito PRIMA della cancellazione delle righe.
 */
function fakeDb(rows: FakeRow[], events: string[]) {
  let messages = [...rows];
  const db = {
    from(table: string) {
      if (table !== 'messages') throw new Error(`tabella inattesa: ${table}`);
      return {
        select(_cols: string) {
          return {
            lt(_col: string, cutoff: string) {
              return {
                order(_c: string, _o: { ascending: boolean }) {
                  return {
                    limit: async (n: number) => ({
                      data: messages
                        .filter((m) => m.created_at < cutoff)
                        .slice(0, n)
                        .map(({ id, media_url }) => ({ id, media_url })),
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
        delete() {
          return {
            in: async (_col: string, ids: string[]) => {
              events.push(`delete:${ids.slice().sort().join(',')}`);
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

  it('con media mirrorato: PRIMA la remove su Storage, POI la delete della riga', async () => {
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
    expect(events).toEqual([`remove:${path}`, 'delete:m1']);
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

  it('rispetta il cap di batch per invocazione', async () => {
    const events: string[] = [];
    const { db, remaining } = fakeDb(
      [
        { id: 'a', media_url: null, created_at: OLD },
        { id: 'b', media_url: null, created_at: OLD },
        { id: 'c', media_url: null, created_at: OLD },
      ],
      events,
    );
    const { storage } = fakeStorage(events);
    const esito = await purgeExpiredMessages(
      { db, storage },
      { cutoffIso: CUTOFF, batch: 2 },
    );
    expect(esito.deleted).toBe(2);
    expect(remaining()).toHaveLength(1);
  });
});
