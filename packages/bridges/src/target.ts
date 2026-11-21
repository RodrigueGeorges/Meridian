// Interface commune des passerelles : chaque protocole de caisse existant est traduit vers les 5 appels du moteur.
// Aucune logique de paiement ici : le moteur garde la fiabilité (journal, idempotence, reprise).
import type { Engine, PaymentView } from '@meridian/engine';

export interface BridgeTarget {
  pay(posId: string, reference: string, amount: number, currency: string): Promise<PaymentView>;
  status(posId: string, reference: string): PaymentView;
  waitFinal(posId: string, reference: string, timeoutMs: number): Promise<PaymentView>;
  cancel(posId: string, reference: string): Promise<PaymentView>;
  refund(posId: string, reference: string, amount: number): Promise<PaymentView>;
  receipt(posId: string, reference: string): { brand?: string; last4?: string; proof: { seq: number } } | undefined;
  /** Dernier paiement autorisé remboursable de ce montant (Concert et ZVT ne portent pas de référence d'origine). */
  lastRefundable(posId: string, amount: number): PaymentView | undefined;
}

export function engineTarget(engine: Engine): BridgeTarget {
  return {
    pay: (posId, reference, amount, currency) => engine.pay({ posId, reference, amount, currency }),
    status: (posId, reference) => engine.status(posId, reference),
    waitFinal: (posId, reference, timeoutMs) => engine.waitForFinal(posId, reference, timeoutMs),
    cancel: (posId, reference) => engine.cancel(posId, reference),
    refund: (posId, reference, amount) => engine.refund(posId, reference, amount),
    receipt: (posId, reference) => {
      try {
        return engine.receipt(posId, reference);
      } catch {
        return undefined;
      }
    },
    lastRefundable: (posId, amount) => engine.list(posId).find((p) => p.state === 'authorized' && p.amount - p.refunded >= amount),
  };
}

export const ISO_NUMERIC: Record<string, string> = { '978': 'EUR', '756': 'CHF', '826': 'GBP', '752': 'SEK', '208': 'DKK', '578': 'NOK', '985': 'PLN', '203': 'CZK' };
export const ISO_NUMERIC_REV: Record<string, string> = Object.fromEntries(Object.entries(ISO_NUMERIC).map(([k, v]) => [v, k]));

export const bridgeRef = (proto: string, id: string) =>
  `${proto}-${id}-${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
