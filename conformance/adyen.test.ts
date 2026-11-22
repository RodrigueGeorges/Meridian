// Module Adyen Terminal API (aperçu) contre une imitation de l'API cloud d'Adyen, d'après sa documentation publique.
// Adyen ne déclare pas de clé d'idempotence ici : le moteur doit vérifier (TransactionStatus) avant tout renvoi.
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, Journal, MemoryStore } from '@meridian/engine';
import { BUILTIN_MODULES } from '@meridian/modules';

type Pay = { serviceId: string; amount: number; currency: string; polls: number; aborted: boolean };

function fakeAdyen(opts: { loseFirstAsyncReply?: boolean; failFirstAsyncBeforeSend?: boolean; decline?: boolean } = {}) {
  const pays = new Map<string, Pay>();
  const reversals: number[] = [];
  const serviceIds = new Set<string>();
  let asyncCalls = 0;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('x-API-key')).toBe('test_key');
    const req = JSON.parse(String(init.body)).SaleToPOIRequest;
    const h = req.MessageHeader;
    expect(h.ServiceID).toMatch(/^[0-9a-z]{1,10}$/);
    expect(serviceIds.has(`${h.MessageCategory}:${h.ServiceID}`) && h.MessageCategory !== 'Payment').toBe(false);
    serviceIds.add(`${h.MessageCategory}:${h.ServiceID}`);
    if (url.endsWith('/async') && req.PaymentRequest) {
      asyncCalls++;
      if (opts.failFirstAsyncBeforeSend && asyncCalls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      const amt = req.PaymentRequest.PaymentTransaction.AmountsReq;
      expect(typeof amt.RequestedAmount).toBe('number');
      if (!pays.has(h.ServiceID)) pays.set(h.ServiceID, { serviceId: h.ServiceID, amount: amt.RequestedAmount, currency: amt.Currency, polls: 0, aborted: false });
      if (opts.loseFirstAsyncReply && asyncCalls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return new Response('ok', { status: 200 });
    }
    if (url.endsWith('/async') && req.AbortRequest) {
      const p = pays.get(req.AbortRequest.MessageReference.ServiceID);
      if (p) p.aborted = true;
      return new Response('ok', { status: 200 });
    }
    if (url.endsWith('/sync') && req.TransactionStatusRequest) {
      const p = pays.get(req.TransactionStatusRequest.MessageReference.ServiceID);
      if (!p) return json({ SaleToPOIResponse: { TransactionStatusResponse: { Response: { Result: 'Failure', ErrorCondition: 'NotFound' } } } });
      if (++p.polls < 2 && !p.aborted) return json({ SaleToPOIResponse: { TransactionStatusResponse: { Response: { Result: 'Failure', ErrorCondition: 'InProgress' } } } });
      const res = p.aborted ? { Result: 'Failure', ErrorCondition: 'Cancel' } : opts.decline ? { Result: 'Failure', ErrorCondition: 'Refusal' } : { Result: 'Success' };
      return json({ SaleToPOIResponse: { TransactionStatusResponse: {
        Response: { Result: 'Success' },
        RepeatedMessageResponse: {
          MessageHeader: { ServiceID: p.serviceId },
          RepeatedResponseMessageBody: { PaymentResponse: {
            Response: res,
            POIData: { POITransactionID: { TransactionID: 'POI-' + p.serviceId, TimeStamp: '2026-11-22T15:00:00Z' } },
            PaymentResult: { PaymentInstrumentData: { CardData: { PaymentBrand: 'mc', MaskedPan: '541333 **** 9999' } } },
          } },
        },
      } } });
    }
    if (url.endsWith('/sync') && req.ReversalRequest) {
      expect(req.ReversalRequest.OriginalPOITransaction.POITransactionID.TransactionID).toMatch(/^POI-/);
      reversals.push(req.ReversalRequest.ReversedAmount);
      return json({ SaleToPOIResponse: { ReversalResponse: { Response: { Result: 'Success' } } } });
    }
    throw new Error('requête inattendue ' + url);
  }) as unknown as typeof fetch;
  return { fetcher, pays, reversals, asyncCalls: () => asyncCalls };
}

let engine: Engine | undefined;
afterEach(() => engine?.kill());

function make(fetcher: typeof fetch) {
  const store = new MemoryStore();
  engine = new Engine({
    journal: new Journal(store, 'adyen-test-key-0123456789'), modules: BUILTIN_MODULES, fetcher,
    routing: async () => ({ posId: 'p1', country: 'FR', currency: 'EUR',
      primary: { moduleId: 'adyen-terminal', config: { apiKey: 'test_key', poiId: 'V400m-1', saleId: 'CAISSE1' } } }),
    pollMs: 20, retryMs: 30, payTimeoutMs: 5000, httpTimeoutMs: 1000,
  });
  return { engine, store };
}

describe('Adyen Terminal API (aperçu)', () => {
  it('module en aperçu, avec recherche avant renvoi', () => {
    expect(BUILTIN_MODULES['adyen-terminal']!.maturity).toBe('preview');
    expect(BUILTIN_MODULES['adyen-terminal']!.lookup).toBeDefined();
  });
  it('paiement nominal : montant décimal, reçu avec référence Adyen, remboursement partiel', async () => {
    const a = fakeAdyen();
    const { engine } = make(a.fetcher);
    await engine.pay({ posId: 'p1', reference: 'A-1', amount: 2450, currency: 'EUR' });
    const v = await engine.waitForFinal('p1', 'A-1', 4000);
    expect(v.state).toBe('authorized');
    expect([...a.pays.values()][0]!.amount).toBe(24.5);
    const r = await engine.receiptFresh('p1', 'A-1');
    expect(r).toMatchObject({ brand: 'mc' });
    await engine.refund('p1', 'A-1', 1000, 1);
    expect(a.reversals).toEqual([10]);
  });
  it('réponse perdue après réception : vérifie, ne renvoie pas, un seul paiement', async () => {
    const a = fakeAdyen({ loseFirstAsyncReply: true });
    const { engine, store } = make(a.fetcher);
    await engine.pay({ posId: 'p1', reference: 'A-2', amount: 1000, currency: 'EUR' });
    expect((await engine.waitForFinal('p1', 'A-2', 4000)).state).toBe('authorized');
    expect(a.asyncCalls()).toBe(1);
    expect(a.pays.size).toBe(1);
    const j = await store.byReference('p1', 'A-2');
    expect(j.find((e) => e.type === 'step')!.data).toMatchObject({ via: 'lookup' });
  });
  it('coupure avant réception : introuvable chez Adyen, renvoi unique, un seul paiement', async () => {
    const a = fakeAdyen({ failFirstAsyncBeforeSend: true });
    const { engine } = make(a.fetcher);
    await engine.pay({ posId: 'p1', reference: 'A-3', amount: 1000, currency: 'EUR' });
    expect((await engine.waitForFinal('p1', 'A-3', 4000)).state).toBe('authorized');
    expect(a.asyncCalls()).toBe(2);
    expect(a.pays.size).toBe(1);
  });
  it('refus de carte et annulation', async () => {
    const d = fakeAdyen({ decline: true });
    const e1 = make(d.fetcher).engine;
    await e1.pay({ posId: 'p1', reference: 'A-4', amount: 1000, currency: 'EUR' });
    expect(await e1.waitForFinal('p1', 'A-4', 4000)).toMatchObject({ state: 'declined', detail: 'Refusal' });
    e1.kill();
    const c = fakeAdyen();
    const e2 = make(c.fetcher).engine;
    await e2.pay({ posId: 'p1', reference: 'A-5', amount: 1000, currency: 'EUR' });
    await e2.cancel('p1', 'A-5');
    expect((await e2.waitForFinal('p1', 'A-5', 4000)).state).toBe('cancelled');
  });
});

describe('Stripe Tap to Pay (aperçu)', () => {
  it('remet le secret client à la caisse tant que le paiement est en cours, puis le retire', async () => {
    let status = 'requires_payment_method';
    const fetcher = (async (url: string, init: RequestInit) => {
      const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith('/v1/payment_intents') && init.method === 'POST') return j({ id: 'pi_1', client_secret: 'pi_1_secret_x', status });
      if (url.includes('/v1/payment_intents/pi_1')) return j({ id: 'pi_1', status, latest_charge: { payment_method_details: { card_present: { brand: 'visa', last4: '4242' } } } });
      throw new Error('inattendu ' + url);
    }) as unknown as typeof fetch;
    const store = new MemoryStore();
    engine = new Engine({
      journal: new Journal(store, 'ttp-test-key-0123456789'), modules: BUILTIN_MODULES, fetcher,
      routing: async () => ({ posId: 'p1', country: 'FR', currency: 'EUR', primary: { moduleId: 'stripe-tap-to-pay', config: { secretKey: 'sk_test_x', locationId: 'tml_1' } } }),
      pollMs: 20, retryMs: 30, payTimeoutMs: 5000,
    });
    await engine.pay({ posId: 'p1', reference: 'T-1', amount: 990, currency: 'EUR' });
    let v = await engine.statusFresh('p1', 'T-1');
    for (let i = 0; i < 50 && !v.device; i++) { await new Promise((r) => setTimeout(r, 20)); v = await engine.statusFresh('p1', 'T-1'); }
    expect(v.device).toEqual({ clientSecret: 'pi_1_secret_x', intentId: 'pi_1' });
    status = 'succeeded';
    v = await engine.waitForFinal('p1', 'T-1', 4000);
    expect(v.state).toBe('authorized');
    expect(v.device).toBeUndefined();
  });
});
