import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaisseApDriver, NexoDriver, startTerminalSims, TerminalService, ZvtDriver, type TerminalDriver } from './index.ts';

let sims: Awaited<ReturnType<typeof startTerminalSims>>;
beforeAll(async () => { sims = await startTerminalSims(); });
afterAll(async () => { await sims.close(); });

const drivers = (): [string, TerminalDriver, () => number][] => [
  ['Caisse-AP', new CaisseApDriver({ host: '127.0.0.1', port: sims.caisseAp.port, timeoutMs: 5000 }), sims.caisseAp.sim.debits],
  ['ZVT', new ZvtDriver({ host: '127.0.0.1', port: sims.zvt.port, timeoutMs: 5000 }), sims.zvt.sim.debits],
  ['nexo', new NexoDriver({ url: sims.nexo.url, poiId: 'tpe', timeoutMs: 5000 }), sims.nexo.sim.debits],
];

describe('pilotes de terminaux côté caisse', () => {
  it('autorisé, refusé, remboursé, terminal répond — pour chaque protocole', async () => {
    for (const [name, d, debits] of drivers()) {
      const before = debits();
      const ok = await d.pay({ reference: `${name}-OK`, amount: 2450, currency: 'EUR' });
      expect(ok.state, name).toBe('authorized');
      expect(debits() - before, name).toBe(1);
      const ko = await d.pay({ reference: `${name}-KO`, amount: 1013, currency: 'EUR' });
      expect(ko.state, name).toBe('declined');
      expect(await d.refund({ reference: `${name}-OK`, amount: 450, currency: 'EUR', terminalRef: ok.terminalRef, originalAmount: 2450 }), name).toBe('done');
      expect(await d.health(), name).toBe(true);
    }
  });
  it('abandon au terminal = annulé', async () => {
    for (const [name, d] of drivers()) expect((await d.pay({ reference: `${name}-AB`, amount: 1066, currency: 'EUR' })).state, name).toBe('cancelled');
  });
  it('terminal éteint : refus certain, rien envoyé', async () => {
    const off = new ZvtDriver({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    await expect(off.pay({ reference: 'X', amount: 100, currency: 'EUR' })).rejects.toMatchObject({ beforeSend: true });
    expect(await off.health()).toBe(false);
  });
});

describe('service terminal de l\'agent', () => {
  const wait = async (s: TerminalService, ref: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await s.handle('GET', `/terminal/payments/${ref}`, undefined);
      if ((r.body as { state: string }).state !== 'pending') return r.body as Record<string, unknown>;
      await new Promise((x) => setTimeout(x, 20));
    }
    throw new Error('délai');
  };
  it('idempotent par référence : rejouer ne relance jamais le terminal', async () => {
    const s = new TerminalService(new ZvtDriver({ host: '127.0.0.1', port: sims.zvt.port }));
    const before = sims.zvt.sim.debits();
    const a = await s.handle('POST', '/terminal/payments', { reference: 'IDEM-1', amount: 990, currency: 'EUR' });
    const b = await s.handle('POST', '/terminal/payments', { reference: 'IDEM-1', amount: 990, currency: 'EUR' });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect((await s.handle('POST', '/terminal/payments', { reference: 'IDEM-1', amount: 991, currency: 'EUR' })).status).toBe(409);
    expect(await wait(s, 'IDEM-1')).toMatchObject({ state: 'authorized' });
    expect(s.sent).toBe(1);
    expect(sims.zvt.sim.debits() - before).toBe(1);
    const r1 = await s.handle('POST', '/terminal/payments/IDEM-1/refunds', { amount: 990, number: 1 });
    const r2 = await s.handle('POST', '/terminal/payments/IDEM-1/refunds', { amount: 990, number: 1 });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect((r2.body as { refunded: number }).refunded).toBe(990);
  });
  it('journal sur disque : après redémarrage, un paiement interrompu reste « en cours », jamais relancé', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'edge-')), 'terminal.json');
    const s1 = new TerminalService(new CaisseApDriver({ host: '127.0.0.1', port: sims.caisseAp.port }), file);
    await s1.handle('POST', '/terminal/payments', { reference: 'RST-1', amount: 1200, currency: 'EUR' });
    // redémarrage immédiat, pendant l'autorisation
    const s2 = new TerminalService(new CaisseApDriver({ host: '127.0.0.1', port: sims.caisseAp.port }), file);
    const again = await s2.handle('POST', '/terminal/payments', { reference: 'RST-1', amount: 1200, currency: 'EUR' });
    expect(again.body).toMatchObject({ state: 'pending', detail: 'agent_restarted' });
    expect(s2.sent).toBe(0);
  });
  it('un seul paiement à la fois par terminal ; annulation impossible en Caisse-AP signalée', async () => {
    const s = new TerminalService(new CaisseApDriver({ host: '127.0.0.1', port: sims.caisseAp.port }));
    await s.handle('POST', '/terminal/payments', { reference: 'B-1', amount: 500, currency: 'EUR' });
    expect((await s.handle('POST', '/terminal/payments', { reference: 'B-2', amount: 500, currency: 'EUR' })).status).toBe(409);
    expect((await s.handle('POST', '/terminal/payments/B-1/cancel', {})).status).toBe(409);
    await wait(s, 'B-1');
  });
});
