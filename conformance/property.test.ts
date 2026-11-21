// Test de propriétés : quelles que soient les pannes combinées, au plus un débit par référence,
// et l'état final rapporté par Meridian correspond à la réalité chez le PSP.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { harness, wait } from './harness.ts';

const RUNS = Number(process.env.PROP_RUNS ?? 25);

describe('Propriété : zéro double débit sous pannes aléatoires', () => {
  it(`${RUNS} séquences de pannes aléatoires`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          dropCreate: fc.integer({ min: 0, max: 2 }),
          dropProcess: fc.integer({ min: 0, max: 2 }),
          dropStatus: fc.integer({ min: 0, max: 3 }),
          cutAfterMs: fc.option(fc.integer({ min: 0, max: 500 })),
          cutForMs: fc.integer({ min: 100, max: 900 }),
          decline: fc.boolean(),
        }),
        async (f) => {
          const h = await harness();
          try {
            const s = h.sims.stripe.faults;
            s.dropResponse['/v1/payment_intents'] = f.dropCreate;
            s.dropResponse['process_payment_intent'] = f.dropProcess;
            s.dropResponse['/v1/terminal/readers/tmr_sim_FR'] = f.dropStatus;
            s.declineNext = f.decline;
            const ref = h.ref();
            await h.engine.pay({ posId: h.posId, reference: ref, amount: 1234, currency: 'EUR' });
            if (f.cutAfterMs !== null) {
              await wait(f.cutAfterMs);
              s.netDownUntil = Date.now() + f.cutForMs;
            }
            const v = await h.engine.waitForFinal(h.posId, ref, 12_000);
            const debits = h.sims.debits();
            expect(debits).toBeLessThanOrEqual(1);
            expect(v.state === 'authorized').toBe(debits === 1);
            expect(['authorized', 'declined', 'cancelled', 'failed']).toContain(v.state);
          } finally {
            await h.close();
          }
        },
      ),
      { numRuns: RUNS },
    );
  }, 600_000);
});
