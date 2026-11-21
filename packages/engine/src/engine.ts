// Moteur Meridian : un seul cycle de vie pour tous les PSP.
// Règles : journal avant envoi, idempotence par étape, réseau coupé = « en cours » (jamais « échec »),
// reprise depuis le journal, bascule uniquement avant tout envoi confirmé.
import {
  assertAmount, isFinal, MeridianError,
  type Currency, type FinalState, type JournalEntry, type PaymentState, type Receipt,
} from '@meridian/core';
import { ModuleRuntime, NetError, RemoteError, type Fetcher, type ModuleDef } from '@meridian/modules';
import type { Journal } from './journal.ts';

export interface ModuleBinding {
  moduleId: string;
  config: Record<string, unknown>;
  /** Uniquement en mode test (simulateur). */
  baseUrl?: string;
}
export interface PosRouting {
  posId: string;
  country: string;
  currency: Currency;
  primary: ModuleBinding;
  fallback?: ModuleBinding;
}
export type RoutingResolver = (posId: string) => Promise<PosRouting | undefined>;

export interface PaymentView {
  posId: string;
  reference: string;
  amount: number;
  currency: Currency;
  state: PaymentState;
  detail?: string;
  module: string;
  refunded: number;
}

interface Tx {
  posId: string;
  reference: string;
  amount: number;
  currency: Currency;
  binding: ModuleBinding;
  usingFallback: boolean;
  vars: Record<string, unknown>;
  step: number;
  state: PaymentState;
  detail?: string;
  cancelRequested: boolean;
  cancelSent: boolean;
  refunds: { n: number; amount: number }[];
  receipt?: Record<string, unknown>;
  final?: JournalEntry;
  startedAt: number;
  done?: Promise<void>;
  waiters: (() => void)[];
  /** Vrai si cette instance pilote le paiement. */
  driving: boolean;
}

/** Coordination multi-instance (PostgreSQL) : un seul pilote par paiement, état partagé via le journal. */
export interface Cluster {
  tryClaim(posId: string, reference: string): Promise<boolean>;
  release(posId: string, reference: string): Promise<void>;
  activeOnPos(posId: string): Promise<string | undefined>;
  unfinished(): Promise<{ posId: string; reference: string }[]>;
  byPos(posId: string): Promise<JournalEntry[]>;
}

export interface EngineEvents {
  onFinal?: (view: PaymentView) => void;
  onRefund?: (view: PaymentView, amount: number) => void;
}

export interface EngineOptions extends EngineEvents {
  journal: Journal;
  modules: Record<string, ModuleDef>;
  routing: RoutingResolver;
  pollMs?: number;
  retryMs?: number;
  payTimeoutMs?: number;
  httpTimeoutMs?: number;
  fetcher?: Fetcher;
  cluster?: Cluster;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (posId: string, ref: string) => `${posId}\u0000${ref}`;

export class Engine {
  private txs = new Map<string, Tx>();
  private activeByPos = new Map<string, string>();
  private alive = true;
  private timers: NodeJS.Timeout[] = [];
  private readonly pollMs: number;
  private readonly retryMs: number;
  private readonly payTimeoutMs: number;

  constructor(private readonly o: EngineOptions) {
    this.pollMs = o.pollMs ?? 500;
    this.retryMs = o.retryMs ?? 800;
    this.payTimeoutMs = o.payTimeoutMs ?? 90_000;
  }

  // ---------------- API publique (5 appels) ----------------

  async pay(input: { posId: string; reference: string; amount: number; currency: string }): Promise<PaymentView> {
    const { posId, reference, amount, currency } = input;
    if (!reference || reference.length > 64) throw new MeridianError('invalid_reference', 'Référence obligatoire, 64 caractères maximum', 400);
    assertAmount(amount, currency);
    const same = (t: Tx) => {
      if (t.amount !== amount || t.currency !== currency) {
        throw new MeridianError('reference_conflict', 'Cette référence existe déjà avec un autre montant ou une autre devise', 409);
      }
      return this.view(t);
    };
    const existing = this.txs.get(key(posId, reference)) ?? (this.o.cluster ? await this.fresh(posId, reference).catch(() => undefined) : undefined);
    if (existing) return same(existing);
    const routing = await this.o.routing(posId);
    if (!routing) throw new MeridianError('pos_not_configured', `Point de vente inconnu ou non configuré : ${posId}`, 422);
    if (routing.currency !== currency) throw new MeridianError('currency_mismatch', `Ce point de vente encaisse en ${routing.currency}`, 400);
    const active = this.activeByPos.get(posId) ?? (this.o.cluster ? await this.o.cluster.activeOnPos(posId) : undefined);
    if (active && active !== reference) throw new MeridianError('terminal_busy', `Un paiement est déjà en cours sur ce terminal (${active})`, 409);
    this.module(routing.primary.moduleId); // vérifie que le module existe

    const tx: Tx = {
      posId, reference, amount, currency: currency as Currency, binding: routing.primary, usingFallback: false,
      vars: {}, step: 0, state: 'created', cancelRequested: false, cancelSent: false, refunds: [], startedAt: Date.now(), waiters: [], driving: true,
    };
    this.txs.set(key(posId, reference), tx);
    this.activeByPos.set(posId, reference);
    try {
      await this.o.journal.append({ posId, reference, type: 'created', data: { amount, currency, module: tx.binding.moduleId, country: routing.country } });
    } catch (e) {
      this.txs.delete(key(posId, reference));
      this.activeByPos.delete(posId);
      // Course entre instances : une autre a créé ce paiement juste avant (index unique en base).
      if ((e as { code?: string }).code === '23505') return same(await this.fresh(posId, reference));
      throw e;
    }
    tx.state = 'pending';
    tx.done = this.safeDrive(tx, false);
    return this.view(tx);
  }

  status(posId: string, reference: string): PaymentView {
    return this.view(this.get(posId, reference));
  }

  /** État à jour, y compris pour un paiement piloté par une autre instance. */
  async statusFresh(posId: string, reference: string): Promise<PaymentView> {
    return this.view(await this.fresh(posId, reference));
  }

  async waitForFinal(posId: string, reference: string, timeoutMs: number): Promise<PaymentView> {
    const end = Date.now() + timeoutMs;
    let tx = await this.fresh(posId, reference);
    while (!isFinal(tx.state) && Date.now() < end) {
      if (tx.driving) await Promise.race([new Promise<void>((r) => tx.waiters.push(r)), sleep(Math.max(0, end - Date.now()))]);
      else await sleep(Math.min(this.pollMs * 2, Math.max(0, end - Date.now())));
      tx = await this.fresh(posId, reference);
    }
    return this.view(tx);
  }

  async cancel(posId: string, reference: string): Promise<PaymentView> {
    const tx = await this.fresh(posId, reference);
    if (isFinal(tx.state) || tx.cancelRequested) return this.view(tx);
    tx.cancelRequested = true;
    // Si une autre instance pilote ce paiement, elle lit la demande dans le journal.
    await this.o.journal.append({ posId, reference, type: 'cancel_requested', data: {} });
    return this.view(tx);
  }

  async refund(posId: string, reference: string, amount: number, refundNumber?: number): Promise<PaymentView> {
    const tx = await this.fresh(posId, reference);
    if (tx.state !== 'authorized') throw new MeridianError('not_refundable', 'Seul un paiement autorisé peut être remboursé', 400);
    assertAmount(amount, tx.currency);
    const n = refundNumber ?? tx.refunds.length + 1;
    const already = tx.refunds.find((r) => r.n === n);
    if (already) {
      if (already.amount !== amount) throw new MeridianError('refund_conflict', `Le remboursement n°${n} existe avec un autre montant`, 409);
      return this.view(tx);
    }
    const total = tx.refunds.reduce((s, r) => s + r.amount, 0);
    if (total + amount > tx.amount) throw new MeridianError('refund_exceeds_amount', 'Le cumul des remboursements dépasse le montant payé', 400);
    const rt = this.runtime(tx);
    try {
      await rt.refund(this.ctx(tx), tx.vars, amount, n);
    } catch (e) {
      if (e instanceof NetError) throw new MeridianError('refund_pending', 'Issue inconnue : renvoyez la même demande avec le même refundNumber', 503);
      throw new MeridianError('refund_failed', (e as Error).message, 502);
    }
    tx.refunds.push({ n, amount });
    await this.o.journal.append({ posId, reference, type: 'refund', data: { n, amount } });
    this.o.onRefund?.(this.view(tx), amount);
    return this.view(tx);
  }

  receipt(posId: string, reference: string): Receipt {
    const tx = this.get(posId, reference);
    if (!tx.final) throw new MeridianError('not_final', 'Le paiement n’est pas terminé', 409);
    return {
      reference, posId, amount: tx.amount, currency: tx.currency, module: tx.binding.moduleId, state: tx.state,
      brand: tx.receipt?.brand as string | undefined,
      last4: tx.receipt?.last4 as string | undefined,
      proof: { seq: tx.final.seq, hash: tx.final.hash, signature: tx.final.sig, at: tx.final.ts },
    };
  }

  async receiptFresh(posId: string, reference: string): Promise<Receipt> {
    await this.fresh(posId, reference);
    return this.receipt(posId, reference);
  }

  list(posId?: string): PaymentView[] {
    return [...this.txs.values()].filter((t) => !posId || t.posId === posId).map((t) => this.view(t)).reverse();
  }

  /** Liste d'un point de vente, depuis le journal partagé en mode cluster. */
  async listFresh(posId: string): Promise<PaymentView[]> {
    if (!this.o.cluster) return this.list(posId);
    const groups = new Map<string, JournalEntry[]>();
    for (const e of await this.o.cluster.byPos(posId)) {
      if (!groups.has(e.reference)) groups.set(e.reference, []);
      groups.get(e.reference)!.push(e);
    }
    const out: PaymentView[] = [];
    for (const list of groups.values()) {
      const local = this.txs.get(key(posId, list[0]!.reference));
      const t = local?.driving ? local : await this.rebuild(list);
      if (t) out.push(this.view(t));
    }
    return out.reverse();
  }

  // ---------------- Reprise ----------------

  /** Reconstruit un paiement depuis ses entrées de journal (event sourcing). */
  private async rebuild(list: JournalEntry[]): Promise<Tx | undefined> {
    const created = list.find((e) => e.type === 'created');
    if (!created) return undefined;
    const routing = await this.o.routing(created.posId);
    const d = created.data as { amount: number; currency: Currency; module: string };
    const tx: Tx = {
      posId: created.posId, reference: created.reference, amount: d.amount, currency: d.currency,
      binding: routing?.primary.moduleId === d.module ? routing.primary : { moduleId: d.module, config: {} },
      usingFallback: false, vars: {}, step: 0, state: 'pending', cancelRequested: false, cancelSent: false,
      refunds: [], startedAt: Date.parse(created.ts), waiters: [], driving: false,
    };
    for (const e of list) {
      if (e.type === 'step') {
        tx.step++;
        Object.assign(tx.vars, (e.data as { vars?: Record<string, unknown> }).vars ?? {});
      } else if (e.type === 'fallback' && routing?.fallback) {
        tx.binding = routing.fallback; tx.usingFallback = true; tx.vars = {}; tx.step = 0;
      } else if (e.type === 'cancel_requested') tx.cancelRequested = true;
      else if (e.type === 'cancel_sent' || e.type === 'cancel_refused') tx.cancelSent = true;
      else if (e.type === 'refund') {
        const r = e.data as { n: number; amount: number };
        if (!tx.refunds.some((x) => x.n === r.n)) tx.refunds.push(r);
      } else if (e.type === 'final') {
        const f = e.data as { state: FinalState; detail?: string; receipt?: Record<string, unknown> };
        tx.state = f.state; tx.detail = f.detail ?? undefined; tx.receipt = f.receipt ?? undefined; tx.final = e;
      }
    }
    return tx;
  }

  /** Paiement à jour : local s'il est piloté ici ou terminé, sinon relu depuis le journal partagé. */
  private async fresh(posId: string, reference: string): Promise<Tx> {
    const local = this.txs.get(key(posId, reference));
    if (local && (local.driving || isFinal(local.state) || !this.o.cluster)) return local;
    const t = await this.rebuild(await this.o.journal.byReference(posId, reference));
    if (!t) {
      if (local) return local;
      throw new MeridianError('payment_not_found', 'Paiement introuvable', 404);
    }
    if (local) t.waiters = local.waiters;
    this.txs.set(key(posId, reference), t);
    return t;
  }

  async recover(): Promise<{ resumed: number; loaded: number }> {
    const entries = await this.o.journal.all();
    const byKey = new Map<string, JournalEntry[]>();
    for (const e of entries) {
      const k = key(e.posId, e.reference);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(e);
    }
    let resumed = 0;
    for (const list of byKey.values()) {
      const tx = await this.rebuild(list);
      if (!tx) continue;
      this.txs.set(key(tx.posId, tx.reference), tx);
      if (!isFinal(tx.state) && (await this.o.routing(tx.posId))) {
        tx.done = this.safeDrive(tx, true);
        resumed++;
      }
    }
    return { resumed, loaded: byKey.size };
  }

  /** Mode cluster : reprend régulièrement les paiements orphelins (instance tombée). */
  startScanner(intervalMs = 3000): void {
    if (!this.o.cluster) return;
    const cluster = this.o.cluster;
    let running = false;
    const timer = setInterval(async () => {
      if (!this.alive || running) return;
      running = true;
      try {
        for (const { posId, reference } of await cluster.unfinished()) {
          if (this.txs.get(key(posId, reference))?.driving) continue;
          const tx = await this.rebuild(await this.o.journal.byReference(posId, reference));
          if (!tx || isFinal(tx.state) || !(await this.o.routing(posId))) continue;
          const prev = this.txs.get(key(posId, reference));
          if (prev) tx.waiters = prev.waiters;
          this.txs.set(key(posId, reference), tx);
          tx.done = this.safeDrive(tx, true);
        }
      } catch (e) {
        console.error('[meridian] scanner :', (e as Error).message);
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  /** Simule une coupure : plus aucune action du moteur (tests de crash). */
  kill(): void {
    this.alive = false;
    this.timers.forEach(clearInterval);
  }
  async idle(): Promise<void> {
    await Promise.all([...this.txs.values()].map((t) => t.done));
  }
  verify() {
    return this.o.journal.verify();
  }

  // ---------------- Pilotage ----------------

  private async safeDrive(tx: Tx, recovered: boolean): Promise<void> {
    const cluster = this.o.cluster;
    if (cluster && !(await cluster.tryClaim(tx.posId, tx.reference))) {
      tx.driving = false; // une autre instance pilote déjà ce paiement
      return;
    }
    tx.driving = true;
    this.activeByPos.set(tx.posId, tx.reference);
    try {
      if (recovered) {
        await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'recovered', data: { step: tx.step, module: tx.binding.moduleId } });
        tx.startedAt = Date.now();
      }
      await this.drive(tx);
    } catch (e) {
      // Erreur interne : le paiement reste « en cours » (jamais « échec » sans issue connue) et visible au diagnostic.
      console.error(`[meridian] pilotage interrompu ${tx.posId}/${tx.reference}:`, (e as Error).message);
    } finally {
      if (isFinal(tx.state) || !this.alive) {
        tx.driving = isFinal(tx.state) ? tx.driving : false;
        if (cluster && this.alive) await cluster.release(tx.posId, tx.reference).catch(() => undefined);
      }
    }
  }

  private async drive(tx: Tx): Promise<void> {
    const deadline = () => tx.startedAt + this.payTimeoutMs;
    let netStreak = false;
    const netError = async (where: string) => {
      if (!netStreak) await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'network_error', data: { where, action: 'rejeu avec la même clé, état « en cours »' } });
      netStreak = true;
      await sleep(this.retryMs);
    };

    // Phase 1 : étapes du module
    while (this.alive && tx.step < this.runtime(tx).steps.length) {
      if (tx.cancelRequested && tx.step === 0) return this.finish(tx, 'cancelled', 'cancelled_before_send', {});
      const rt = this.runtime(tx);
      try {
        const saved = await rt.runStep(tx.step, this.ctx(tx), tx.vars);
        if (!this.alive) return;
        Object.assign(tx.vars, saved);
        netStreak = false;
        await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'step', data: { step: rt.steps[tx.step]!.id, vars: saved } });
        tx.step++;
      } catch (e) {
        if (!this.alive) return;
        if (e instanceof NetError) {
          const routing = await this.o.routing(tx.posId);
          if (e.refused && tx.step === 0 && !tx.usingFallback && routing?.fallback) {
            tx.binding = routing.fallback; tx.usingFallback = true; tx.vars = {};
            await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'fallback', data: { from: routing.primary.moduleId, to: routing.fallback.moduleId, reason: 'connexion refusée avant tout envoi' } });
            continue;
          }
          if (Date.now() > deadline() && tx.step === 0) return this.finish(tx, 'failed', 'psp_unreachable', {});
          await netError(rt.steps[tx.step]!.id);
          continue;
        }
        if (rt.isRetryable(tx.step, e) && Date.now() < deadline()) {
          await sleep(this.retryMs);
          continue;
        }
        const code = e instanceof RemoteError ? e.code ?? `http_${e.status}` : 'engine_error';
        return this.finish(tx, 'failed', code, {});
      }
    }

    // Phase 2 : suivi jusqu'à l'issue réelle
    while (this.alive) {
      const rt = this.runtime(tx);
      if (!tx.cancelRequested && this.o.cluster) {
        const entries = await this.o.journal.byReference(tx.posId, tx.reference);
        if (entries.some((e) => e.type === 'cancel_requested')) tx.cancelRequested = true;
      }
      if (!tx.cancelRequested && Date.now() > deadline()) {
        tx.cancelRequested = true;
        await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'cancel_requested', data: { reason: 'délai dépassé' } });
      }
      if (tx.cancelRequested && !tx.cancelSent) {
        try {
          const r = await rt.cancel(this.ctx(tx), tx.vars);
          if (!this.alive) return;
          tx.cancelSent = true;
          await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: r === 'sent' ? 'cancel_sent' : 'cancel_refused', data: r === 'sent' ? {} : { reason: 'autorisation en cours : on attend l’issue réelle' } });
        } catch (e) {
          if (!this.alive) return;
          if (!(e instanceof NetError)) {
            tx.cancelSent = true;
            await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'cancel_refused', data: { reason: (e as Error).message } });
          }
        }
      }
      try {
        const st = await rt.status(this.ctx(tx), tx.vars);
        if (!this.alive) return;
        netStreak = false;
        if (st.state !== 'pending') return this.finish(tx, st.state, st.detail, st.data);
      } catch (e) {
        if (!this.alive) return;
        if (e instanceof NetError) {
          await netError('status');
          continue;
        }
      }
      await sleep(this.pollMs);
    }
  }

  private async finish(tx: Tx, state: FinalState, detail: string | undefined, data: Record<string, unknown>): Promise<void> {
    const rt = this.runtime(tx);
    if (state !== 'authorized' && tx.step > 0) {
      try {
        await rt.cleanup(this.ctx(tx), tx.vars);
      } catch {
        /* le nettoyage n'affecte pas l'issue */
      }
    }
    if (!this.alive) return;
    if (state === 'authorized' && tx.cancelSent) detail = detail ?? 'cancel_too_late';
    tx.receipt = state === 'authorized' ? rt.receipt(data) : undefined;
    tx.final = await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'final', data: { state, detail: detail ?? null, receipt: tx.receipt ?? null } });
    tx.state = state;
    tx.detail = detail;
    if (this.activeByPos.get(tx.posId) === tx.reference) this.activeByPos.delete(tx.posId);
    tx.waiters.splice(0).forEach((w) => w());
    this.o.onFinal?.(this.view(tx));
  }

  // ---------------- Utilitaires ----------------

  private module(id: string): ModuleDef {
    const def = this.o.modules[id];
    if (!def) throw new MeridianError('module_not_found', `Module inconnu : ${id}`, 422);
    return def;
  }
  private runtime(tx: Tx): ModuleRuntime {
    return new ModuleRuntime(this.module(tx.binding.moduleId), tx.binding.config, {
      baseUrlOverride: tx.binding.baseUrl, timeoutMs: this.o.httpTimeoutMs, fetcher: this.o.fetcher,
    });
  }
  private ctx(tx: Tx) {
    return { reference: tx.reference, amount: tx.amount, currency: tx.currency };
  }
  private get(posId: string, reference: string): Tx {
    const tx = this.txs.get(key(posId, reference));
    if (!tx) throw new MeridianError('payment_not_found', 'Paiement introuvable', 404);
    return tx;
  }
  private view(tx: Tx): PaymentView {
    return {
      posId: tx.posId, reference: tx.reference, amount: tx.amount, currency: tx.currency, state: tx.state,
      detail: tx.detail, module: tx.binding.moduleId, refunded: tx.refunds.reduce((s, r) => s + r.amount, 0),
    };
  }
}
