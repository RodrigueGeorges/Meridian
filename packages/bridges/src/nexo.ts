// Passerelle nexo Retailer (ISO 20022), formes JSON et XML (SaleToPOIRequest / SaleToPOIResponse) sur HTTP.
// MessageCategory pris en charge : Login, Logout, Payment, Reversal, TransactionStatus, Abort, Reconciliation.
// POIID = point de vente Meridian ; SaleTransactionID.TransactionID = référence (idempotente).
import { CURRENCIES, type Currency } from '@meridian/core';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type { BridgeTarget } from './target.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const header = (h: Json, category: string) => ({ ...h, MessageCategory: category, MessageType: 'Response' });
const toMinor = (amount: number, currency: string) => Math.round(amount * 10 ** (CURRENCIES[currency as Currency] ?? 2));
const toMajor = (amount: number, currency: string) => amount / 10 ** (CURRENCIES[currency as Currency] ?? 2);
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined);
const reconciled = new Map<string, Set<string>>(); // POIID → références déjà rapprochées
const failure = (condition: string, text: string) => ({ Result: 'Failure', ErrorCondition: condition, AdditionalResponse: text });

export async function handleNexo(body: Json, target: BridgeTarget, opts: { timeoutMs?: number } = {}): Promise<Json> {
  const req = body?.SaleToPOIRequest;
  const h = req?.MessageHeader ?? {};
  const posId: string = h.POIID;
  const category: string = h.MessageCategory;
  if (!req || !posId || !category) return { SaleToPOIResponse: { MessageHeader: header(h, category ?? 'Unknown'), Response: failure('MessageFormat', 'MessageHeader incomplet') } };

  if (category === 'Login') {
    return {
      SaleToPOIResponse: {
        MessageHeader: header(h, category),
        LoginResponse: {
          Response: { Result: 'Success' },
          POISystemData: {
            DateTime: new Date().toISOString(),
            POISoftware: { ProviderIdentification: 'Meridian', ApplicationName: 'Meridian nexo Retailer', SoftwareVersion: '0.1.0' },
            POIStatus: { GlobalStatus: 'OK' },
          },
        },
      },
    };
  }
  if (category === 'Logout') return { SaleToPOIResponse: { MessageHeader: header(h, category), LogoutResponse: { Response: { Result: 'Success' } } } };

  if (category === 'Reconciliation') {
    // Rapprochement : paiements autorisés depuis le précédent rapprochement de ce point de vente.
    const type: string = req.ReconciliationRequest?.ReconciliationType ?? 'SaleReconciliation';
    const done = reconciled.get(posId) ?? new Set<string>();
    const fresh = target.list(posId).filter((v) => v.state === 'authorized' && !done.has(v.reference));
    const byCur = new Map<string, { n: number; amount: number }>();
    for (const v of fresh) {
      const t = byCur.get(v.currency) ?? { n: 0, amount: 0 };
      byCur.set(v.currency, { n: t.n + 1, amount: t.amount + v.amount - v.refunded });
      done.add(v.reference);
    }
    // Les références rapprochées sont conservées à vie : on borne la mémoire — les plus anciennes sont
    // réémises au prochain rapprochement (un total peut alors ré-inclure des paiements déjà comptés).
    if (done.size > 5000) for (const old of [...done].slice(0, done.size - 5000)) done.delete(old);
    reconciled.set(posId, done);
    return {
      SaleToPOIResponse: {
        MessageHeader: header(h, category),
        ReconciliationResponse: {
          Response: { Result: 'Success' }, ReconciliationType: type,
          TransactionTotals: [...byCur].map(([cur, t]) => ({ PaymentInstrumentType: 'Card', PaymentCurrency: cur, PaymentTotals: [{ TransactionType: 'Debit', TransactionCount: t.n, TransactionAmount: toMajor(t.amount, cur) }] })),
        },
      },
    };
  }

  if (category === 'Payment') {
    const p = req.PaymentRequest;
    const reference: string = p?.SaleData?.SaleTransactionID?.TransactionID;
    const cur: string = p?.PaymentTransaction?.AmountsReq?.Currency;
    const amt = num(p?.PaymentTransaction?.AmountsReq?.RequestedAmount);
    if (!reference || !cur || amt === undefined || Number.isNaN(amt)) return { SaleToPOIResponse: { MessageHeader: header(h, category), PaymentResponse: { Response: failure('MessageFormat', 'TransactionID, Currency et RequestedAmount obligatoires') } } };
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
      const amount = r?.ReversedAmount !== undefined ? toMinor(num(r.ReversedAmount) ?? 0, status.currency) : status.amount - status.refunded;
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

// ---------- Forme XML ----------
// En XML nexo, les valeurs simples sont des attributs et les blocs des éléments ; la forme JSON reprend les mêmes noms.
// Durcissement : aucune entité traitée (processEntities: false) et DOCTYPE refusé avant analyse —
// pas d'expansion d'entités (bombe XML) ni de référence externe.
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false, processEntities: false, isArray: (name) => ['TransactionTotals', 'PaymentTotals'].includes(name) });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', suppressEmptyNode: true, format: false });

export function nexoFromXml(xml: string): Json {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCTYPE/ENTITY interdit');
  return xmlParser.parse(xml) as Json;
}

function toXmlTree(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toXmlTree);
  if (v && typeof v === 'object') {
    const out: Json = {};
    for (const [k, x] of Object.entries(v as Json)) {
      if (x === undefined || x === null) continue;
      if (typeof x === 'object') out[k] = toXmlTree(x);
      else out[`@_${k}`] = String(x);
    }
    return out;
  }
  return v;
}

export function nexoToXml(body: Json): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${xmlBuilder.build(toXmlTree(body))}`;
}
