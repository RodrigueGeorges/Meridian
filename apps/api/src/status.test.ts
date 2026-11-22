import { describe, expect, it } from 'vitest';
import { StatusBoard } from './status.ts';

describe('statut public des PSP', () => {
  const mods = [{ id: 'a', name: 'PSP A' }, { id: 'b', name: 'PSP B' }];
  const now = Date.parse('2026-11-23T12:30:00Z');
  it('rien sous 20 paiements, taux et délai ensuite, jamais de volume', async () => {
    const s = new StatusBoard();
    for (let i = 0; i < 19; i++) await s.record('a', true, 2000, now);
    let [a] = await s.snapshot(mods, now);
    expect(a).toMatchObject({ state: 'no_data', availability24h: null, avgSeconds24h: null });
    await s.record('a', true, 4000, now + 1);
    [a] = await s.snapshot(mods, now + 60_000);
    expect(a).toMatchObject({ state: 'operational', availability24h: 100, avgSeconds24h: 2.1 });
    expect(a!.hours).toHaveLength(24);
    expect(a!.hours[23]).toBe(100);
    expect(JSON.stringify(a)).not.toMatch(/"(ok|ko|count|volume)"/);
  });
  it('échecs et bascules font baisser le taux ; dernière heure sous 50 % = ne répond pas', async () => {
    const s = new StatusBoard();
    for (let i = 0; i < 30; i++) await s.record('b', true, 1000, now - 3 * 3_600_000);
    for (let i = 0; i < 10; i++) await s.record('b', false, 0, now);
    const [, b] = await s.snapshot(mods, now);
    expect(b!.availability24h).toBe(75);
    expect(b!.state).toBe('down');
  });
});
