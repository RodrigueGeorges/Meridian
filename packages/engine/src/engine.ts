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

/** Retrouve la configuration d'un module branché sur ce point de vente (principal ou secours). */
function bindingOf(r: PosRouting | undefined, moduleId: string): ModuleBinding | undefined {
  if (!r) return undefined;
  if (r.primary.moduleId === moduleId) return r.primary;
  if (r.fallback?.moduleId === moduleId) return r.fallback;
  return undefined;
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
  createdAt: string;
  /** Données pour encaisser sur l'appareil (Tap to Pay) : secret client du paiement. */
  device?: Record<string, unknown>;
}

interface Tx {
  posId: string;
  reference: string;
  amount: number;
  currency: Currency;
  binding: ModuleBinding;
  /** PSP de secours du point de vente au moment du paiement. */
  fallback?: ModuleBinding;
  usingFallback: boolean;
  fellBackFrom?: string;
  /** Étape peut-être reçue par le PSP sans confirmation : à vérifier avant tout renvoi si le module n'est pas idempotent. */
  inDoubt: boolean;
  vars: Record<string, unknown>;
  step: number;
  state: PaymentState;
  detail?: string;
  cancelRequested: boolean;
  cancelSent: boolean;
  refunds: { n: number; amount: number }[];
  /** Remboursements pré-journalisés, envoyés au PSP sans confirmation ni échec définitif. */
  pendingRefunds: { n: number; amount: number }[];
  /** Sérialise les remboursements de ce paiement dans l'instance. */
  refundTail?: Promise<unknown>;
  receipt?: Record<string, unknown>;
  final?: JournalEntry;
  startedAt: number;
  done?: Promise<void>;
  waiters: (() => void)[];
  /** Vrai si cette instance pilote le paiement. */
  driving: boolean;
  /** Génération du client de verrous au moment du claim : si elle change, le verrou est perdu. */
  claimEpoch?: number;
  /** Signalé « bloqué » (une seule fois) : paiement sans issue au-delà de stuckAfterMs. */
  stuck?: boolean;
}

/** Coordination multi-instance (PostgreSQL) : un seul pilote par paiement, état partagé via le journal. */
export interface Cluster {
  /** Génération du client de verrous : incrémentée quand la connexion tenant les verrous est perdue. */
  epoch: number;
  tryClaim(posId: string, reference: string): Promise<boolean>;
  release(posId: string, reference: string): Promise<void>;
  activeOnPos(posId: string): Promise<string | undefined>;
  unfinished(): Promise<{ posId: string; reference: string }[]>;
  byPos(posId: string): Promise<JournalEntry[]>;
}

export interface EngineEvents {
  /** `meta` : durée depuis la création et module principal abandonné après bascule, pour la page de statut. */
  onFinal?: (view: PaymentView, meta: { durationMs: number; fellBackFrom?: string }) => void;
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
  /** Paiement piloté sans issue au-delà de ce délai : journalisé « payment_stuck » une fois. */
  stuckAfterMs?: number;
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
  private readonly stuckAfterMs: number;

  constructor(private readonly o: EngineOptions) {
    this.pollMs = o.pollMs ?? 500;
    this.retryMs = o.retryMs ?? 800;
    this.payTimeoutMs = o.payTimeoutMs ?? 90_000;
    this.stuckAfterMs = o.stuckAfterMs ?? 600_000;
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
      posId, reference, amount, currency: currency as Currency, binding: routing.primary, fallback: routing.fallback, usingFallback: false,
      vars: {}, step: 0, state: 'created', inDoubt: false, cancelRequested: false, cancelSent: false, refunds: [], pendingRefunds: [], startedAt: Date.now(), waiters: [], driving: true,
    };
    this.txs.set(key(posId, reference), tx);
    this.activeByPos.set(posId, reference);
    try {
      // Garde atomique : un seul paiement sans issue par terminal, même en cas de course entre instances.
      await this.o.journal.append({ posId, reference, type: 'created', data: { amount, currency, module: tx.binding.moduleId, country: routing.country } }, { posIdle: true });
    } catch (e) {
      this.txs.delete(key(posId, reference));
      this.activeByPos.delete(posId);
      const code = (e as { code?: string }).code;
      // Course entre instances : une autre a créé ce paiement juste avant (index unique en base).
      if (code === '23505') return same(await this.fresh(posId, reference));
      if (code === 'terminal_busy') throw new MeridianError('terminal_busy', (e as Error).message, 409);
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
    // Remboursement pré-journalisé : une demande en vol est rejouée avec le même n, jamais doublée.
    const run = async (): Promise<PaymentView> => {
      const n = refundNumber ?? tx.refunds.length + tx.pendingRefunds.length + 1;
      const confirmed = tx.refunds.find((r) => r.n === n);
      if (confirmed) {
        if (confirmed.amount !== amount) throw new MeridianError('refund_conflict', `Le remboursement n°${n} existe avec un autre montant`, 409);
        return this.view(tx);
      }
      const pending = tx.pendingRefunds.find((r) => r.n === n);
      if (pending && pending.amount !== amount) throw new MeridianError('refund_conflict', `Le remboursement n°${n} existe avec un autre montant`, 409);
      if (!pending) {
        try {
          await this.o.journal.append({ posId, reference, type: 'refund_pending', data: { n, amount } }, { refundCap: tx.amount });
        } catch (e) {
          if ((e as { code?: string }).code === 'refund_exceeds_amount') {
            throw new MeridianError('refund_exceeds_amount', 'Le cumul des remboursements dépasse le montant payé', 400);
          }
          throw e;
        }
        tx.pendingRefunds.push({ n, amount });
      }
      const rt = this.runtime(tx);
      try {
        await rt.refund(this.ctx(tx), tx.vars, amount, n, tx.receipt);
      } catch (e) {
        if (e instanceof NetError && !rt.canReplaySafely) throw new MeridianError('refund_unknown', 'Issue inconnue et PSP sans idempotence : vérifiez le remboursement chez le PSP avant toute nouvelle demande', 503);
        if (e instanceof NetError) throw new MeridianError('refund_pending', 'Issue inconnue : renvoyez la même demande avec le même refundNumber', 503);
        await this.o.journal.append({ posId, reference, type: 'refund_failed', data: { n, reason: (e as Error).message } });
        tx.pendingRefunds = tx.pendingRefunds.filter((r) => r.n !== n);
        throw new MeridianError('refund_failed', (e as Error).message, 502);
      }
      tx.pendingRefunds = tx.pendingRefunds.filter((r) => r.n !== n);
      tx.refunds.push({ n, amount });
      await this.o.journal.append({ posId, reference, type: 'refund', data: { n, amount } });
      this.o.onRefund?.(this.view(tx), amount);
      return this.view(tx);
    };
    const p = (tx.refundTail ?? Promise.resolve()).then(run, run);
    tx.refundTail = p.catch(() => undefined);
    return p;
  }

  /**
   * Rapprochement : redemande au PSP l'état d'un paiement terminé et le compare au journal.
   * `not_sent` : le paiement n'a jamais atteint le PSP (rien à rapprocher).
   */
  async reconcile(posId: string, reference: string): Promise<{ view: PaymentView; psp: FinalState | 'pending' | 'not_sent' | 'unreachable'; match: boolean }> {
    const tx = await this.fresh(posId, reference);
    const view = this.view(tx);
    if (!isFinal(tx.state)) return { view, psp: 'pending', match: true };
    if (tx.step === 0 && Object.keys(tx.vars).length === 0) return { view, psp: 'not_sent', match: true };
    try {
      const r = await this.runtime(tx).status(this.ctx(tx), tx.vars);
      // Rapprochement sur l'argent : débité chez le PSP si et seulement si « autorisé » dans le journal.
      // Refusé, annulé ou échoué sont équivalents (aucun débit) ; leur libellé peut différer d'un PSP à l'autre.
      const match = (r.state === 'authorized') === (tx.state === 'authorized');
      return { view, psp: r.state, match };
    } catch {
      return { view, psp: 'unreachable', match: false };
    }
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
      binding: bindingOf(routing, d.module) ?? { moduleId: d.module, config: {} },
      fallback: routing?.fallback?.moduleId === d.module ? undefined : routing?.fallback,
      usingFallback: false, inDoubt: true, vars: {}, step: 0, state: 'pending', cancelRequested: false, cancelSent: false,
      refunds: [], pendingRefunds: [], startedAt: Date.parse(created.ts), waiters: [], driving: false,
    };
    for (const e of list) {
      if (e.type === 'step') {
        tx.step++;
        Object.assign(tx.vars, (e.data as { vars?: Record<string, unknown> }).vars ?? {});
      } else if (e.type === 'fallback' && tx.fallback) {
        tx.fellBackFrom = (e.data as { from?: string }).from;
        tx.binding = tx.fallback; tx.usingFallback = true; tx.vars = {}; tx.step = 0;
      } else if (e.type === 'cancel_requested') tx.cancelRequested = true;
      else if (e.type === 'cancel_sent' || e.type === 'cancel_refused') tx.cancelSent = true;
      else if (e.type === 'refund') {
        const r = e.data as { n: number; amount: number };
        tx.pendingRefunds = tx.pendingRefunds.filter((x) => x.n !== r.n);
        if (!tx.refunds.some((x) => x.n === r.n)) tx.refunds.push(r);
      } else if (e.type === 'refund_pending') {
        const r = e.data as { n: number; amount: number };
        if (!tx.pendingRefunds.some((x) => x.n === r.n) && !tx.refunds.some((x) => x.n === r.n)) tx.pendingRefunds.push(r);
      } else if (e.type === 'refund_failed') {
        tx.pendingRefunds = tx.pendingRefunds.filter((x) => x.n !== (e.data as { n: number }).n);
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
  /** Paiements non terminés connus de cette instance, dont ceux signalés « bloqués ». */
  stats(): { pending: number; stuck: number } {
    const open = [...this.txs.values()].filter((t) => !isFinal(t.state));
    return { pending: open.length, stuck: open.filter((t) => t.stuck).length };
  }
  verify() {
    return this.o.journal.verify();
  }

  // ---------------- Pilotage ----------------

  private async safeDrive(tx: Tx, recovered: boolean): Promise<void> {
    const cluster = this.o.cluster;
    try {
      if (cluster) {
        // Le claim peut échouer sur une erreur de connexion : on ne pilote pas, le scanner réessaiera.
        const claimed = await cluster.tryClaim(tx.posId, tx.reference).catch((e) => {
          console.error(JSON.stringify({ level: 'error', event: 'claim_failed', posId: tx.posId, reference: tx.reference, error: (e as Error).message }));
          return false;
        });
        if (!claimed) {
          tx.driving = false; // une autre instance pilote déjà ce paiement (ou le claim a échoué)
          return;
        }
        tx.claimEpoch = cluster.epoch;
      }
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', event: 'claim_failed', posId: tx.posId, reference: tx.reference, error: (e as Error).message }));
      tx.driving = false;
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

  /** Le client tenant les verrous consultatifs a été remplacé : nos verrous sont morts, on ne pilote plus. */
  private lockLost(tx: Tx): boolean {
    const lost = !!this.o.cluster && tx.claimEpoch !== undefined && tx.claimEpoch !== this.o.cluster.epoch;
    if (lost) {
      console.error(JSON.stringify({ level: 'error', event: 'lock_lost', posId: tx.posId, reference: tx.reference, step: tx.step }));
      tx.driving = false;
    }
    return lost;
  }

  private checkStuck(tx: Tx): void {
    if (tx.stuck || isFinal(tx.state) || Date.now() - tx.startedAt <= this.stuckAfterMs) return;
    console.error(JSON.stringify({ level: 'error', event: 'payment_stuck', posId: tx.posId, reference: tx.reference, step: tx.step, inDoubt: tx.inDoubt, ageMs: Date.now() - tx.startedAt }));
    tx.stuck = true;
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
      if (this.lockLost(tx)) return; // verrous perdus : on s'arrête sans finaliser, le scanner reprendra
      this.checkStuck(tx);
      if (tx.cancelRequested && tx.step === 0) return this.finish(tx, 'cancelled', 'cancelled_before_send', {});
      const rt = this.runtime(tx);
      // PSP sans clé d'idempotence : une étape peut-être reçue n'est renvoyée qu'après avoir vérifié qu'elle ne l'a pas été.
      if (tx.inDoubt && !rt.canReplaySafely && rt.def.lookup) {
        let found: Record<string, unknown> | null;
        try {
          found = await rt.lookup(this.ctx(tx));
        } catch (e) {
          if (!this.alive) return;
          if (e instanceof NetError || (e instanceof RemoteError && e.status >= 500)) { await netError('lookup'); continue; }
          throw e;
        }
        if (!this.alive) return;
        if (found) {
          const saved = Object.fromEntries(Object.entries(found).filter(([k]) => !k.startsWith('_')));
          Object.assign(tx.vars, saved);
          tx.inDoubt = false; netStreak = false;
          await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'step', data: { step: rt.steps[tx.step]!.id, vars: saved, via: 'lookup' } });
          tx.step++;
          continue;
        }
        tx.inDoubt = false;
      }
      try {
        if (!rt.canReplaySafely) tx.inDoubt = true;
        const saved = await rt.runStep(tx.step, this.ctx(tx), tx.vars);
        if (!this.alive) return;
        tx.inDoubt = false;
        Object.assign(tx.vars, saved);
        netStreak = false;
        await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'step', data: { step: rt.steps[tx.step]!.id, vars: saved } });
        tx.step++;
      } catch (e) {
        if (!this.alive) return;
        // Connexion refusée ou erreur renvoyée par le PSP : on sait si l'étape a été reçue.
        if ((e instanceof NetError && e.refused) || e instanceof RemoteError) tx.inDoubt = false;
        if (e instanceof NetError) {
          if (e.refused && tx.step === 0 && !tx.usingFallback && tx.fallback) {
            const from = tx.binding.moduleId;
            tx.binding = tx.fallback; tx.usingFallback = true; tx.vars = {}; tx.fellBackFrom = from;
            await this.o.journal.append({ posId: tx.posId, reference: tx.reference, type: 'fallback', data: { from, to: tx.fallback.moduleId, reason: 'connexion refusée avant tout envoi' } });
            continue;
          }
          // Jamais « échec » si le PSP a peut-être reçu la demande : on continue de vérifier.
          if (Date.now() > deadline() && tx.step === 0 && !tx.inDoubt) return this.finish(tx, 'failed', 'psp_unreachable', {});
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
      if (this.lockLost(tx)) return;
      this.checkStuck(tx);
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
    this.o.onFinal?.(this.view(tx), { durationMs: Date.now() - tx.startedAt, fellBackFrom: tx.fellBackFrom });
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
      createdAt: new Date(tx.startedAt).toISOString(),
      ...(isFinal(tx.state) ? {} : this.deviceOf(tx)),
    };
  }

  private deviceOf(tx: Tx): { device?: Record<string, unknown> } {
    const def = this.o.modules[tx.binding.moduleId];
    if (!def?.exposeVars?.length) return {};
    const device = Object.fromEntries(def.exposeVars.filter((k) => tx.vars[k] !== undefined).map((k) => [k, tx.vars[k]]));
    return Object.keys(device).length ? { device } : {};
  }
}
