// Stockage PostgreSQL : journal append-only, points de vente, secrets PSP chiffrés (AES-256-GCM).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Currency, JournalEntry } from '@meridian/core';
import type { JournalStore, PosRouting } from '@meridian/engine';

export class PgJournalStore implements JournalStore {
  constructor(private readonly pool: pg.Pool) {}
  async append(e: JournalEntry) {
    await this.pool.query(
      'INSERT INTO journal (seq, ts, pos_id, reference, type, data, prev, hash, sig) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [e.seq, e.ts, e.posId, e.reference, e.type, JSON.stringify(e.data), e.prev, e.hash, e.sig],
    );
  }
  /** Ajout chaîné sûr entre instances : verrou transactionnel global, garde évaluée dans la transaction, puis insertion. */
  async appendChained(build: (last: JournalEntry | undefined) => JournalEntry, guard?: import('@meridian/engine').AppendGuard): Promise<JournalEntry> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7426001)');
      const r = await client.query('SELECT * FROM journal ORDER BY seq DESC LIMIT 1');
      const e = build(r.rows[0] ? this.map(r.rows[0]) : undefined);
      if (guard) await this.checkGuard(client, e, guard);
      await client.query(
        'INSERT INTO journal (seq, ts, pos_id, reference, type, data, prev, hash, sig) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [e.seq, e.ts, e.posId, e.reference, e.type, JSON.stringify(e.data), e.prev, e.hash, e.sig],
      );
      await client.query('COMMIT');
      return e;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  /** Garde évaluée en SQL dans la transaction d'ajout : atomique entre instances (verrou 7426001 déjà pris). */
  private async checkGuard(client: pg.PoolClient, e: JournalEntry, guard: import('@meridian/engine').AppendGuard): Promise<void> {
    if ('posIdle' in guard) {
      const r = await client.query(
        `SELECT j.reference FROM journal j WHERE j.pos_id = $1 AND j.type = 'created' AND j.reference <> $2
           AND NOT EXISTS (SELECT 1 FROM journal f WHERE f.pos_id = j.pos_id AND f.reference = j.reference AND f.type = 'final')
           ORDER BY j.seq DESC LIMIT 1`,
        [e.posId, e.reference],
      );
      const active = r.rows[0]?.reference as string | undefined;
      if (active) throw Object.assign(new Error(`Un paiement est déjà en cours sur ce terminal (${active})`), { code: 'terminal_busy', active });
      return;
    }
    // Dernier état par n : refund_failed exclut le n ; refund ou refund_pending comptent une fois.
    const r = await client.query(
      `SELECT coalesce(sum((data->>'amount')::bigint), 0) AS total FROM (
         SELECT DISTINCT ON ((data->>'n')::int) type, data FROM journal
           WHERE pos_id = $1 AND reference = $2 AND type IN ('refund_pending','refund','refund_failed')
           ORDER BY (data->>'n')::int, seq DESC
       ) latest WHERE type <> 'refund_failed'`,
      [e.posId, e.reference],
    );
    const total = Number(r.rows[0]?.total ?? 0);
    if (total + Number((e.data as { amount?: number }).amount ?? 0) > guard.refundCap) {
      throw Object.assign(new Error('Le cumul des remboursements dépasse le montant payé'), { code: 'refund_exceeds_amount' });
    }
  }
  map(r: Record<string, unknown>): JournalEntry {
    return {
      seq: Number(r.seq), ts: new Date(r.ts as string).toISOString(), posId: r.pos_id as string, reference: r.reference as string,
      type: r.type as JournalEntry['type'], data: r.data as Record<string, unknown>, prev: r.prev as string, hash: r.hash as string, sig: r.sig as string,
    };
  }
  async last() {
    const r = await this.pool.query('SELECT * FROM journal ORDER BY seq DESC LIMIT 1');
    return r.rows[0] ? this.map(r.rows[0]) : undefined;
  }
  async all() {
    const r = await this.pool.query('SELECT * FROM journal ORDER BY seq');
    return r.rows.map((x) => this.map(x));
  }
  async byReference(posId: string, reference: string) {
    const r = await this.pool.query('SELECT * FROM journal WHERE pos_id=$1 AND reference=$2 ORDER BY seq', [posId, reference]);
    return r.rows.map((x) => this.map(x));
  }
}

// ---------- Coordination multi-instance ----------
/** Verrous consultatifs de session : un paiement n'est piloté que par une instance ; libérés si l'instance tombe. */
export class PgCluster {
  private client?: pg.PoolClient;
  private store: PgJournalStore;
  /** Incrémentée quand la connexion tenant les verrous est perdue : tous les verrous qu'elle tenait sont morts. */
  epoch = 0;
  constructor(private readonly pool: pg.Pool) {
    this.store = new PgJournalStore(pool);
  }
  /** Invalide le client de verrous : les pilotes en cours verront epoch changer et s'arrêteront. */
  private invalidate(c: pg.PoolClient) {
    if (this.client === c) {
      this.client = undefined;
      this.epoch++;
    }
    c.release(true);
  }
  private async lockClient() {
    if (!this.client) {
      const c = await this.pool.connect();
      c.on('error', () => this.invalidate(c));
      this.client = c;
    }
    return this.client;
  }
  /** Ne rejette pas : en cas d'erreur, le client est invalidé (epoch++) et le claim est refusé. */
  async tryClaim(posId: string, reference: string) {
    try {
      const c = await this.lockClient();
      const r = await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`${posId}|${reference}`]);
      return Boolean(r.rows[0]?.ok);
    } catch {
      if (this.client) this.invalidate(this.client);
      return false;
    }
  }
  async release(posId: string, reference: string) {
    try {
      const c = await this.lockClient();
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`${posId}|${reference}`]);
    } catch (e) {
      if (this.client) this.invalidate(this.client);
      throw e;
    }
  }
  private static UNFINISHED = `SELECT j.pos_id, j.reference FROM journal j WHERE j.type = 'created'
    AND NOT EXISTS (SELECT 1 FROM journal f WHERE f.pos_id = j.pos_id AND f.reference = j.reference AND f.type = 'final')`;
  async activeOnPos(posId: string) {
    const r = await this.pool.query(`${PgCluster.UNFINISHED} AND j.pos_id = $1 ORDER BY j.seq DESC LIMIT 1`, [posId]);
    return r.rows[0]?.reference as string | undefined;
  }
  async unfinished() {
    const r = await this.pool.query(`${PgCluster.UNFINISHED} ORDER BY j.seq`);
    return r.rows.map((x) => ({ posId: x.pos_id as string, reference: x.reference as string }));
  }
  async byPos(posId: string) {
    const r = await this.pool.query('SELECT * FROM journal WHERE pos_id = $1 ORDER BY seq', [posId]);
    return r.rows.map((x) => this.store.map(x));
  }
  /** Libère tous les verrous (arrêt propre) ; un arrêt brutal les libère aussi, côté PostgreSQL. */
  async close() {
    const c = this.client;
    this.client = undefined;
    c?.release(true);
  }
}

// ---------- Secrets ----------
export class SecretBox {
  private key: Buffer;
  private previous: Map<number, Buffer>;
  /** Version de clé écrite avec chaque secret ; les anciennes restent lisibles via `previous`. */
  readonly version: number;
  constructor(masterKey: string, opts: { version?: number; previous?: Record<number, string> } = {}) {
    if (!masterKey || masterKey.length < 32) throw new Error('MASTER_KEY trop courte (32 caractères minimum)');
    this.key = createHash('sha256').update(masterKey).digest();
    this.version = opts.version ?? 1;
    this.previous = new Map(Object.entries(opts.previous ?? {}).map(([v, k]) => {
      if (k.length < 32) throw new Error(`MASTER_KEYS_PREVIOUS : clé ${v} trop courte (32 caractères minimum)`);
      return [Number(v), createHash('sha256').update(k).digest()];
    }));
  }
  seal(obj: unknown): { data: Buffer; version: number } {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return { data: Buffer.concat([iv, c.getAuthTag(), data]), version: this.version };
  }
  open<T>(buf: Buffer, version = 1): T {
    const key = version === this.version ? this.key : this.previous.get(version);
    if (!key) throw new Error(`Version de clé inconnue : ${version}`);
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as T;
  }
}

// ---------- Points de vente ----------
export interface PosRecord {
  id: string; orgId: string; label: string; country: string; currency: Currency; locale: string; timezone: string;
  primaryModule?: string; fallbackModule?: string;
}
export type Binding = { moduleId: string; config: Record<string, unknown>; baseUrl?: string };
export interface PosRepo {
  create(p: PosRecord): Promise<PosRecord>;
  get(id: string): Promise<PosRecord | undefined>;
  list(orgId: string): Promise<PosRecord[]>;
  setRouting(id: string, primary: Binding, fallback?: Binding): Promise<void>;
  routing(id: string): Promise<PosRouting | undefined>;
}

export class PgPosRepo implements PosRepo {
  constructor(private readonly pool: pg.Pool, private readonly box: SecretBox) {}
  private map(r: Record<string, unknown>): PosRecord {
    return {
      id: r.id as string, orgId: r.org_id as string, label: r.label as string, country: (r.country as string).trim(),
      currency: (r.currency as string).trim() as Currency, locale: r.locale as string, timezone: r.timezone as string,
      primaryModule: (r.primary_module as string) ?? undefined, fallbackModule: (r.fallback_module as string) ?? undefined,
    };
  }
  async create(p: PosRecord) {
    await this.pool.query('INSERT INTO pos (id, org_id, label, country, currency, locale, timezone) VALUES ($1,$2,$3,$4,$5,$6,$7)', [p.id, p.orgId, p.label, p.country, p.currency, p.locale, p.timezone]);
    return p;
  }
  async get(id: string) {
    const r = await this.pool.query('SELECT * FROM pos WHERE id=$1', [id]);
    return r.rows[0] ? this.map(r.rows[0]) : undefined;
  }
  async list(orgId: string) {
    const r = await this.pool.query('SELECT * FROM pos WHERE org_id=$1 ORDER BY created_at', [orgId]);
    return r.rows.map((x) => this.map(x));
  }
  async setRouting(id: string, primary: Binding, fallback?: Binding) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const b of [primary, fallback].filter(Boolean) as Binding[]) {
        const sealed = this.box.seal(b.config);
        await client.query(
          `INSERT INTO pos_module_config (pos_id, module_id, config_encrypted, key_version, base_url) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (pos_id, module_id) DO UPDATE SET config_encrypted=EXCLUDED.config_encrypted, key_version=EXCLUDED.key_version, base_url=EXCLUDED.base_url, updated_at=now()`,
          [id, b.moduleId, sealed.data, sealed.version, b.baseUrl ?? null],
        );
      }
      await client.query('UPDATE pos SET primary_module=$2, fallback_module=$3 WHERE id=$1', [id, primary.moduleId, fallback?.moduleId ?? null]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async routing(id: string): Promise<PosRouting | undefined> {
    const pos = await this.get(id);
    if (!pos?.primaryModule) return undefined;
    const r = await this.pool.query('SELECT module_id, config_encrypted, key_version, base_url FROM pos_module_config WHERE pos_id=$1', [id]);
    const binding = (m?: string) => {
      const row = r.rows.find((x) => x.module_id === m);
      return row ? { moduleId: m!, config: this.box.open<Record<string, unknown>>(row.config_encrypted, row.key_version ?? 1), baseUrl: row.base_url ?? undefined } : undefined;
    };
    const primary = binding(pos.primaryModule);
    if (!primary) return undefined;
    return { posId: id, country: pos.country, currency: pos.currency, primary, fallback: binding(pos.fallbackModule) };
  }
}

/** Dépôt en mémoire : mode local et tests. Mêmes règles que Postgres, secrets inclus. */
export class MemoryPosRepo implements PosRepo {
  private items = new Map<string, PosRecord & { bindings: Map<string, { moduleId: string; config: Record<string, unknown>; baseUrl?: string }> }>();
  async create(p: PosRecord) {
    if (this.items.has(p.id)) throw new Error('pos_exists');
    this.items.set(p.id, { ...p, bindings: new Map() });
    return p;
  }
  async get(id: string) {
    const x = this.items.get(id);
    if (!x) return undefined;
    const { bindings: _b, ...rest } = x;
    return rest;
  }
  async list(orgId: string) {
    return [...this.items.values()].filter((x) => x.orgId === orgId).map(({ bindings: _b, ...rest }) => rest);
  }
  async setRouting(id: string, primary: Binding, fallback?: Binding) {
    const x = this.items.get(id);
    if (!x) throw new Error('pos_not_found');
    x.bindings.set(primary.moduleId, primary);
    if (fallback) x.bindings.set(fallback.moduleId, fallback);
    x.primaryModule = primary.moduleId;
    x.fallbackModule = fallback?.moduleId;
  }
  async routing(id: string): Promise<PosRouting | undefined> {
    const x = this.items.get(id);
    if (!x?.primaryModule) return undefined;
    const primary = x.bindings.get(x.primaryModule);
    if (!primary) return undefined;
    return { posId: id, country: x.country, currency: x.currency, primary, fallback: x.fallbackModule ? x.bindings.get(x.fallbackModule) : undefined };
  }
}

// ---------- Migrations ----------
// Verrou consultatif de session pendant toute la migration : deux instances qui démarrent ensemble
// n'appliquent pas le même fichier en double. Chaque fichier est atomique (BEGIN…COMMIT).
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7426002)');
    try {
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string));
      const applied: string[] = [];
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
        if (done.has(f)) continue;
        try {
          await client.query('BEGIN');
          await client.query(readFileSync(join(dir, f), 'utf8'));
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
        applied.push(f);
      }
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock(7426002)').catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

export { pg };
