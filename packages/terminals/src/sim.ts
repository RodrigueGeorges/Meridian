// Terminaux simulés pour les tests et la démo : les passerelles Meridian jouent le rôle du TPE,
// branchées sur une « carte » simulée. Montant finissant par 13 = refus ; finissant par 66 = abandon client.
import http from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { createConcertServer, createZvtServer, handleNexo, type BridgeTarget } from '@meridian/bridges';
import type { PaymentView } from '@meridian/engine';

export interface CardSimOptions { delayMs?: number }

export function cardSim(o: CardSimOptions = {}) {
  const pays = new Map<string, PaymentView & { createdAt: string }>();
  const waiters = new Map<string, (() => void)[]>();
  let debits = 0;
  const view = (posId: string, ref: string) => {
    const v = pays.get(ref);
    if (!v) throw new Error('payment_not_found');
    return v;
  };
  const target: BridgeTarget = {
    async pay(posId, reference, amount, currency) {
      if (pays.has(reference)) return view(posId, reference);
      const v: PaymentView & { createdAt: string } = { posId, reference, amount, currency: currency as PaymentView['currency'], state: 'pending', module: 'card', refunded: 0, createdAt: new Date().toISOString() };
      pays.set(reference, v);
      setTimeout(() => {
        if (v.state !== 'pending') return;
        const cents = amount % 100;
        if (cents === 13) { v.state = 'declined'; v.detail = 'card_declined'; }
        else if (cents === 66) v.state = 'cancelled';
        else { v.state = 'authorized'; debits++; }
        (waiters.get(reference) ?? []).splice(0).forEach((w) => w());
      }, o.delayMs ?? 60);
      return v;
    },
    status: (posId, ref) => view(posId, ref),
    async waitFinal(posId, ref, timeoutMs) {
      const v = view(posId, ref);
      if (v.state !== 'pending') return v;
      await new Promise<void>((res) => { const t = setTimeout(res, timeoutMs); waiters.set(ref, [...(waiters.get(ref) ?? []), () => { clearTimeout(t); res(); }]); });
      return view(posId, ref);
    },
    async cancel(posId, ref) {
      const v = view(posId, ref);
      if (v.state === 'pending') { v.state = 'cancelled'; (waiters.get(ref) ?? []).splice(0).forEach((w) => w()); }
      return v;
    },
    async refund(posId, ref, amount) {
      const v = view(posId, ref);
      if (v.state !== 'authorized' || v.refunded + amount > v.amount) throw new Error('not_refundable');
      v.refunded += amount;
      return v;
    },
    receipt: (posId, ref) => (pays.get(ref)?.state === 'authorized' ? { brand: 'visa', last4: '4242', proof: { seq: 1 } } : undefined),
    lastRefundable: (_p, amount) => [...pays.values()].reverse().find((v) => v.state === 'authorized' && v.amount - v.refunded >= amount),
    lastCancellable: (_p, amount) => [...pays.values()].reverse().find((v) => v.amount === amount && (v.state === 'pending' || (v.state === 'authorized' && v.refunded < v.amount))),
    list: () => [...pays.values()],
  };
  return { target, pays, debits: () => debits, refunded: () => [...pays.values()].reduce((s, v) => s + v.refunded, 0) };
}

const listen = (s: Server | http.Server) => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as AddressInfo).port)));

/** Lance un TPE simulé par protocole. */
export async function startTerminalSims(o: CardSimOptions = {}) {
  const ap = cardSim(o), zvt = cardSim(o), nexo = cardSim(o);
  const apServer = createConcertServer(ap.target, { posFor: () => 'tpe' });
  const zvtServer = createZvtServer(zvt.target, { posId: 'tpe' });
  const nexoServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const out = await handleNexo(JSON.parse(raw || '{}'), nexo.target, { timeoutMs: 30_000 });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  const [apPort, zvtPort, nexoPort] = await Promise.all([listen(apServer), listen(zvtServer), listen(nexoServer)]);
  return {
    caisseAp: { port: apPort, sim: ap }, zvt: { port: zvtPort, sim: zvt }, nexo: { url: `http://127.0.0.1:${nexoPort}/`, sim: nexo },
    close: () => Promise.all([apServer, zvtServer, nexoServer].map((s) => new Promise((r) => s.close(() => r(null))))),
  };
}
