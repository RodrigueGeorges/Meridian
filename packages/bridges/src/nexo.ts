// Passerelle nexo Retailer (ISO 20022), forme JSON (SaleToPOIRequest / SaleToPOIResponse) sur HTTP.
// MessageCategory pris en charge : Payment, Reversal, TransactionStatus, Abort.
// POIID = point de vente Meridian ; SaleTransactionID.TransactionID = référence (idempotente).
import { CURRENCIES, type Currency } from '@meridian/core';
import type { BridgeTarget } from './target.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const header = (h: Json, category: string) => ({ ...h, MessageCategory: category, MessageType: 'Response' });
const toMinor = (amount: number, currency: string) => Math.round(amount * 10 ** (CURRENCIES[currency as Currency] ?? 2));
const toMajor = (amount: number, currency: string) => amount / 10 ** (CURRENCIES[currency as Currency] ?? 2);
const failure = (condition: string, text: string) => ({ Result: 'Failure', ErrorCondition: condition, AdditionalResponse: text });

export async function handleNexo(body: Json, target: BridgeTarget, opts: { timeoutMs?: number } = {}): Promise<Json> {
  const req = body?.SaleToPOIRequest;
  const h = req?.MessageHeader ?? {};
  const posId: string = h.POIID;
  const category: string = h.MessageCategory;
  if (!req || !posId || !category) return { SaleToPOIResponse: { MessageHeader: header(h, category ?? 'Unknown'), Response: failure('MessageFormat', 'MessageHeader incomplet') } };

  if (category === 'Payment') {
    const p = req.PaymentRequest;
    const reference: string = p?.SaleData?.SaleTransactionID?.TransactionID;
    const cur: string = p?.PaymentTransaction?.AmountsReq?.Currency;
    const amt: number = p?.PaymentTransaction?.AmountsReq?.RequestedAmount;
    if (!reference || !cur || typeof amt !== 'number') return { SaleToPOIResponse: { MessageHeader: header(h, category), PaymentResponse: { Response: failure('MessageFormat', 'TransactionID, Currency et RequestedAmount obligatoires') } } };
    try {
      await target.pay(posId, reference, toMinor(amt, cur), cur);
      const v = await target.waitFinal(posId, reference, opts.timeoutMs ?? 120_000);
      const r = target.receipt(posId, reference);
      const ok = v.state === 'authorized';
      return {
        SaleToPOIResponse: {
          MessageHeader: header(h, category),
          PaymentResponse: {
            Response: ok ? { Result: 'Success' } : failure(v.state === 'cancelled' ? 'Aborted' : v.state === 'pending' ? 'InProgress' : 'Refusal', v.detail ?? v.state),
            SaleData: p.SaleData,
            POIData: { POITransactionID: { TransactionID: reference, TimeStamp: new Date().toISOString() } },
            PaymentResult: ok
              ? { AmountsResp: { Currency: cur, AuthorizedAmount: toMajor(v.amount, cur) }, PaymentInstrumentData: { CardData: { PaymentBrand: r?.brand, MaskedPAN: r?.last4 ? `XXXXXXXXXXXX${r.last4}` : undefined } } }
              : undefined,
          },
        },
      };
    } catch (e) {
      return { SaleToPOIResponse: { MessageHeader: header(h, category), PaymentResponse: { Response: failure('Busy', (e as Error).message) } } };
    }
  }

  if (category === 'Reversal') {
    const r = req.ReversalRequest;
    const reference: string = r?.OriginalPOITransaction?.POITransactionID?.TransactionID;
    try {
      const status = target.status(posId, reference);
      const amount = r?.ReversedAmount !== undefined ? toMinor(r.ReversedAmount, status.currency) : status.amount - status.refunded;
      await target.refund(posId, reference, amount);
      return { SaleToPOIResponse: { MessageHeader: header(h, category), ReversalResponse: { Response: { Result: 'Success' }, ReversedAmount: toMajor(amount, status.currency) } } };
    } catch (e) {
      return { SaleToPOIResponse: { MessageHeader: header(h, category), ReversalResponse: { Response: failure('NotAllowed', (e as Error).message) } } };
    }
  }

  if (category === 'TransactionStatus') {
    const reference: string = req.TransactionStatusRequest?.MessageReference?.SaleID ?? req.TransactionStatusRequest?.MessageReference?.ServiceID;
    try {
      const v = target.status(posId, reference);
      return { SaleToPOIResponse: { MessageHeader: header(h, category), TransactionStatusResponse: { Response: v.state === 'pending' ? failure('InProgress', 'en cours') : { Result: 'Success' }, MeridianState: v.state } } };
    } catch (e) {
      return { SaleToPOIResponse: { MessageHeader: header(h, category), TransactionStatusResponse: { Response: failure('NotFound', (e as Error).message) } } };
    }
  }

  if (category === 'Abort') {
    const reference: string = req.AbortRequest?.MessageReference?.ServiceID;
    try {
      await target.cancel(posId, reference);
    } catch { /* un Abort n'a pas de réponse métier */ }
    return { SaleToPOIResponse: { MessageHeader: header(h, category), EventNotification: { EventToNotify: 'Abort' } } };
  }

  return { SaleToPOIResponse: { MessageHeader: header(h, category), Response: failure('NotAllowed', `Catégorie non prise en charge : ${category}`) } };
}
