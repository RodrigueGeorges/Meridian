// Pilote nexo Retailer (SaleToPOIRequest) sur HTTP local, côté caisse.
// nexo porte la référence (SaleTransactionID) et la consultation d'état (TransactionStatus) : une liaison perdue
// se résout en redemandant l'état au terminal.
import type { TerminalDriver, TerminalResult } from './types.ts';
import { LinkError } from './types.ts';
import { CURRENCIES, type Currency } from '@meridian/core';

export interface NexoDriverOptions { url: string; poiId: string; saleId?: string; timeoutMs?: number; fetcher?: typeof fetch }

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const major = (minor: number, c: string) => minor / 10 ** (CURRENCIES[c as Currency] ?? 2);

export class NexoDriver implements TerminalDriver {
  readonly protocol = 'nexo' as const;
  private n = 0;
  constructor(private readonly o: NexoDriverOptions) {}

  private header(category: string) {
    this.n = (this.n + 1) % 1_000_000;
    return { ProtocolVersion: '3.1', MessageClass: 'Service', MessageCategory: category, MessageType: 'Request', SaleID: this.o.saleId ?? 'MERIDIAN', ServiceID: String(Date.now() % 1e9 + this.n).slice(-10), POIID: this.o.poiId };
  }

  private async send(body: Json, timeoutMs?: number): Promise<Json> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.o.timeoutMs ?? 180_000);
    try {
      const r = await (this.o.fetcher ?? fetch)(this.o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ SaleToPOIRequest: body }), signal: ctrl.signal });
      return ((await r.json()) as Json).SaleToPOIResponse ?? {};
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      throw new LinkError((e as Error).message, code === 'ECONNREFUSED');
    } finally {
      clearTimeout(timer);
    }
  }

  private result(resp: Json, reference: string): TerminalResult {
    const p = resp.PaymentResponse ?? {};
    const res = p.Response ?? {};
    if (res.Result === 'Success') {
      const card = p.PaymentResult?.PaymentInstrumentData?.CardData ?? {};
      return { state: 'authorized', brand: card.PaymentBrand, last4: typeof card.MaskedPAN === 'string' ? card.MaskedPAN.slice(-4) : undefined, terminalRef: p.POIData?.POITransactionID?.TransactionID ?? reference };
    }
    if (res.ErrorCondition === 'Aborted' || res.ErrorCondition === 'Cancel') return { state: 'cancelled', detail: 'aborted' };
    if (res.ErrorCondition === 'InProgress' || res.ErrorCondition === 'Busy') return { state: 'unknown', detail: `nexo_${res.ErrorCondition}` };
    return { state: 'declined', detail: res.ErrorCondition === 'Refusal' ? 'card_declined' : `nexo_${res.ErrorCondition ?? 'error'}` };
  }

  async pay(p: { reference: string; amount: number; currency: string }): Promise<TerminalResult> {
    try {
      const resp = await this.send({
        MessageHeader: this.header('Payment'),
        PaymentRequest: { SaleData: { SaleTransactionID: { TransactionID: p.reference, TimeStamp: new Date().toISOString() } }, PaymentTransaction: { AmountsReq: { Currency: p.currency, RequestedAmount: major(p.amount, p.currency) } } },
      });
      return this.result(resp, p.reference);
    } catch (e) {
      if (e instanceof LinkError && e.beforeSend) throw e;
      return this.status(p.reference);
    }
  }

  /** Redemande l'issue au terminal après une liaison perdue. */
  async status(reference: string): Promise<TerminalResult> {
    try {
      const resp = await this.send({ MessageHeader: this.header('TransactionStatus'), TransactionStatusRequest: { MessageReference: { MessageCategory: 'Payment', SaleID: reference } } }, 10_000);
      const t = resp.TransactionStatusResponse ?? {};
      if (t.MeridianState === 'authorized' || t.RepeatedMessageResponse?.RepeatedResponseMessageBody?.PaymentResponse?.Response?.Result === 'Success') return { state: 'authorized', terminalRef: reference };
      if (t.Response?.ErrorCondition === 'InProgress') return { state: 'unknown', detail: 'terminal_in_progress' };
      if (t.MeridianState === 'declined') return { state: 'declined', detail: 'card_declined' };
      if (t.MeridianState === 'cancelled') return { state: 'cancelled', detail: 'aborted' };
      return { state: 'unknown', detail: 'terminal_link_lost' };
    } catch {
      return { state: 'unknown', detail: 'terminal_link_lost' };
    }
  }

  async cancel(reference: string): Promise<'sent' | 'unsupported'> {
    await this.send({ MessageHeader: this.header('Abort'), AbortRequest: { AbortReason: 'MerchantAbort', MessageReference: { MessageCategory: 'Payment', ServiceID: reference, SaleID: reference } } }, 10_000);
    return 'sent';
  }

  async refund(p: { reference: string; amount: number; currency: string; terminalRef?: string }): Promise<'done' | 'refused'> {
    const resp = await this.send({
      MessageHeader: this.header('Reversal'),
      ReversalRequest: { OriginalPOITransaction: { POITransactionID: { TransactionID: p.terminalRef ?? p.reference, TimeStamp: new Date().toISOString() } }, ReversalReason: 'MerchantCancel', ReversedAmount: major(p.amount, p.currency) },
    });
    return resp.ReversalResponse?.Response?.Result === 'Success' ? 'done' : 'refused';
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.send({ MessageHeader: this.header('Login'), LoginRequest: { DateTime: new Date().toISOString(), SaleSoftware: { ProviderIdentification: 'Meridian', ApplicationName: 'Meridian Edge', SoftwareVersion: '0.1.0' } } }, 5000);
      return r.LoginResponse?.Response?.Result === 'Success';
    } catch {
      return false;
    }
  }
}
