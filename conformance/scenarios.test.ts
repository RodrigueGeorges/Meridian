// Les 8 scénarios de conformité de la spécification, plus les cas limites de l'API.
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, Journal } from '@meridian/engine';
import { BUILTIN_MODULES } from '@meridian/modules';
import { harness, KEY, wait } from './harness.ts';

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const payAndWait = async (x: H, amount = 2450, ref = x.ref()) => {
  await x.engine.pay({ posId: x.posId, reference: ref, amount, currency: 'EUR' });
  return x.engine.waitForFinal(x.posId, ref, 8000);
};

describe('Conformité Meridian × Stripe Terminal (simulateur)', () => {
  it('1. Paiement nominal : autorisé, un débit, reçu et preuve valides', async () => {
    h = await harness();
    const v = await payAndWait(h);
    expect(v.state).toBe('authorized');
    expect(h.sims.debits()).toBe(1);
    const r = h.engine.receipt(h.posId, v.reference);
    expect(r.brand).toBe('visa');
    expect(r.last4).toBe('4242');
    expect((await h.engine.verify()).ok).toBe(true);
  });

  it('2. Carte refusée : refusé avec code, zéro débit, PaymentIntent annulé', async () => {
    h = await harness();
    h.sims.stripe.faults.declineNext = true;
    const v = await payAndWait(h);
    expect(v.state).toBe('declined');
    expect(v.detail).toBe('card_declined');
    expect(h.sims.debits()).toBe(0);
    expect([...h.sims.stripe.state.intents.values()][0]?.status).toBe('canceled');
  });

  it('3. Réponse perdue sur la création : rejeu même clé, un seul PaymentIntent', async () => {
    h = await harness();
    h.sims.stripe.faults.dropResponse['/v1/payment_intents'] = 1;
    const v = await payAndWait(h);
    expect(v.state).toBe('authorized');
    expect(h.sims.stripe.state.intents.size).toBe(1);
    expect(h.sims.debits()).toBe(1);
  });

  it('4. Réponse perdue sur l’envoi au lecteur : rejeu même clé, un seul débit', async () => {
    h = await harness();
    h.sims.stripe.faults.dropResponse['process_payment_intent'] = 1;
    const v = await payAndWait(h);
    expect(v.state).toBe('authorized');
    expect(h.sims.debits()).toBe(1);
    const types = (await h.store.all()).map((e) => e.type);
    expect(types).toContain('network_error');
  });

  it('5. Coupure réseau pendant l’autorisation : « en cours » puis autorisé, jamais « échec »', async () => {
    h = await harness();
    h.sims.stripe.faults.authMs = 400;
    const ref = h.ref();
    await h.engine.pay({ posId: h.posId, reference: ref, amount: 1500, currency: 'EUR' });
    await wait(120);
    h.sims.stripe.faults.netDownUntil = Date.now() + 700;
    await wait(300);
    expect(h.engine.status(h.posId, ref).state).toBe('pending');
    const v = await h.engine.waitForFinal(h.posId, ref, 8000);
    expect(v.state).toBe('authorized');
    expect(h.sims.debits()).toBe(1);
  });

  it('6. Crash juste après l’envoi au lecteur, avant journalisation : reprise, un seul débit', async () => {
    let first: Engine | undefined;
    let crashed = false;
    h = await harness({
      fetcher: async (url, init) => {
        const res = await fetch(url, init);
        if (!crashed && String(url).includes('process_payment_intent')) {
          crashed = true;
          first?.kill();
        }
        return res;
      },
    });
    first = h.engine;
    const ref = h.ref();
    await h.engine.pay({ posId: h.posId, reference: ref, amount: 2450, currency: 'EUR' });
    await wait(150);
    expect(crashed).toBe(true);
    expect((await h.store.all()).filter((e) => e.type === 'step')).toHaveLength(1); // process non journalisé
    const second = new Engine({
      journal: new Journal(h.store, KEY), modules: BUILTIN_MODULES,
      routing: async () => ({ posId: h!.posId, country: 'FR', currency: 'EUR', primary: { moduleId: 'stripe-terminal', config: { secretKey: 'sk_test_sim', readerId: 'tmr_sim_FR' }, baseUrl: h!.sims.stripeUrl } }),
      pollMs: 40, retryMs: 60,
    });
    const rec = await second.recover();
    expect(rec.resumed).toBe(1);
    const v = await second.waitForFinal(h.posId, ref, 8000);
    expect(v.state).toBe('authorized');
    expect(h.sims.debits()).toBe(1);
    expect(h.sims.stripe.state.intents.size).toBe(1);
    expect((await second.verify()).ok).toBe(true);
    second.kill();
  });

  it('7a. Annulation avant la carte : annulé, zéro débit', async () => {
    h = await harness();
    h.sims.stripe.faults.autoPresentMs = null;
    const ref = h.ref();
    await h.engine.pay({ posId: h.posId, reference: ref, amount: 900, currency: 'EUR' });
    await wait(200);
    await h.engine.cancel(h.posId, ref);
    const v = await h.engine.waitForFinal(h.posId, ref, 8000);
    expect(v.state).toBe('cancelled');
    expect(h.sims.debits()).toBe(0);
  });

  it('7b. Annulation pendant l’autorisation : refusée par le PSP, issue réelle « autorisé » + cancel_too_late', async () => {
    h = await harness();
    h.sims.stripe.faults.autoPresentMs = null;
    h.sims.stripe.faults.authMs = 700;
    const ref = h.ref();
    await h.engine.pay({ posId: h.posId, reference: ref, amount: 900, currency: 'EUR' });
    await wait(200);
    await fetch(`${h.sims.stripeUrl}/v1/test_helpers/terminal/readers/tmr_sim_FR/present_payment_method`, {
      method: 'POST', headers: { authorization: 'Bearer sk_test_sim' },
    });
    await h.engine.cancel(h.posId, ref);
    const v = await h.engine.waitForFinal(h.posId, ref, 8000);
    expect(v.state).toBe('authorized');
    expect(v.detail).toBe('cancel_too_late');
    expect(h.sims.debits()).toBe(1);
    expect((await h.store.all()).map((e) => e.type)).toContain('cancel_refused');
  });

  it('8. PSP principal injoignable avant tout envoi : bascule vers le secours, un seul débit', async () => {
    h = await harness({ fallback: true });
    await h.sims.stopStripe();
    const v = await payAndWait(h);
    expect(v.state).toBe('authorized');
    expect(v.module).toBe('psp-secours');
    expect(h.sims.secours.state.debits).toBe(1);
    expect(h.sims.stripe.state.debits).toBe(0);
  });
});

describe('Règles de l’API', () => {
  it('même référence, montant différent → reference_conflict', async () => {
    h = await harness();
    const ref = h.ref();
    await h.engine.pay({ posId: h.posId, reference: ref, amount: 100, currency: 'EUR' });
    await expect(h.engine.pay({ posId: h.posId, reference: ref, amount: 200, currency: 'EUR' })).rejects.toMatchObject({ code: 'reference_conflict' });
    const again = await h.engine.pay({ posId: h.posId, reference: ref, amount: 100, currency: 'EUR' });
    expect(again.reference).toBe(ref);
  });

  it('second paiement sur un terminal occupé → terminal_busy', async () => {
    h = await harness();
    h.sims.stripe.faults.autoPresentMs = null;
    await h.engine.pay({ posId: h.posId, reference: h.ref(), amount: 100, currency: 'EUR' });
    await expect(h.engine.pay({ posId: h.posId, reference: h.ref(), amount: 100, currency: 'EUR' })).rejects.toMatchObject({ code: 'terminal_busy' });
  });

  it('remboursements idempotents et plafonnés', async () => {
    h = await harness();
    const v = await payAndWait(h, 1000);
    await h.engine.refund(h.posId, v.reference, 600, 1);
    await h.engine.refund(h.posId, v.reference, 600, 1); // rejeu : pas de doublon
    expect(h.engine.status(h.posId, v.reference).refunded).toBe(600);
    await expect(h.engine.refund(h.posId, v.reference, 500, 2)).rejects.toMatchObject({ code: 'refund_exceeds_amount' });
    expect(h.sims.stripe.state.refunds.size).toBe(1);
  });

  it('montants invalides et devises non prises en charge refusés', async () => {
    h = await harness();
    await expect(h.engine.pay({ posId: h.posId, reference: 'x1', amount: 24.5, currency: 'EUR' })).rejects.toMatchObject({ code: 'invalid_amount' });
    await expect(h.engine.pay({ posId: h.posId, reference: 'x2', amount: 100, currency: 'USD' })).rejects.toMatchObject({ code: 'unsupported_currency' });
  });

  it.each(['FR', 'BE', 'NL', 'DE', 'ES', 'IT'])('paiement nominal dans le pays de lancement %s', async (country) => {
    h = await harness({ country });
    const v = await payAndWait(h);
    expect(v.state).toBe('authorized');
  });

  it('journal falsifié : verify() le détecte', async () => {
    h = await harness();
    await payAndWait(h);
    const e = (h.store as unknown as { entries: { data: Record<string, unknown> }[] }).entries[0]!;
    e.data.amount = 1;
    const res = await h.engine.verify();
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });
});
