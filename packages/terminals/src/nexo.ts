// Pilote nexo Retailer (SaleToPOIRequest) sur HTTP local, côté caisse.
// Ce que la caisse n'a plus à coder elle-même, d'après la norme nexo et les intégrations publiques qui la suivent :
//   - session : Login avant le premier ordre, renouvelée si le terminal la déclare fermée (option `session`) ;
//   - bon terminal : le POIID renvoyé doit être celui attendu (terminal échangé ou mauvaise adresse IP) ;
//   - terminal occupé (Busy) : l'ordre n'a pas été pris, refus certain sans débit ;
//   - réponse perdue ou délai dépassé : TransactionStatus sur le couple (SaleID, ServiceID) de la demande, répété
//     tant que le terminal répond « InProgress » ; « NotFound » = la demande n'est jamais arrivée.
// Le ServiceID est dérivé de la référence : après un redémarrage de l'agent, l'état se redemande toujours.
import { createHash } from 'node:crypto';
import type { TerminalDriver, TerminalResult } from './types.ts';
import { LinkError } from './types.ts';
import { CURRENCIES, type Currency } from '@meridian/core';

export interface NexoDriverOptions {
  url: string;
  poiId: string;
  saleId?: string;
  /** Délai d'attente d'une réponse de paiement (120 s en local chez la plupart des terminaux). */
  timeoutMs?: number;
  /** Ouvre une session (Login) avant le premier ordre ; certains terminaux l'exigent. */
  session?: boolean;
  /** Intervalle entre deux TransactionStatus pendant la reprise. */
  pollMs?: number;
  /** Durée maximale de la reprise avant de laisser le paiement « en cours ». */
  recoverMs?: number;
  fetcher?: typeof fetch;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const major = (minor: number, c: string) => minor / 10 ** (CURRENCIES[c as Currency] ?? 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ServiceID stable (10 caractères) pour une référence et une catégorie données. */
export const serviceIdOf = (reference: string, category = 'Payment') => createHash('sha256').update(`${category}:${reference}`).digest('hex').slice(0, 10);

export class NexoDriver implements TerminalDriver {
  readonly protocol = 'nexo' as const;
  private n = 0;
  private loggedIn = false;
  constructor(private readonly o: NexoDriverOptions) {}

  private get saleId() { return this.o.saleId ?? 'MERIDIAN'; }

  private header(category: string, serviceId?: string) {
    this.n = (this.n + 1) % 1_000_000;
    return { ProtocolVersion: '3.1', MessageClass: 'Service', MessageCategory: category, MessageType: 'Request', SaleID: this.saleId, ServiceID: serviceId ?? serviceIdOf(`${Date.now()}-${this.n}`, category), POIID: this.o.poiId };
  }

  private async send(body: Json, timeoutMs?: number): Promise<Json> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.o.timeoutMs ?? 120_000);
    let resp: Json;
    try {
      const r = await (this.o.fetcher ?? fetch)(this.o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ SaleToPOIRequest: body }), signal: ctrl.signal });
      resp = ((await r.json()) as Json).SaleToPOIResponse ?? {};
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      throw new LinkError((e as Error).message, code === 'ECONNREFUSED' || code === 'EHOSTUNREACH');
    } finally {
      clearTimeout(timer);
    }
    const poi = resp.MessageHeader?.POIID;
    if (poi && poi !== this.o.poiId) throw new LinkError(`Terminal inattendu : ${poi} au lieu de ${this.o.poiId}`, false, 'terminal_mismatch');
    return resp;
  }

  private async login(): Promise<boolean> {
    const r = await this.send({ MessageHeader: this.header('Login'), LoginRequest: { DateTime: new Date().toISOString(), SaleSoftware: { ProviderIdentification: 'Meridian', ApplicationName: 'Meridian Edge', SoftwareVersion: '0.2.0' }, OperatorLanguage: 'fr' } }, 5000);
    this.loggedIn = r.LoginResponse?.Response?.Result === 'Success';
    return this.loggedIn;
  }

  private async ensureSession() {
    if (!this.o.session || this.loggedIn) return;
    // Un Login qui échoue avant tout ordre de paiement ne débite rien : refus certain.
    try {
      if (!(await this.login())) throw new LinkError('Session refusée par le terminal', true, 'terminal_login_refused');
    } catch (e) {
      if (e instanceof LinkError && e.code === 'terminal_mismatch') throw new LinkError(e.message, true, e.code);
      if (e instanceof LinkError) throw new LinkError(e.message, true, e.code ?? 'terminal_unreachable');
      throw e;
    }
  }

  private result(p: Json, reference: string): TerminalResult {
    const res = p.Response ?? {};
    if (res.Result === 'Success') {
      const card = p.PaymentResult?.PaymentInstrumentData?.CardData ?? {};
      return { state: 'authorized', brand: card.PaymentBrand, last4: typeof card.MaskedPAN === 'string' ? card.MaskedPAN.slice(-4) : undefined, terminalRef: p.POIData?.POITransactionID?.TransactionID ?? reference };
    }
    if (res.ErrorCondition === 'Aborted' || res.ErrorCondition === 'Cancel') return { state: 'cancelled', detail: 'aborted' };
    if (res.ErrorCondition === 'InProgress') return { state: 'unknown', detail: 'terminal_in_progress' };
    return { state: 'declined', detail: res.ErrorCondition === 'Refusal' ? 'card_declined' : `nexo_${res.ErrorCondition ?? 'error'}` };
  }

  async pay(p: { reference: string; amount: number; currency: string }): Promise<TerminalResult> {
    await this.ensureSession();
    const sid = serviceIdOf(p.reference);
    const order = () => this.send({
      MessageHeader: this.header('Payment', sid),
      PaymentRequest: { SaleData: { SaleTransactionID: { TransactionID: p.reference, TimeStamp: new Date().toISOString() } }, PaymentTransaction: { AmountsReq: { Currency: p.currency, RequestedAmount: major(p.amount, p.currency) } } },
    });
    let resp: Json;
    try {
      resp = await order();
      const cond = resp.PaymentResponse?.Response?.ErrorCondition;
      // Session expirée (redémarrage du terminal) : l'ordre n'a pas été pris, on rouvre la session et on le renvoie une fois.
      if (this.o.session && (cond === 'LoggedOut' || (cond === 'NotAllowed' && /login|session/i.test(resp.PaymentResponse?.Response?.AdditionalResponse ?? '')))) {
        this.loggedIn = false;
        await this.ensureSession();
        resp = await order();
      }
    } catch (e) {
      if (e instanceof LinkError && e.beforeSend) throw e;
      if (e instanceof LinkError && e.code === 'terminal_mismatch') return { state: 'unknown', detail: 'terminal_mismatch' };
      return this.recover(p.reference);
    }
    const cond = resp.PaymentResponse?.Response?.ErrorCondition;
    // Busy : le terminal traite une autre opération et n'a pas pris celle-ci.
    if (cond === 'Busy') throw new LinkError('Terminal occupé par une autre opération', true, 'terminal_busy');
    const out = this.result(resp.PaymentResponse ?? {}, p.reference);
    return out.state === 'unknown' ? this.recover(p.reference) : out;
  }

  /** Reprise après une réponse perdue : TransactionStatus répété tant que le terminal dit « en cours ». */
  private async recover(reference: string): Promise<TerminalResult> {
    const until = Date.now() + (this.o.recoverMs ?? 150_000);
    let last: TerminalResult = { state: 'unknown', detail: 'terminal_link_lost' };
    do {
      last = await this.status(reference);
      if (last.state !== 'unknown' || last.detail !== 'terminal_in_progress') return last;
      await sleep(this.o.pollMs ?? 3000);
    } while (Date.now() < until);
    return last;
  }

  /** Redemande l'issue d'un paiement au terminal. */
  async status(reference: string): Promise<TerminalResult> {
    try {
      const resp = await this.send({ MessageHeader: this.header('TransactionStatus'), TransactionStatusRequest: { MessageReference: { MessageCategory: 'Payment', SaleID: this.saleId, ServiceID: serviceIdOf(reference) } } }, 10_000);
      const t = resp.TransactionStatusResponse ?? {};
      const cond = t.Response?.ErrorCondition;
      if (t.Response?.Result === 'Success') {
        const p = t.RepeatedMessageResponse?.RepeatedResponseMessageBody?.PaymentResponse;
        return p ? this.result(p, reference) : { state: 'unknown', detail: 'terminal_status_incomplete' };
      }
      if (cond === 'InProgress') return { state: 'unknown', detail: 'terminal_in_progress' };
      // Le terminal ne connaît pas la demande : elle n'est jamais arrivée, rien n'a été débité.
      if (cond === 'NotFound') return { state: 'declined', detail: 'terminal_not_received' };
      return { state: 'unknown', detail: 'terminal_link_lost' };
    } catch {
      return { state: 'unknown', detail: 'terminal_link_lost' };
    }
  }

  async cancel(reference: string): Promise<'sent' | 'unsupported'> {
    await this.send({ MessageHeader: this.header('Abort'), AbortRequest: { AbortReason: 'MerchantAbort', MessageReference: { MessageCategory: 'Payment', SaleID: this.saleId, ServiceID: serviceIdOf(reference) } } }, 10_000);
    return 'sent';
  }

  async refund(p: { reference: string; amount: number; currency: string; terminalRef?: string }): Promise<'done' | 'refused'> {
    await this.ensureSession();
    const resp = await this.send({
      MessageHeader: this.header('Reversal'),
      ReversalRequest: { OriginalPOITransaction: { POITransactionID: { TransactionID: p.terminalRef ?? p.reference, TimeStamp: new Date().toISOString() } }, ReversalReason: 'MerchantCancel', ReversedAmount: major(p.amount, p.currency) },
    });
    return resp.ReversalResponse?.Response?.Result === 'Success' ? 'done' : 'refused';
  }

  async health(): Promise<boolean> {
    try {
      return await this.login();
    } catch {
      this.loggedIn = false;
      return false;
    }
  }

  /** Ferme la session ouverte (arrêt de l'agent). */
  async close(): Promise<void> {
    if (!this.loggedIn) return;
    try { await this.send({ MessageHeader: this.header('Logout'), LogoutRequest: {} }, 5000); } catch { /* terminal déjà parti */ }
    this.loggedIn = false;
  }
}
