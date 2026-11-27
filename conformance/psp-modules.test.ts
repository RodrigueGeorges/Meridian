// Modules Mollie, Square et SumUp (aperçu) contre des imitations de leur API, d'après leurs documentations publiques.
// Vérifie : forme des requêtes, idempotence (en-tête, corps ou recherche avant renvoi), issue, remboursement.
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, Journal, MemoryStore } from '@meridian/engine';
import { BUILTIN_MODULES } from '@meridian/modules';

const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const lost = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
let engine: Engine | undefined;
afterEach(() => engine?.kill());

function run(moduleId: string, config: Record<string, unknown>, fetcher: typeof fetch) {
  engine = new Engine({
    journal: new Journal(new MemoryStore(), 'psp-modules-key-0123456789'), modules: BUILTIN_MODULES, fetcher,
    routing: async () => ({ posId: 'p', country: 'FR', currency: 'EUR', primary: { moduleId, config } }),
    pollMs: 15, retryMs: 25, payTimeoutMs: 4000, httpTimeoutMs: 800,
  });
  return engine;
}

describe('Mollie point-of-sale', () => {
  it('montant en chaîne décimale, clé d\'idempotence, payé, remboursement', async () => {
    const seen: { url: string; body?: any; idem?: string | null }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let polls = 0;
    const f = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, body, idem: new Headers(init.headers).get('idempotency-key') });
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test_k');
      if (url.endsWith('/v2/payments') && init.method === 'POST') return j({ id: 'tr_1', status: 'open' }, 201);
      if (url.endsWith('/v2/payments/tr_1')) return j({ id: 'tr_1', status: ++polls < 2 ? 'open' : 'paid', details: { cardLabel: 'VISA', cardNumber: '**** **** **** 1234' } });
      if (url.endsWith('/v2/payments/tr_1/refunds')) return j({ id: 're_1' }, 201);
      throw new Error('inattendu ' + url);
    }) as unknown as typeof fetch;
    const e = run('mollie-pos', { apiKey: 'test_k', terminalId: 'term_X' }, f);
    await e.pay({ posId: 'p', reference: 'M-1', amount: 2450, currency: 'EUR' });
    expect((await e.waitForFinal('p', 'M-1', 3000)).state).toBe('authorized');
    expect(seen[0]!.body).toMatchObject({ amount: { currency: 'EUR', value: '24.50' }, method: 'pointofsale', terminalId: 'term_X' });
    expect(seen[0]!.idem).toBe('M-1:create_payment');
    expect((await e.receiptFresh('p', 'M-1'))).toMatchObject({ brand: 'VISA' });
    await e.refund('p', 'M-1', 500, 1);
    expect(seen.at(-1)!.body).toEqual({ amount: { currency: 'EUR', value: '5.00' } });
  });
});

describe('Square Terminal API', () => {
  it('idempotency_key dans le corps, rejoué tel quel après réponse perdue ; remboursement par payment_id', async () => {
    const keys: string[] = [];
    let first = true, polls = 0;
    const f = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      expect(new Headers(init.headers).get('square-version')).toBeTruthy();
      if (url.endsWith('/v2/terminals/checkouts') && init.method === 'POST') {
        keys.push(body.idempotency_key);
        expect(body.checkout).toMatchObject({ amount_money: { amount: 1290, currency: 'EUR' }, device_options: { device_id: 'DEV1' } });
        if (first) { first = false; throw lost(); }
        return j({ checkout: { id: 'chk_1', status: 'PENDING' } });
      }
      if (url.endsWith('/v2/terminals/checkouts/chk_1')) return j({ checkout: { id: 'chk_1', status: ++polls < 2 ? 'IN_PROGRESS' : 'COMPLETED', payment_ids: ['pay_9'] } });
      if (url.endsWith('/v2/refunds')) { expect(body).toMatchObject({ payment_id: 'pay_9', idempotency_key: 'S-1-refund-1' }); return j({ refund: { id: 'r' } }); }
      throw new Error('inattendu ' + url);
    }) as unknown as typeof fetch;
    const e = run('square-terminal', { accessToken: 'sq', deviceId: 'DEV1' }, f);
    await e.pay({ posId: 'p', reference: 'S-1', amount: 1290, currency: 'EUR' });
    expect((await e.waitForFinal('p', 'S-1', 3000)).state).toBe('authorized');
    expect(keys).toEqual(['S-1', 'S-1']);
    await e.refund('p', 'S-1', 1290, 1);
  });
  it('annulé au terminal = annulé, avec le motif', async () => {
    const f = (async (url: string, init: RequestInit) => {
      if (init.method === 'POST') return j({ checkout: { id: 'chk_2', status: 'PENDING' } });
      return j({ checkout: { id: 'chk_2', status: 'CANCELED', cancel_reason: 'BUYER_CANCELED' } });
    }) as unknown as typeof fetch;
    const e = run('square-terminal', { accessToken: 'sq', deviceId: 'DEV1' }, f);
    await e.pay({ posId: 'p', reference: 'S-2', amount: 100, currency: 'EUR' });
    expect(await e.waitForFinal('p', 'S-2', 3000)).toMatchObject({ state: 'cancelled', detail: 'BUYER_CANCELED' });
  });
});

describe('SumUp Solo (Cloud API)', () => {
  function sumup(o: { loseReply?: boolean; failBeforeSend?: boolean; outcome?: string }) {
    let checkouts = 0, tx: { id: string; status: string } | undefined, polls = 0, attempt = 0;
    const f = (async (url: string, init: RequestInit) => {
      if (url.includes('/readers/RDR/checkout')) {
        attempt++;
        if (o.failBeforeSend && attempt === 1) throw lost();
        const b = JSON.parse(String(init.body));
        expect(b).toMatchObject({ total_amount: { currency: 'EUR', minor_unit: 2, value: 990 }, affiliate: { app_id: 'app', key: 'aff', foreign_transaction_id: 'U-1' } });
        checkouts++;
        tx = { id: 'txn_1', status: 'PENDING' };
        if (o.loseReply && attempt === 1) throw lost();
        return j({ data: { client_transaction_id: 'c1' } }, 201);
      }
      if (url.includes('/v2.1/merchants/MC/transactions?foreign_transaction_id=U-1')) {
        if (!tx) return j({ error_code: 'NOT_FOUND' }, 404);
        if (++polls > 1) tx.status = o.outcome ?? 'SUCCESSFUL';
        return j({ ...tx, card: { type: 'VISA', last_4_digits: '4242' } });
      }
      if (url.endsWith('/v1.0/merchants/MC/payments/txn_1/refunds')) { expect(JSON.parse(String(init.body))).toEqual({ amount: 990 }); return new Response(null, { status: 204 }); }
      throw new Error('inattendu ' + url);
    }) as unknown as typeof fetch;
    return { f, checkouts: () => checkouts };
  }
  const cfg = { apiKey: 'k', merchantCode: 'MC', readerId: 'RDR', affiliateKey: 'aff', appId: 'app' };
  it('réponse perdue après réception : recherche par foreign_transaction_id, aucun second encaissement', async () => {
    const s = sumup({ loseReply: true });
    const e = run('sumup-solo', cfg, s.f);
    await e.pay({ posId: 'p', reference: 'U-1', amount: 990, currency: 'EUR' });
    expect((await e.waitForFinal('p', 'U-1', 3000)).state).toBe('authorized');
    expect(s.checkouts()).toBe(1);
    expect(await e.receiptFresh('p', 'U-1')).toMatchObject({ brand: 'VISA', last4: '4242' });
  });
  it('coupure avant réception : 404 chez SumUp, renvoi unique', async () => {
    const s = sumup({ failBeforeSend: true });
    const e = run('sumup-solo', cfg, s.f);
    await e.pay({ posId: 'p', reference: 'U-1', amount: 990, currency: 'EUR' });
    expect((await e.waitForFinal('p', 'U-1', 3000)).state).toBe('authorized');
    expect(s.checkouts()).toBe(1);
  });
  it('refus', async () => {
    const s = sumup({ outcome: 'FAILED' });
    const e = run('sumup-solo', cfg, s.f);
    await e.pay({ posId: 'p', reference: 'U-1', amount: 990, currency: 'EUR' });
    expect((await e.waitForFinal('p', 'U-1', 3000)).state).toBe('declined');
  });
});
