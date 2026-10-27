import { describe, it, expect } from 'vitest';
import { retentionCutoff } from './config';

const NOW = new Date('2026-10-27T12:00:00.000Z');

describe('retentionCutoff', () => {
  it('24 mesi -> cutoff due anni indietro, stesso istante', () => {
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: '24' }, NOW)).toBe(
      '2024-10-27T12:00:00.000Z',
    );
  });
  it('variabile assente o vuota -> null (opt-in esplicito, niente default)', () => {
    expect(retentionCutoff({}, NOW)).toBeNull();
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: '' }, NOW)).toBeNull();
  });
  it('M1: fine mese senza rollover in avanti — clampa all ultimo giorno del mese inteso', () => {
    // 31 marzo - 1 mese: setUTCMonth nudo darebbe 3 marzo (cancella PRIMA del termine);
    // la direzione conservativa è 28 febbraio.
    expect(
      retentionCutoff({ MESSAGE_RETENTION_MONTHS: '1' }, new Date('2026-03-31T12:00:00.000Z')),
    ).toBe('2026-02-28T12:00:00.000Z');
  });
  it('valori non utilizzabili -> null: 0, negativi, non numerici, frazionari', () => {
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: '0' }, NOW)).toBeNull();
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: '-6' }, NOW)).toBeNull();
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: 'abc' }, NOW)).toBeNull();
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: '1.5' }, NOW)).toBeNull();
  });
});
