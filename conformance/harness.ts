// Banc de conformité : simulateurs + moteur câblés comme en production, avec pannes pilotables.
import { BUILTIN_MODULES, type Fetcher } from '@meridian/modules';
import { Engine, Journal, MemoryStore, type PosRouting } from '@meridian/engine';
import { startSims } from '@meridian/sim';

export const KEY = 'test-journal-key-0123456789';

export async function harness(opts: { fallback?: boolean; fetcher?: Fetcher; country?: string } = {}) {
  const sims = await startSims();
  const store = new MemoryStore();
  const country = opts.country ?? 'FR';
  const posId = `pos_${country}`;
  const routing = (): PosRouting => ({
    posId, country, currency: 'EUR',
    primary: { moduleId: 'stripe-terminal', config: { secretKey: 'sk_test_sim', readerId: `tmr_sim_${country}` }, baseUrl: sims.stripeUrl },
    fallback: opts.fallback ? { moduleId: 'psp-secours', config: { apiKey: 'sim' }, baseUrl: sims.secoursUrl } : undefined,
  });
  const make = (fetcher?: Fetcher) =>
    new Engine({
      journal: new Journal(store, KEY), modules: BUILTIN_MODULES, routing: async (id) => (id === posId ? routing() : undefined),
      pollMs: 40, retryMs: 60, payTimeoutMs: 10_000, httpTimeoutMs: 2000, fetcher,
    });
  const engine = make(opts.fetcher);
  let n = 0;
  return {
    sims, store, engine, posId, make,
    ref: () => `T-${Date.now().toString(36)}-${++n}`,
    async close() {
      engine.kill();
      await sims.close();
    },
  };
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
