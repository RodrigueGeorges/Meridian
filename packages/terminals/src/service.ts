// Service terminal de l'agent Meridian : expose un TPE du réseau local par une petite API HTTP idempotente.
// Une même interface sert l'API locale (caisse installée) et le relais cloud (caisse SaaS) :
//   POST /terminal/payments            {reference, amount, currency}   en-tête Idempotency-Key
//   GET  /terminal/payments/:reference
//   POST /terminal/payments/:reference/cancel
//   POST /terminal/payments/:reference/refunds   {amount, number}      en-tête Idempotency-Key
//   GET  /terminal/health
// Chaque opération est écrite sur disque avant d'être envoyée au terminal : un redémarrage de l'agent ne crée
// jamais un second paiement, et une issue inconnue reste « en cours » jusqu'à vérification.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LinkError, type TerminalDriver, type TerminalState } from './types.ts';

export interface TerminalRecord {
  reference: string;
  amount: number;
  currency: string;
  state: TerminalState | 'pending';
  detail?: string;
  brand?: string;
  last4?: string;
  terminalRef?: string;
  createdAt: string;
  refunds: { number: number; amount: number; state: 'done' | 'refused' | 'pending' }[];
}

export interface Reply { status: number; body: unknown }

export class TerminalService {
  private records = new Map<string, TerminalRecord>();
  private busy?: string;
  /** Nombre d'ordres de paiement réellement envoyés au terminal (diagnostic et tests). */
  sent = 0;

  constructor(private readonly driver: TerminalDriver, private readonly file?: string) {
    if (file) {
      try {
        for (const r of JSON.parse(readFileSync(file, 'utf8')) as TerminalRecord[]) {
          // Un paiement interrompu par un arrêt de l'agent a pu être débité : issue inconnue, à vérifier au terminal.
          if (r.state === 'pending') { r.state = 'unknown'; r.detail = 'agent_restarted'; }
          this.records.set(r.reference, r);
        }
      } catch { /* premier démarrage */ }
    }
  }

  get protocol() { return this.driver.protocol; }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()].slice(-5000)));
    renameSync(tmp, this.file);
  }

  private view(r: TerminalRecord) {
    // « unknown » n'est pas une issue : vu de l'extérieur, le paiement reste en cours (jamais « échec » sans preuve).
    const { refunds, ...rest } = r;
    return { ...rest, state: r.state === 'unknown' ? 'pending' : r.state, refunded: refunds.filter((x) => x.state === 'done').reduce((s, x) => s + x.amount, 0) };
  }

  list() { return [...this.records.values()].map((r) => this.view(r)); }

  async handle(method: string, path: string, body: unknown): Promise<Reply> {
    const err = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } });
    const parts = path.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'terminal') return err(404, 'not_found', 'Ressource inconnue');
    if (method === 'GET' && parts[1] === 'health') return { status: 200, body: { ok: await this.driver.health(), protocol: this.driver.protocol, busy: this.busy ?? null } };
    if (parts[1] !== 'payments') return err(404, 'not_found', 'Ressource inconnue');
    const b = (body ?? {}) as Record<string, unknown>;

    if (method === 'POST' && parts.length === 2) {
      const reference = String(b.reference ?? '');
      const amount = Number(b.amount), currency = String(b.currency ?? '');
      if (!reference || !Number.isInteger(amount) || amount <= 0 || currency.length !== 3) return err(400, 'invalid_request', 'reference, amount (entier > 0) et currency obligatoires');
      const existing = this.records.get(reference);
      if (existing) {
        if (existing.amount !== amount || existing.currency !== currency) return err(409, 'reference_conflict', 'Référence déjà utilisée avec un autre montant');
        return { status: 200, body: this.view(existing) };
      }
      if (this.busy) return err(409, 'terminal_busy', `Un paiement est en cours sur ce terminal (${this.busy})`);
      const r: TerminalRecord = { reference, amount, currency, state: 'pending', createdAt: new Date().toISOString(), refunds: [] };
      this.records.set(reference, r);
      this.save(); // écrit avant l'envoi au terminal
      this.busy = reference;
      this.sent++;
      void this.driver.pay({ reference, amount, currency }).then((res) => {
        Object.assign(r, { state: res.state, detail: res.detail, brand: res.brand, last4: res.last4, terminalRef: res.terminalRef });
      }, (e: unknown) => {
        // Rien n'a pu partir vers le terminal : refus certain, sans débit possible.
        if (e instanceof LinkError && e.beforeSend) Object.assign(r, { state: 'declined', detail: 'terminal_unreachable' });
        else Object.assign(r, { state: 'unknown', detail: 'terminal_link_lost' });
      }).finally(() => { if (this.busy === reference) this.busy = undefined; this.save(); });
      return { status: 201, body: this.view(r) };
    }

    const r = this.records.get(parts[2] ?? '');
    if (!r) return err(404, 'payment_not_found', 'Paiement inconnu de ce terminal');
    if (method === 'GET' && parts.length === 3) return { status: 200, body: this.view(r) };

    if (method === 'POST' && parts[3] === 'cancel') {
      if (r.state !== 'pending') return { status: 200, body: this.view(r) };
      const res = await this.driver.cancel(r.reference);
      if (res === 'unsupported') return err(409, 'cancel_unsupported', 'Ce terminal ne permet pas d\'annuler depuis la caisse pendant l\'autorisation : annulez au terminal');
      return { status: 202, body: this.view(r) };
    }

    if (method === 'POST' && parts[3] === 'refunds') {
      const amount = Number(b.amount), number = Number(b.number ?? 1);
      if (r.state !== 'authorized') return err(409, 'not_refundable', 'Seul un paiement autorisé se rembourse');
      const prior = r.refunds.find((x) => x.number === number);
      if (prior) return prior.amount === amount ? { status: 200, body: this.view(r) } : err(409, 'refund_conflict', 'Remboursement déjà demandé avec un autre montant');
      const refunded = r.refunds.filter((x) => x.state !== 'refused').reduce((s, x) => s + x.amount, 0);
      if (!Number.isInteger(amount) || amount <= 0 || refunded + amount > r.amount) return err(400, 'invalid_amount', 'Montant de remboursement invalide');
      const entry = { number, amount, state: 'pending' as const as 'done' | 'refused' | 'pending' };
      r.refunds.push(entry);
      this.save();
      try {
        entry.state = await this.driver.refund({ reference: r.reference, amount, currency: r.currency, terminalRef: r.terminalRef, originalAmount: r.amount });
      } catch (e) {
        if (e instanceof LinkError && e.beforeSend) { r.refunds.splice(r.refunds.indexOf(entry), 1); this.save(); return err(503, 'terminal_unreachable', 'Terminal injoignable : rien n\'a été envoyé'); }
        this.save();
        return err(503, 'refund_unknown', 'Issue inconnue : vérifiez au terminal avant toute nouvelle demande');
      }
      this.save();
      return entry.state === 'done' ? { status: 200, body: this.view(r) } : err(402, 'refund_refused', 'Remboursement refusé par le terminal');
    }
    return err(405, 'method_not_allowed', 'Méthode non prise en charge');
  }
}
