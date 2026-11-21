// SDK Meridian pour caisses web, bornes et kiosques. Aucune dépendance.
// Règle : une absence de réponse n'est jamais un échec. Le SDK rejoue avec la même référence (sûr : idempotent).

export type PaymentState = 'created' | 'pending' | 'authorized' | 'declined' | 'cancelled' | 'failed';
export interface Payment {
  posId: string;
  reference: string;
  amount: number;
  currency: string;
  state: PaymentState;
  detail?: string;
  module: string;
  refunded: number;
}
export interface Receipt {
  reference: string;
  amount: number;
  currency: string;
  brand?: string;
  last4?: string;
  proof: { seq: number; hash: string; signature: string; at: string };
}

export class MeridianApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface MeridianOptions {
  apiKey: string;
  posId: string;
  baseUrl?: string;
  /** Nombre de rejeux sur erreur réseau. */
  retries?: number;
  fetch?: typeof fetch;
}

const FINAL = new Set(['authorized', 'declined', 'cancelled', 'failed']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Meridian {
  private base: string;
  private f: typeof fetch;
  constructor(private readonly o: MeridianOptions) {
    this.base = (o.baseUrl ?? 'https://api.meridian.example').replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const retries = this.o.retries ?? 4;
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await this.f(this.base + path, {
          method,
          headers: { authorization: `Bearer ${this.o.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        const json = (await res.json()) as { error?: { code: string; message: string } };
        if (!res.ok) {
          // 503 refund_pending = issue inconnue côté PSP : on rejoue la même demande.
          if (res.status === 503 && i < retries) {
            await sleep(400 * 2 ** i);
            continue;
          }
          throw new MeridianApiError(res.status, json.error?.code ?? 'error', json.error?.message ?? res.statusText);
        }
        return json as T;
      } catch (e) {
        if (e instanceof MeridianApiError) throw e;
        lastErr = e;
        await sleep(300 * 2 ** i);
      }
    }
    throw lastErr;
  }

  /** Lance un paiement. Rejouer avec la même référence renvoie le même paiement. */
  pay(p: { reference: string; amount: number; currency: string; waitMs?: number }): Promise<Payment> {
    return this.req('POST', '/v1/payments', { posId: this.o.posId, ...p });
  }
  status(reference: string): Promise<Payment> {
    return this.req('GET', `/v1/payments/${encodeURIComponent(reference)}?posId=${encodeURIComponent(this.o.posId)}`);
  }
  cancel(reference: string): Promise<Payment> {
    return this.req('POST', `/v1/payments/${encodeURIComponent(reference)}/cancel`, { posId: this.o.posId });
  }
  refund(reference: string, p: { amount: number; refundNumber: number }): Promise<Payment> {
    return this.req('POST', `/v1/payments/${encodeURIComponent(reference)}/refunds`, { posId: this.o.posId, ...p });
  }
  receipt(reference: string): Promise<Receipt> {
    return this.req('GET', `/v1/payments/${encodeURIComponent(reference)}/receipt?posId=${encodeURIComponent(this.o.posId)}`);
  }

  /** Attend un état final. onUpdate reçoit chaque état (afficher « en cours », jamais « échec » sans issue). */
  async waitForFinal(reference: string, opts: { timeoutMs?: number; onUpdate?: (p: Payment) => void } = {}): Promise<Payment> {
    const end = Date.now() + (opts.timeoutMs ?? 120_000);
    let last: Payment | undefined;
    while (Date.now() < end) {
      try {
        last = await this.req<Payment>('GET', `/v1/payments/${encodeURIComponent(reference)}?posId=${encodeURIComponent(this.o.posId)}&waitMs=10000`);
        opts.onUpdate?.(last);
        if (FINAL.has(last.state)) return last;
      } catch (e) {
        if (e instanceof MeridianApiError && e.status < 500) throw e;
      }
    }
    if (last) return last;
    throw new Error('Délai dépassé sans réponse : relancez waitForFinal, le paiement n’est pas perdu');
  }
}
