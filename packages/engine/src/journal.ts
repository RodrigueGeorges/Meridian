// Journal append-only, chaîné (SHA-256) et signé (HMAC). Écrit et rendu durable AVANT tout appel au PSP.
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, existsSync, fsyncSync, openSync, closeSync, readFileSync } from 'node:fs';
import type { JournalEntry, JournalEntryInput } from '@meridian/core';

/** Garde évaluée atomiquement avec l'ajout : le refus voyage avec l'entrée, pas en pré-vérification. */
export type AppendGuard = { posIdle: true } | { refundCap: number };

export interface JournalStore {
  append(entry: JournalEntry): Promise<void>;
  last(posId?: string): Promise<JournalEntry | undefined>;
  all(): Promise<JournalEntry[]>;
  byReference(posId: string, reference: string): Promise<JournalEntry[]>;
  /** Stockage partagé (PostgreSQL) : construit et insère l'entrée sous verrou de sa chaîne (par posId),
   *  à partir de la dernière entrée DE CE POS. Deux POS différents écrivent en parallèle. */
  appendChained?(posId: string, build: (last: JournalEntry | undefined) => JournalEntry, guard?: AppendGuard): Promise<JournalEntry>;
}

export const GENESIS = '0'.repeat(64);

/** JSON canonique (clés triées) : le hachage ne dépend pas de l'ordre des clés rendu par le stockage (jsonb). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function hashEntry(e: Omit<JournalEntry, 'hash' | 'sig'>): string {
  return createHash('sha256')
    .update(canonical([e.seq, e.ts, e.posId, e.reference, e.type, e.data, e.prev]))
    .digest('hex');
}

/**
 * Évalue un garde d'ajout sur les entrées déjà journalisées.
 * `posIdle` : refuse un `created` tant qu'un autre paiement du même terminal n'a pas d'entrée `final`.
 * `refundCap` : cumul des remboursements de (posId, reference) — chaque n compté une fois
 * (dernier état par n : refund_failed exclu, refund sinon refund_pending) — plus le montant demandé.
 */
export function checkGuard(entries: JournalEntry[], input: JournalEntryInput, guard: AppendGuard): void {
  if ('posIdle' in guard) {
    const active = [...entries].reverse().find(
      (e) => e.type === 'created' && e.posId === input.posId && e.reference !== input.reference
        && !entries.some((f) => f.type === 'final' && f.posId === e.posId && f.reference === e.reference),
    );
    if (active) {
      throw Object.assign(new Error(`Un paiement est déjà en cours sur ce terminal (${active.reference})`), { code: 'terminal_busy', active: active.reference });
    }
    return;
  }
  const byN = new Map<number, { amount: number; failed: boolean }>();
  for (const e of entries) {
    if (e.posId !== input.posId || e.reference !== input.reference) continue;
    const d = e.data as { n?: number; amount?: number };
    if (typeof d.n !== 'number') continue;
    if (e.type === 'refund_pending' || e.type === 'refund') byN.set(d.n, { amount: d.amount ?? 0, failed: false });
    else if (e.type === 'refund_failed') byN.set(d.n, { amount: 0, failed: true });
  }
  const total = [...byN.values()].filter((x) => !x.failed).reduce((s, x) => s + x.amount, 0);
  if (total + Number(input.data.amount ?? 0) > guard.refundCap) {
    throw Object.assign(new Error('Le cumul des remboursements dépasse le montant payé'), { code: 'refund_exceeds_amount' });
  }
}

export class Journal {
  private tail: Promise<unknown> = Promise.resolve();
  /** Tête de chaîne par POS : chaque terminal a sa chaîne (prev = entrée précédente du même POS). */
  private heads = new Map<string, { seq: number; hash: string }>();
  private readonly keyId: string;
  private readonly previous: Record<string, string>;

  constructor(private readonly store: JournalStore, private readonly key: string, opts: { keyId?: string; previous?: Record<string, string> } = {}) {
    if (!key || key.length < 16) throw new Error('JOURNAL_KEY trop courte (16 caractères minimum)');
    this.keyId = opts.keyId ?? '1';
    this.previous = opts.previous ?? {};
  }

  /** kid '1' (ou absent) : signature historique, hex brut ; sinon « kid:hex » pour retrouver la clé à la vérification. */
  sign(hash: string): string {
    const sig = createHmac('sha256', this.key).update(hash).digest('hex');
    return this.keyId === '1' ? sig : `${this.keyId}:${sig}`;
  }

  private keyFor(kid: string): string | undefined {
    if (kid === this.keyId) return this.key;
    return this.previous[kid];
  }

  /** Ajout sérialisé par chaîne de POS : en mémoire/fichier toutes les écritures restent en file,
   *  en PostgreSQL seuls les ajouts du même POS se serialisent (verrou advisory par posId). */
  append(input: JournalEntryInput, guard?: AppendGuard): Promise<JournalEntry> {
    const build = (last: JournalEntry | undefined): JournalEntry => {
      const base = { ...input, seq: (last?.seq ?? 0) + 1, ts: new Date().toISOString(), prev: last?.hash ?? GENESIS };
      const hash = hashEntry(base);
      return { ...base, hash, sig: this.sign(hash) };
    };
    if (this.store.appendChained) return this.store.appendChained(input.posId, build, guard);
    const run = async () => {
      if (guard) checkGuard(await this.store.all(), input, guard);
      let head = this.heads.get(input.posId);
      if (!head) {
        const last = await this.store.last(input.posId);
        head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
      }
      const base = { ...input, seq: head.seq + 1, ts: new Date().toISOString(), prev: head.hash };
      const hash = hashEntry(base);
      const entry: JournalEntry = { ...base, hash, sig: this.sign(hash) };
      await this.store.append(entry);
      this.heads.set(input.posId, { seq: entry.seq, hash });
      return entry;
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  all(): Promise<JournalEntry[]> {
    return this.store.all();
  }
  byReference(posId: string, reference: string): Promise<JournalEntry[]> {
    return this.store.byReference(posId, reference);
  }

  /** Vérifie chaque chaîne de POS : continuité prev (première entrée du POS = GENESIS),
   *  hachage canonique et signature de chaque entrée. */
  async verify(): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    const entries = await this.store.all();
    const byPos = new Map<string, JournalEntry[]>();
    for (const e of entries) (byPos.get(e.posId) ?? byPos.set(e.posId, []).get(e.posId)!).push(e);
    for (const chain of byPos.values()) {
      chain.sort((a, b) => a.seq - b.seq);
      let prev = GENESIS;
      for (const e of chain) {
        const { hash, sig, ...rest } = e;
        // « kid:hex » : signature de la clé de ce kid ; hex brut : kid '1' (format historique).
        const kid = sig.includes(':') ? sig.split(':', 1)[0]! : '1';
        const raw = sig.includes(':') ? sig.slice(kid.length + 1) : sig;
        const k = this.keyFor(kid);
        const ok = !!k && createHmac('sha256', k).update(hash).digest('hex') === raw;
        if (e.prev !== prev || hashEntry(rest) !== hash || !ok) return { ok: false, count: entries.length, brokenAt: e.seq };
        prev = hash;
      }
    }
    return { ok: true, count: entries.length };
  }
}

export class MemoryStore implements JournalStore {
  entries: JournalEntry[] = [];
  async append(e: JournalEntry) {
    this.entries.push(structuredClone(e));
  }
  async last(posId?: string) {
    return posId === undefined ? this.entries.at(-1) : [...this.entries].reverse().find((e) => e.posId === posId);
  }
  async all() {
    return this.entries.map((e) => structuredClone(e));
  }
  async byReference(posId: string, reference: string) {
    return this.entries.filter((e) => e.posId === posId && e.reference === reference);
  }
}

/** Fichier JSONL avec fsync : mode local, bornes, tests de crash. */
export class JsonlStore implements JournalStore {
  constructor(private readonly file: string) {}
  private read(): JournalEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalEntry);
  }
  async append(e: JournalEntry) {
    appendFileSync(this.file, JSON.stringify(e) + '\n');
    const fd = openSync(this.file, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  async last(posId?: string) {
    const es = this.read();
    return posId === undefined ? es.at(-1) : [...es].reverse().find((e) => e.posId === posId);
  }
  async all() {
    return this.read();
  }
  async byReference(posId: string, reference: string) {
    return this.read().filter((e) => e.posId === posId && e.reference === reference);
  }
}
