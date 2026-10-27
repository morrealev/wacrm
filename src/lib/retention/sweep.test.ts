import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sweepEmptyConversations, sweepOrphanContacts } from './sweep';

const CUTOFF = '2024-10-27T00:00:00.000Z';

/**
 * Dopo la review (I1 cap PostgREST, I2 FK deals, I3 TOCTOU, I4 cascate):
 * lo sweep è una RPC SQL atomica con NOT EXISTS ri-asserito nella DELETE.
 * Qui si verifica il contratto del wrapper: nome funzione, parametro,
 * conteggio, propagazione dell'errore (I5).
 */
function fakeRpc(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const db = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return results[fn] ?? { data: null, error: { message: `rpc inattesa: ${fn}` } };
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe('sweepEmptyConversations', () => {
  it('chiama la RPC atomica col cutoff e torna il conteggio', async () => {
    const { db, calls } = fakeRpc({
      retention_sweep_conversations: { data: 3, error: null },
    });
    const esito = await sweepEmptyConversations(db, CUTOFF);
    expect(esito).toEqual({ deleted: 3 });
    expect(calls).toEqual([
      { fn: 'retention_sweep_conversations', args: { cutoff: CUTOFF } },
    ]);
  });

  it('I5: errore RPC -> deleted 0 e error valorizzato', async () => {
    const { db } = fakeRpc({
      retention_sweep_conversations: { data: null, error: { message: 'boom' } },
    });
    const esito = await sweepEmptyConversations(db, CUTOFF);
    expect(esito.deleted).toBe(0);
    expect(esito.error).toMatch(/boom/);
  });
});

describe('sweepOrphanContacts', () => {
  it('chiama la RPC atomica col cutoff e torna il conteggio', async () => {
    const { db, calls } = fakeRpc({
      retention_sweep_contacts: { data: 1, error: null },
    });
    const esito = await sweepOrphanContacts(db, CUTOFF);
    expect(esito).toEqual({ deleted: 1 });
    expect(calls).toEqual([{ fn: 'retention_sweep_contacts', args: { cutoff: CUTOFF } }]);
  });

  it('I5: errore RPC -> deleted 0 e error valorizzato', async () => {
    const { db } = fakeRpc({
      retention_sweep_contacts: { data: null, error: { message: 'kaboom' } },
    });
    const esito = await sweepOrphanContacts(db, CUTOFF);
    expect(esito.deleted).toBe(0);
    expect(esito.error).toMatch(/kaboom/);
  });
});
