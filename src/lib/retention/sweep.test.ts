import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sweepEmptyConversations, sweepOrphanContacts } from './sweep';

const CUTOFF = '2024-10-27T00:00:00.000Z';
const OLD = '2024-01-01T00:00:00.000Z';
const RECENT = '2026-10-01T00:00:00.000Z';

type Conv = { id: string; last_message_at: string | null };
type Msg = { conversation_id: string };
type Contact = { id: string; updated_at: string };
type ConvRef = { contact_id: string | null };

/**
 * Fake delle sole catene usate dallo sweep: select+lt+limit (candidati
 * oltre soglia), select+in (residui) e delete+in. Registra le delete.
 */
function fakeDb(state: {
  conversations: Conv[];
  messages: Msg[];
  contacts: Contact[];
  convRefs: ConvRef[];
}) {
  const db = {
    from(table: string) {
      return {
        select(cols: string) {
          return {
            lt(_col: string, cutoff: string) {
              return {
                limit: async (n: number) => {
                  if (table === 'conversations') {
                    return {
                      data: state.conversations
                        .filter((c) => c.last_message_at !== null && c.last_message_at < cutoff)
                        .slice(0, n)
                        .map((c) => ({ id: c.id })),
                      error: null,
                    };
                  }
                  if (table === 'contacts') {
                    return {
                      data: state.contacts
                        .filter((c) => c.updated_at < cutoff)
                        .slice(0, n)
                        .map((c) => ({ id: c.id })),
                      error: null,
                    };
                  }
                  throw new Error(`select/lt su tabella inattesa: ${table}`);
                },
              };
            },
            in: async (_col: string, ids: string[]) => {
              if (table === 'messages' && cols === 'conversation_id') {
                return {
                  data: state.messages.filter((m) => ids.includes(m.conversation_id)),
                  error: null,
                };
              }
              if (table === 'conversations' && cols === 'contact_id') {
                return {
                  data: state.convRefs.filter(
                    (r) => r.contact_id !== null && ids.includes(r.contact_id),
                  ),
                  error: null,
                };
              }
              throw new Error(`select/in inatteso: ${table}.${cols}`);
            },
          };
        },
        delete() {
          return {
            in: async (_col: string, ids: string[]) => {
              if (table === 'conversations') {
                state.conversations = state.conversations.filter((c) => !ids.includes(c.id));
              } else if (table === 'contacts') {
                state.contacts = state.contacts.filter((c) => !ids.includes(c.id));
              } else {
                throw new Error(`delete su tabella inattesa: ${table}`);
              }
              return { error: null };
            },
          };
        },
      };
    },
  };
  return db as unknown as SupabaseClient;
}

describe('sweepEmptyConversations', () => {
  it('cancella la conversazione svuotata e vecchia; risparmia quelle con messaggi o recenti', async () => {
    const state = {
      conversations: [
        { id: 'vuota-vecchia', last_message_at: OLD },
        { id: 'con-residui', last_message_at: OLD },
        { id: 'vuota-recente', last_message_at: RECENT },
      ],
      messages: [{ conversation_id: 'con-residui' }],
      contacts: [],
      convRefs: [],
    };
    const n = await sweepEmptyConversations(fakeDb(state), CUTOFF);
    expect(n).toBe(1);
    expect(state.conversations.map((c) => c.id).sort()).toEqual([
      'con-residui',
      'vuota-recente',
    ]);
  });

  it('senza candidati non cancella nulla', async () => {
    const state = {
      conversations: [{ id: 'x', last_message_at: RECENT }],
      messages: [],
      contacts: [],
      convRefs: [],
    };
    expect(await sweepEmptyConversations(fakeDb(state), CUTOFF)).toBe(0);
    expect(state.conversations).toHaveLength(1);
  });
});

describe('sweepOrphanContacts', () => {
  it('cancella il contatto vecchio senza conversazioni; risparmia chi ne ha o è recente', async () => {
    const state = {
      conversations: [],
      messages: [],
      contacts: [
        { id: 'orfano-vecchio', updated_at: OLD },
        { id: 'con-conversazioni', updated_at: OLD },
        { id: 'orfano-recente', updated_at: RECENT },
      ],
      convRefs: [{ contact_id: 'con-conversazioni' }],
    };
    const n = await sweepOrphanContacts(fakeDb(state), CUTOFF);
    expect(n).toBe(1);
    expect(state.contacts.map((c) => c.id).sort()).toEqual([
      'con-conversazioni',
      'orfano-recente',
    ]);
  });
});
