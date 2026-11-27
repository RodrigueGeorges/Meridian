// SecretBox : rotation de clés sans base. Gardes et migrations PostgreSQL si DATABASE_URL est défini.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Journal } from '@meridian/engine';
import { migrate, pg, PgJournalStore, SecretBox } from './index.ts';

describe('SecretBox', () => {
  it('rotation : les secrets chiffrés en v1 restent lisibles par une box v2 + previous', () => {
    const k1 = 'master-une-0123456789abcdef01234567';
    const k2 = 'master-deux-0123456789abcdef0123456';
    const v1 = new SecretBox(k1);
    const sealed = v1.seal({ apiKey: 'secret' });
    expect(sealed.version).toBe(1);
    const v2 = new SecretBox(k2, { version: 2, previous: { 1: k1 } });
    expect(v2.open(sealed.data, sealed.version)).toEqual({ apiKey: 'secret' });
    const nouveau = v2.seal({ apiKey: 'x' });
    expect(nouveau.version).toBe(2);
    expect(v2.open(nouveau.data, nouveau.version)).toEqual({ apiKey: 'x' });
    expect(() => v2.open(sealed.data, 9)).toThrow(/Version de clé inconnue/);
    expect(() => new SecretBox(k2, { version: 2 }).open(sealed.data, 1)).toThrow();
  });
});

const baseUrl = process.env.DATABASE_URL;
const SCHEMA = 'store_test';
const dbUrl = baseUrl && `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

describe.skipIf(!baseUrl)('PostgreSQL : gardes d\'ajout atomiques et migrations', () => {
  let pool: pg.Pool;
  let journal: Journal;
  const KEY = 'pg-gardes-key-0123456789abcd';
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: baseUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await admin.end();
    pool = new pg.Pool({ connectionString: dbUrl });
    await migrate(pool);
    journal = new Journal(new PgJournalStore(pool), KEY);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('migrate est idempotent et rejouable', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('posIdle : un seul paiement sans issue par terminal, atomique entre appels', async () => {
    const posId = `pos_guard_${Date.now()}`;
    await journal.append({ posId, reference: 'a', type: 'created', data: { amount: 100 } }, { posIdle: true });
    await expect(journal.append({ posId, reference: 'b', type: 'created', data: { amount: 100 } }, { posIdle: true }))
      .rejects.toMatchObject({ code: 'terminal_busy', active: 'a' });
    await journal.append({ posId, reference: 'a', type: 'final', data: { state: 'authorized' } });
    await journal.append({ posId, reference: 'b', type: 'created', data: { amount: 100 } }, { posIdle: true });
  });

  it('refundCap : deux remboursements concurrents dont la somme dépasse → un seul journalisé', async () => {
    const posId = `pos_cap_${Date.now()}`;
    await journal.append({ posId, reference: 'a', type: 'created', data: { amount: 1000 } });
    const pending = (n: number, amount: number) =>
      journal.append({ posId, reference: 'a', type: 'refund_pending', data: { n, amount } }, { refundCap: 1000 });
    const res = await Promise.allSettled([pending(1, 600), pending(2, 600)]);
    expect(res.filter((x) => x.status === 'fulfilled').length).toBe(1);
    const ko = res.find((x) => x.status === 'rejected');
    expect(ko && (ko as PromiseRejectedResult).reason).toMatchObject({ code: 'refund_exceeds_amount' });
    // Un n tombé en refund_failed ne consomme plus de capacité : n=3 passe à 400, pas au-delà.
    await journal.append({ posId, reference: 'a', type: 'refund_failed', data: { n: 1 } });
    await pending(3, 400);
    await expect(pending(4, 601)).rejects.toMatchObject({ code: 'refund_exceeds_amount' });
  });
});
