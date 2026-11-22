// Interpréteur : exécute un module déclaratif pour un paiement. Aucun code propre à un PSP ici.
import { createHash, randomBytes } from 'node:crypto';
import { CURRENCIES, type FinalState } from '@meridian/core';
import { httpCall, RemoteError, type Fetcher } from './http.ts';
import type { CallDef, ModuleDef, StepDef } from './schema.ts';
import { get, matches, render } from './template.ts';

export interface TxContext {
  reference: string;
  amount: number;
  currency: string;
}

export interface StatusResult {
  state: FinalState | 'pending';
  detail?: string;
  data: Record<string, unknown>;
}

const major = (amount: number, currency: string) => {
  const d = (CURRENCIES as Record<string, number>)[currency] ?? 2;
  return Math.round(amount) / 10 ** d;
};

export class ModuleRuntime {
  constructor(
    public readonly def: ModuleDef,
    private readonly config: Record<string, unknown>,
    private readonly opts: { timeoutMs?: number; fetcher?: Fetcher; baseUrlOverride?: string } = {},
  ) {
    for (const c of def.config) {
      if (this.config[c.key] === undefined) throw new Error(`Module ${def.id} : paramètre manquant « ${c.key} »`);
    }
  }

  get id(): string {
    return this.def.id;
  }
  get steps(): StepDef[] {
    return this.def.pay.steps;
  }
  get canReplaySafely(): boolean {
    return Boolean(this.def.idempotency);
  }

  private ctx(tx: TxContext, vars: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      config: this.config,
      vars,
      tx: {
        ...tx,
        currencyLower: tx.currency.toLowerCase(),
        amountMajor: major(tx.amount, tx.currency),
        // Identifiant court et stable par référence (10 caractères alphanumériques), pour les PSP qui le limitent.
        serviceId: BigInt('0x' + createHash('sha256').update(tx.reference).digest('hex').slice(0, 16)).toString(36).slice(0, 10).padStart(10, '0'),
      },
      // Valeurs fraîches à chaque appel : horodatage et identifiant unique de message.
      now: { iso: new Date().toISOString(), nonce: randomBytes(8).toString('hex').slice(0, 10) },
      ...extra,
    };
  }

  private async call(spec: CallDef, ctx: Record<string, unknown>, idemKey?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.def.auth) headers[this.def.auth.header] = String(render(this.def.auth.value, ctx));
    if (idemKey && this.def.idempotency) headers[this.def.idempotency.header] = idemKey;
    const base = this.opts.baseUrlOverride ?? this.def.baseUrl;
    return httpCall(
      {
        method: spec.method,
        url: base.replace(/\/$/, '') + String(render(spec.path, ctx)),
        headers,
        body: spec.body ? (render(spec.body, ctx) as Record<string, unknown>) : undefined,
        encoding: this.def.encoding,
        timeoutMs: this.opts.timeoutMs ?? 8000,
        errorCodePath: this.def.errorCodePath,
        acceptText: spec.acceptText,
      },
      this.opts.fetcher,
    );
  }

  /** Exécute l'étape i ; renvoie les variables à retenir. */
  async runStep(i: number, tx: TxContext, vars: Record<string, unknown>): Promise<Record<string, unknown>> {
    const step = this.steps[i];
    if (!step) throw new Error(`Étape ${i} inexistante`);
    const json = await this.call(step, this.ctx(tx, vars), `${tx.reference}:${step.id}`);
    const saved: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(step.save ?? {})) saved[name] = get(json, path);
    return saved;
  }

  isRetryable(i: number, err: unknown): boolean {
    return err instanceof RemoteError && Boolean(err.code && this.steps[i]?.retryErrors?.includes(err.code));
  }

  async lookup(tx: TxContext): Promise<Record<string, unknown> | null> {
    if (!this.def.lookup) return null;
    const json = await this.call(this.def.lookup, this.ctx(tx, {}));
    if (this.def.lookup.notFound?.length && matches(this.def.lookup.notFound, json)) return null;
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(this.def.lookup.pick)) out[k] = get(json, p);
    return Object.values(out).some((v) => v != null) ? out : null;
  }

  async status(tx: TxContext, vars: Record<string, unknown>): Promise<StatusResult> {
    const data: Record<string, unknown> = {};
    for (const [name, src] of Object.entries(this.def.status.sources)) data[name] = await this.call(src, this.ctx(tx, vars));
    for (const rule of this.def.status.rules) {
      if (matches(rule.when, data, vars)) {
        const detail = rule.detailPath ? get(data, rule.detailPath) : undefined;
        return { state: rule.state, detail: detail == null ? undefined : String(detail), data };
      }
    }
    return { state: 'pending', data };
  }

  /** Annulation. Renvoie 'sent' ou 'too_late' (PSP occupé : autorisation en cours). */
  async cancel(tx: TxContext, vars: Record<string, unknown>): Promise<'sent' | 'too_late'> {
    try {
      await this.call(this.def.cancel, this.ctx(tx, vars));
      return 'sent';
    } catch (e) {
      if (e instanceof RemoteError && e.code && this.def.cancel.busyCodes.includes(e.code)) return 'too_late';
      throw e;
    }
  }

  async cleanup(tx: TxContext, vars: Record<string, unknown>): Promise<void> {
    if (this.def.cleanup) await this.call(this.def.cleanup, this.ctx(tx, vars));
  }

  async refund(tx: TxContext, vars: Record<string, unknown>, amount: number, n: number, receipt?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call(this.def.refund, this.ctx(tx, vars, { refund: { amount, number: n, amountMajor: major(amount, tx.currency) }, receipt: receipt ?? {} }), `${tx.reference}:refund:${n}`);
  }

  /** Variables que la caisse doit recevoir (secret client d'un paiement encaissé sur l'appareil). */
  exposed(vars: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!this.def.exposeVars?.length) return undefined;
    return Object.fromEntries(this.def.exposeVars.filter((k) => vars[k] !== undefined).map((k) => [k, vars[k]]));
  }

  async deviceToken(): Promise<string> {
    if (!this.def.deviceToken) throw new Error(`Module ${this.def.id} : pas de jeton d'appareil`);
    const json = await this.call(this.def.deviceToken, this.ctx({ reference: 'device', amount: 0, currency: 'EUR' }, {}));
    const v = get(json, this.def.deviceToken.pick);
    if (typeof v !== 'string') throw new Error('Jeton d\'appareil absent de la réponse');
    return v;
  }

  receipt(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(this.def.receipt ?? {})) {
      const v = get(data, p);
      if (v != null) out[k] = v;
    }
    return out;
  }

  async health(): Promise<boolean> {
    if (!this.def.health) return true;
    await this.call(this.def.health, this.ctx({ reference: 'health', amount: 0, currency: 'EUR' }, {}));
    return true;
  }
}
