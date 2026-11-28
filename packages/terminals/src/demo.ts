// Démo « terminal du magasin » du site : le vrai service terminal de l'agent et le vrai pilote nexo,
// face à un TPE nexo simulé. Chaque message échangé avec le TPE est horodaté pour être rejoué à l'écran.
// En mode cloud, le passage par l'API et le relais Meridian est représenté (il est couvert par les tests de bout en bout).
import { NexoDriver } from './nexo.ts';
import { TerminalService } from './service.ts';
import { startTerminalSims } from './sim.ts';

export const TERMINAL_DEMO_INCIDENTS = ['none', 'lost_reply', 'busy', 'declined'] as const;
export type TerminalDemoIncident = (typeof TERMINAL_DEMO_INCIDENTS)[number];
export type TerminalDemoHop = 'till' | 'meridian' | 'agent' | 'tpe';
export interface TerminalDemoStep { ms: number; hop: TerminalDemoHop; kind: string }
export interface TerminalDemoRun {
  mode: 'local' | 'cloud';
  incident: TerminalDemoIncident;
  reference: string;
  amount: number;
  currency: 'EUR';
  state: string;
  detail: string | null;
  /** Ordres de paiement envoyés au TPE pour ce paiement. */
  orders: number;
  /** Débits réels de ce paiement au TPE. */
  debits: number;
  durationMs: number;
  steps: TerminalDemoStep[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Msg = { SaleToPOIRequest: { MessageHeader: { MessageCategory: string } } };

export async function runTerminalDemo(o: { mode: 'local' | 'cloud'; incident: TerminalDemoIncident; cardMs?: number }): Promise<TerminalDemoRun> {
  const sims = await startTerminalSims({ delayMs: o.cardMs ?? 1400 });
  const t0 = Date.now();
  const steps: TerminalDemoStep[] = [];
  const at = (hop: TerminalDemoHop, kind: string) => steps.push({ ms: Date.now() - t0, hop, kind });
  const reference = `TPE-${t0.toString(36).toUpperCase()}`;
  const amount = o.incident === 'declined' ? 2413 : 2450; // montant finissant par 13 : refus du simulateur
  try {
    let orders = 0;
    let lose = o.incident === 'lost_reply';
    const fetcher: typeof fetch = async (url, init) => {
      const cat = (JSON.parse(String(init?.body)) as Msg).SaleToPOIRequest.MessageHeader.MessageCategory;
      if (cat === 'Payment') {
        orders++;
        at('agent', 'order_sent');
        if (lose) {
          lose = false;
          void fetch(url, init).catch(() => undefined); // le TPE reçoit l'ordre…
          await sleep(900);
          at('agent', 'reply_lost'); // …mais sa réponse n'arrive jamais
          throw new Error('socket hang up');
        }
        const r = await fetch(url, init);
        const res = ((await r.clone().json()) as { SaleToPOIResponse?: { PaymentResponse?: { Response?: { Result?: string; ErrorCondition?: string } } } }).SaleToPOIResponse?.PaymentResponse?.Response;
        at('tpe', res?.ErrorCondition === 'Busy' ? 'tpe_busy' : res?.Result === 'Success' ? 'tpe_authorized' : res?.ErrorCondition === 'Refusal' ? 'tpe_declined' : 'tpe_other');
        return r;
      }
      if (cat === 'TransactionStatus') {
        at('agent', 'status_asked');
        const r = await fetch(url, init);
        const res = ((await r.clone().json()) as { SaleToPOIResponse?: { TransactionStatusResponse?: { Response?: { Result?: string; ErrorCondition?: string } } } }).SaleToPOIResponse?.TransactionStatusResponse?.Response;
        at('tpe', res?.ErrorCondition === 'InProgress' ? 'status_in_progress' : res?.Result === 'Success' ? 'status_final' : 'status_unknown');
        return r;
      }
      return fetch(url, init);
    };

    let other: Promise<unknown> | undefined;
    if (o.incident === 'busy') {
      other = new NexoDriver({ url: sims.nexo.url, poiId: 'tpe', saleId: 'CAISSE-2' }).pay({ reference: `${reference}-C2`, amount: 1890, currency: 'EUR' });
      await sleep(150);
      at('tpe', 'other_till');
    }
    const service = new TerminalService(new NexoDriver({ url: sims.nexo.url, poiId: 'tpe', saleId: 'CAISSE-1', fetcher, pollMs: 500, recoverMs: 15_000 }));
    at('till', 'till_pay');
    if (o.mode === 'cloud') { await sleep(120); at('meridian', 'relayed'); }
    await sleep(60);
    at('agent', 'agent_received');
    await service.handle('POST', '/terminal/payments', { reference, amount, currency: 'EUR' });
    let view: { state: string; detail?: string } = { state: 'pending' };
    for (let i = 0; i < 200 && view.state === 'pending'; i++) {
      await sleep(50);
      view = (await service.handle('GET', `/terminal/payments/${reference}`, undefined)).body as typeof view;
    }
    if (o.mode === 'cloud') at('meridian', 'relayed_back');
    at('till', `final_${view.state}`);
    await other;
    const otherDebit = sims.nexo.sim.pays.get(`${reference}-C2`)?.state === 'authorized' ? 1 : 0;
    const debits = sims.nexo.sim.debits() - otherDebit;
    return { mode: o.mode, incident: o.incident, reference, amount, currency: 'EUR', state: view.state, detail: view.detail ?? null, orders, debits, durationMs: Date.now() - t0, steps };
  } finally {
    await sims.close();
  }
}
