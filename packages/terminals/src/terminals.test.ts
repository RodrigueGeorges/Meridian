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

describe('pilote nexo : ce que la caisse n\'a plus à gérer', () => {
  type Body = { SaleToPOIRequest: { MessageHeader: { MessageCategory: string } } };
  const category = (init?: RequestInit) => (JSON.parse(String(init?.body)) as Body).SaleToPOIRequest.MessageHeader.MessageCategory;

  it('réponse de paiement perdue : TransactionStatus répété jusqu\'à l\'issue, un seul débit', async () => {
    const slow = await startTerminalSims({ delayMs: 300 });
    try {
      // La demande part au terminal, mais la caisse ne reçoit jamais la réponse.
      const lossy: typeof fetch = async (url, init) => {
        if (category(init) !== 'Payment') return fetch(url, init);
        void fetch(url, init).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 30));
        throw new Error('socket hang up');
      };
      const d = new NexoDriver({ url: slow.nexo.url, poiId: 'tpe', fetcher: lossy, pollMs: 50, recoverMs: 5000 });
      const res = await d.pay({ reference: 'NX-LOST', amount: 1890, currency: 'EUR' });
      expect(res.state).toBe('authorized');
      expect(slow.nexo.sim.debits()).toBe(1);
    } finally { await slow.close(); }
  });

  it('demande jamais arrivée : NotFound = refus certain, aucun débit', async () => {
    const dropped: typeof fetch = async (url, init) => {
      if (category(init) === 'Payment') throw new Error('socket hang up');
      return fetch(url, init);
    };
    const before = sims.nexo.sim.debits();
    const d = new NexoDriver({ url: sims.nexo.url, poiId: 'tpe', fetcher: dropped, pollMs: 20 });
    expect(await d.pay({ reference: 'NX-NEVER', amount: 700, currency: 'EUR' })).toMatchObject({ state: 'declined', detail: 'terminal_not_received' });
    expect(sims.nexo.sim.debits() - before).toBe(0);
  });

  it('terminal occupé par une autre caisse : refus certain « terminal_busy », l\'autre paiement continue', async () => {
    const slow = await startTerminalSims({ delayMs: 300 });
    try {
      const a = new NexoDriver({ url: slow.nexo.url, poiId: 'tpe', saleId: 'CAISSE-A' });
      const s = new TerminalService(new NexoDriver({ url: slow.nexo.url, poiId: 'tpe', saleId: 'CAISSE-B' }));
      const first = a.pay({ reference: 'NX-A', amount: 1000, currency: 'EUR' });
      await new Promise((r) => setTimeout(r, 50));
      await s.handle('POST', '/terminal/payments', { reference: 'NX-B', amount: 2000, currency: 'EUR' });
      await new Promise((r) => setTimeout(r, 50));
      expect((await s.handle('GET', '/terminal/payments/NX-B', undefined)).body).toMatchObject({ state: 'declined', detail: 'terminal_busy' });
      expect((await first).state).toBe('authorized');
      expect(slow.nexo.sim.debits()).toBe(1);
    } finally { await slow.close(); }
  });

  it('session : Login avant le premier ordre, rouverte si le terminal a redémarré', async () => {
    let logged = false, logins = 0;
    const strict: typeof fetch = async (url, init) => {
      const cat = category(init);
      if (cat === 'Login') { logged = true; logins++; }
      if (cat === 'Payment' && !logged) {
        const h = (JSON.parse(String(init?.body)) as { SaleToPOIRequest: { MessageHeader: Record<string, string> } }).SaleToPOIRequest.MessageHeader;
        return new Response(JSON.stringify({ SaleToPOIResponse: { MessageHeader: { ...h, MessageType: 'Response' }, PaymentResponse: { Response: { Result: 'Failure', ErrorCondition: 'LoggedOut' } } } }));
      }
      return fetch(url, init);
    };
    const d = new NexoDriver({ url: sims.nexo.url, poiId: 'tpe', session: true, fetcher: strict });
    expect((await d.pay({ reference: 'NX-S1', amount: 500, currency: 'EUR' })).state).toBe('authorized');
    logged = false; // le terminal redémarre et oublie la session
    expect((await d.pay({ reference: 'NX-S2', amount: 600, currency: 'EUR' })).state).toBe('authorized');
    expect(logins).toBe(2);
  });

  it('mauvais terminal (POIID inattendu) : détecté avant tout paiement', async () => {
    const d = new NexoDriver({ url: sims.nexo.url, poiId: 'tpe-caisse-2', session: true, fetcher: async (url, init) => {
      const r = await fetch(url, init);
      const j = await r.json() as { SaleToPOIResponse: { MessageHeader: { POIID: string } } };
      j.SaleToPOIResponse.MessageHeader.POIID = 'tpe-caisse-1';
      return new Response(JSON.stringify(j));
    } });
    await expect(d.pay({ reference: 'NX-SWAP', amount: 500, currency: 'EUR' })).rejects.toMatchObject({ beforeSend: true, code: 'terminal_mismatch' });
    expect(await d.health()).toBe(false);
  });
});

describe('démo terminal du site', () => {
  it('réponse perdue : un seul ordre au TPE, un seul débit ; terminal occupé : aucun débit', async () => {
    const { runTerminalDemo } = await import('./demo.ts');
    const lost = await runTerminalDemo({ mode: 'cloud', incident: 'lost_reply', cardMs: 200 });
    expect(lost).toMatchObject({ state: 'authorized', orders: 1, debits: 1 });
    expect(lost.steps.map((s) => s.kind)).toContain('reply_lost');
    const busy = await runTerminalDemo({ mode: 'local', incident: 'busy', cardMs: 300 });
    expect(busy).toMatchObject({ state: 'declined', detail: 'terminal_busy', debits: 0 });
  });
});
