// Journal append-only, chaîné (SHA-256) et signé (HMAC). Écrit et rendu durable AVANT tout appel au PSP.
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, existsSync, fsyncSync, openSync, closeSync, readFileSync } from 'node:fs';
import type { JournalEntry, JournalEntryInput } from '@meridian/core';

export interface JournalStore {
  append(entry: JournalEntry): Promise<void>;
  last(): Promise<JournalEntry | undefined>;
  all(): Promise<JournalEntry[]>;
  byReference(posId: string, reference: string): Promise<JournalEntry[]>;
  /** Stockage partagé (PostgreSQL) : construit et insère l'entrée sous verrou, à partir de la dernière en base. */
  appendChained?(build: (last: JournalEntry | undefined) => JournalEntry): Promise<JournalEntry>;
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

export class Journal {
  private tail: Promise<unknown> = Promise.resolve();
  private head?: { seq: number; hash: string };

  constructor(private readonly store: JournalStore, private readonly key: string) {
    if (!key || key.length < 16) throw new Error('JOURNAL_KEY trop courte (16 caractères minimum)');
  }

  sign(hash: string): string {
    return createHmac('sha256', this.key).update(hash).digest('hex');
  }

  /** Ajout sérialisé : une seule écriture à la fois pour garder la chaîne cohérente. */
  append(input: JournalEntryInput): Promise<JournalEntry> {
    const build = (last: JournalEntry | undefined): JournalEntry => {
      const base = { ...input, seq: (last?.seq ?? 0) + 1, ts: new Date().toISOString(), prev: last?.hash ?? GENESIS };
      const hash = hashEntry(base);
      return { ...base, hash, sig: this.sign(hash) };
    };
    if (this.store.appendChained) return this.store.appendChained(build);
    const run = async () => {
      if (!this.head) {
        const last = await this.store.last();
        this.head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
      }
      const base = { ...input, seq: this.head.seq + 1, ts: new Date().toISOString(), prev: this.head.hash };
      const hash = hashEntry(base);
      const entry: JournalEntry = { ...base, hash, sig: this.sign(hash) };
      await this.store.append(entry);
      this.head = { seq: entry.seq, hash };
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

  async verify(): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    const entries = await this.store.all();
    let prev = GENESIS;
    for (const e of entries) {
      const { hash, sig, ...rest } = e;
      if (e.prev !== prev || hashEntry(rest) !== hash || this.sign(hash) !== sig) return { ok: false, count: entries.length, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true, count: entries.length };
  }
}

export class MemoryStore implements JournalStore {
  entries: JournalEntry[] = [];
  async append(e: JournalEntry) {
    this.entries.push(structuredClone(e));
  }
  async last() {
    return this.entries.at(-1);
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
  async last() {
    return this.read().at(-1);
  }
  async all() {
    return this.read();
  }
  async byReference(posId: string, reference: string) {
    return this.read().filter((e) => e.posId === posId && e.reference === reference);
  }
}
