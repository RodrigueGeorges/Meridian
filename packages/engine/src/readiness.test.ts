// Robustesse : rotation des clés du journal, gardes d'ajout, verrous de cluster perdus ou en échec.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSims } from '@meridian/sim';
import { BUILTIN_MODULES } from '@meridian/modules';
import type { JournalEntry } from '@meridian/core';
import { Engine, type Cluster, type EngineOptions } from './engine.ts';
import { Journal, MemoryStore } from './journal.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Faux cluster en mémoire : les verrous meurent avec la « connexion » (epoch++ les libère tous). */
class FakeCluster implements Cluster {
  epoch = 0;
  claims = new Set<string>();
  failNextClaims = 0;
  constructor(private readonly store: MemoryStore) {}
  async tryClaim(posId: string, reference: string) {
    if (this.failNextClaims > 0) {
      this.failNextClaims--;
      throw new Error('connexion de verrous perdue');
    }
    const k = `${posId}|${reference}`;
    if (this.claims.has(k)) return false;
    this.claims.add(k);
    return true;
  }
  async release(posId: string, reference: string) {
    this.claims.delete(`${posId}|${reference}`);
  }
  /** Simule la mort de la connexion de verrous : les verrous de session disparaissent. */
  loseLocks() {
    this.epoch++;
    this.claims.clear();
  }
  private open() {
    return this.store.entries.filter((e) => e.type === 'created'
      && !this.store.entries.some((f) => f.type === 'final' && f.posId === e.posId && f.reference === e.reference));
  }
  async activeOnPos(posId: string) {
    return this.open().filter((e) => e.posId === posId).at(-1)?.reference;
  }
  async unfinished() {
    return this.open().map((e) => ({ posId: e.posId, reference: e.reference }));
  }
  async byPos(posId: string) {
    return this.store.entries.filter((e) => e.posId === posId) as JournalEntry[];
  }
}

describe('rotation des clés du journal', () => {
  it('kid 2 + previous vérifie les entrées kid 1 ; sans previous, la chaîne est rompue', async () => {
    const store = new MemoryStore();
    const k1 = 'cle-une-0123456789abcdef';
    const k2 = 'cle-deux-0123456789abcdef';
    const j1 = new Journal(store, k1);
    await j1.append({ posId: 'p', reference: 'r1', type: 'created', data: {} });
    const j2 = new Journal(store, k2, { keyId: '2', previous: { '1': k1 } });
    await j2.append({ posId: 'p', reference: 'r2', type: 'created', data: {} });
    expect(store.entries[1]!.sig).toMatch(/^2:[0-9a-f]{64}$/);
    expect((await j2.verify()).ok).toBe(true);
    // Sans la clé précédente, l'entrée kid 1 ne peut plus être vérifiée.
    const j3 = new Journal(store, k2, { keyId: '2' });
    expect((await j3.verify())).toMatchObject({ ok: false, brokenAt: 1 });
    // Une signature préfixée d'un kid inconnu est invalide.
    store.entries[0]!.sig = `9:${store.entries[0]!.sig}`;
    expect((await j1.verify()).ok).toBe(false);
  });
});

describe('gardes d\'ajout (stockage mémoire)', () => {
  it('posIdle : refuse un created tant qu\'un autre paiement du terminal n\'a pas d\'issue', async () => {
    const j = new Journal(new MemoryStore(), 'gardes-key-0123456789abcdef');
    await j.append({ posId: 'p', reference: 'a', type: 'created', data: {} }, { posIdle: true });
    await expect(j.append({ posId: 'p', reference: 'b', type: 'created', data: {} }, { posIdle: true }))
      .rejects.toMatchObject({ code: 'terminal_busy', active: 'a' });
    await j.append({ posId: 'p', reference: 'a', type: 'final', data: { state: 'authorized' } });
    await j.append({ posId: 'p', reference: 'b', type: 'created', data: {} }, { posIdle: true });
  });
  it('refundCap : chaque n compté une fois, refund_failed exclu, dépassement refusé', async () => {
    const j = new Journal(new MemoryStore(), 'gardes-key-0123456789abcdef');
    const r = (type: 'refund_pending' | 'refund' | 'refund_failed', n: number, amount = 0) =>
      j.append({ posId: 'p', reference: 'a', type, data: { n, amount } });
    const cap = (amount: number) => j.append({ posId: 'p', reference: 'a', type: 'refund_pending', data: { n: 99, amount } }, { refundCap: 1000 });
    await r('refund_pending', 1, 600);
    await r('refund', 1, 600); // confirmé : compté une seule fois
    await r('refund_failed', 2); // n=2 exclu
    await cap(400);
    await expect(cap(401)).rejects.toMatchObject({ code: 'refund_exceeds_amount' });
  });
});

describe('verrous de cluster', () => {
  let sims: Awaited<ReturnType<typeof startSims>>;
  beforeAll(async () => {
    sims = await startSims();
  });
  afterAll(async () => {
    await sims?.close();
  });

  const makeEngine = (store: MemoryStore, cluster: Cluster, extra: Partial<EngineOptions> = {}) => new Engine({
    journal: new Journal(store, 'readiness-key-0123456789'),
    modules: BUILTIN_MODULES,
    routing: async (posId) => (posId === 'pos_t' ? {
      posId, country: 'FR', currency: 'EUR' as const,
      primary: { moduleId: 'psp-secours', config: { apiKey: 'sim' }, baseUrl: sims.secoursUrl },
    } : undefined),
    pollMs: 30, retryMs: 40, cluster, ...extra,
  });

  it('tryClaim en échec : aucune promesse rejetée non gérée, le scanner reprend le paiement', async () => {
    const store = new MemoryStore();
    const cluster = new FakeCluster(store);
    cluster.failNextClaims = 1;
    const engine = makeEngine(store, cluster);
    engine.startScanner(40);
    const before = sims.secours.state.debits;
    const v = await engine.pay({ posId: 'pos_t', reference: `CLF-${Date.now()}`, amount: 500, currency: 'EUR' });
    expect(v.state).toBe('pending');
    await sleep(200); // le claim a échoué : personne ne pilote encore
    const fin = await engine.waitForFinal('pos_t', v.reference, 10_000);
    expect(fin.state).toBe('authorized');
    expect(sims.secours.state.debits - before).toBe(1);
    engine.kill();
  });

  it('verrou perdu en plein vol : l\'instance cesse de piloter sans finaliser, la reprise ne débite qu\'une fois', async () => {
    sims.secours.faults.autoPresentMs = 1200;
    const store = new MemoryStore();
    const cluster = new FakeCluster(store);
    const engine = makeEngine(store, cluster);
    engine.startScanner(40);
    const ref = `LCK-${Date.now()}`;
    const before = sims.secours.state.debits;
    await engine.pay({ posId: 'pos_t', reference: ref, amount: 700, currency: 'EUR' });
    await sleep(300);
    cluster.loseLocks(); // connexion de verrous morte : les verrous tenus sont perdus
    await sleep(300); // le pilote s'arrête sans finaliser ; le scanner reprend via le chemin inDoubt
    const fin = await engine.waitForFinal('pos_t', ref, 10_000);
    expect(fin.state).toBe('authorized');
    expect(sims.secours.state.debits - before).toBe(1);
    sims.secours.faults.autoPresentMs = 150;
    engine.kill();
  });
});
