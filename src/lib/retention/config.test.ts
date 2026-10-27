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
  it('valori non utilizzabili -> null: 0, negativi, non numerici, frazionari', () => {
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: '0' }, NOW)).toBeNull();
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: '-6' }, NOW)).toBeNull();
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: 'abc' }, NOW)).toBeNull();
    expect(retentionCutoff({ MESSAGE_RETENTION_MONTHS: '1.5' }, NOW)).toBeNull();
  });
});
