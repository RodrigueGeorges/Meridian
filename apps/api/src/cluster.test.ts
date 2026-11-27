// Multi-instance sur une même base PostgreSQL : deux API, un seul pilote par paiement, reprise si une instance tombe.
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSims } from '@meridian/sim';
import { pg } from '@meridian/store-pg';
import { buildServer } from './server.ts';

const baseUrl = process.env.DATABASE_URL;
// Schéma dédié : n'interfère pas avec les autres tests PostgreSQL lancés en parallèle.
const SCHEMA = 'cluster_test';
const dbUrl = baseUrl && `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const KEY = 'mk_test_cluster0123456789abcdef';
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

describe.skipIf(!baseUrl)('Cluster PostgreSQL : deux instances d’API', () => {
  let sims: Awaited<ReturnType<typeof startSims>>;
  const hooks: { body: string; sig: string }[] = [];
  let hookSrv: http.Server;
  const servers: Awaited<ReturnType<typeof buildServer>>[] = [];
  const urls: string[] = [];
  const opts = () => ({
    databaseUrl: dbUrl, journalKey: 'cluster-journal-key-0123456789', masterKey: 'cluster-master-key-0123456789abcdef012345',
    bootstrapKey: KEY, allowTestBaseUrl: true, demoSeed: { stripeUrl: sims.stripeUrl, secoursUrl: sims.secoursUrl },
    webhookUrl: `http://127.0.0.1:${(hookSrv.address() as { port: number }).port}/hook`, webhookSecret: 'whsec_test',
    engine: { pollMs: 40, retryMs: 60, scanMs: 300 },
  });
  const start = async () => {
    const s = await buildServer(opts());
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    servers.push(s);
    urls.push(`http://127.0.0.1:${(s.app.server.address() as { port: number }).port}`);
    return urls.length - 1;
  };
  const call = async (i: number, method: string, path: string, body?: unknown) => {
    const r = await fetch(urls[i] + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };

  beforeAll(async () => {
    const p = new pg.Pool({ connectionString: baseUrl });
    await p.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await p.end();
    hookSrv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        hooks.push({ body: b, sig: String(req.headers['meridian-signature']) });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => hookSrv.listen(0, '127.0.0.1', r));
    sims = await startSims();
    await start();
    await start();
  });
  afterAll(async () => {
    for (const s of servers) await s.app.close().catch(() => undefined);
    await sims?.close();
    hookSrv?.close();
  });

  it('paiement créé sur A, suivi et terminé vu depuis B', async () => {
    sims.stripe.faults.autoPresentMs = 800;
    const ref = `CL-1-${Date.now()}`;
    expect((await call(0, 'POST', '/v1/payments', { posId: 'pos_demo_FR', reference: ref, amount: 1500, currency: 'EUR' })).status).toBe(201);
    expect((await call(1, 'GET', `/v1/payments/${ref}?posId=pos_demo_FR`)).json.state).toBe('pending');
    const fin = await call(1, 'GET', `/v1/payments/${ref}?posId=pos_demo_FR&waitMs=8000`);
    expect(fin.json.state).toBe('authorized');
    expect((await call(1, 'GET', `/v1/payments/${ref}/receipt?posId=pos_demo_FR`)).json.last4).toBe('4242');
    sims.stripe.faults.autoPresentMs = 150;
  });

  it('même référence envoyée en même temps à A et B : un seul paiement, un seul débit', async () => {
    const before = sims.debits();
    const ref = `CL-2-${Date.now()}`;
    const body = { posId: 'pos_demo_BE', reference: ref, amount: 990, currency: 'EUR', waitMs: 6000 };
    const [a, b] = await Promise.all([call(0, 'POST', '/v1/payments', body), call(1, 'POST', '/v1/payments', body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const fin = await call(0, 'GET', `/v1/payments/${ref}?posId=pos_demo_BE&waitMs=6000`);
    expect(fin.json.state).toBe('authorized');
    expect(sims.debits() - before).toBe(1);
  });

  it('deux paiements différents en même temps sur le même terminal : un seul passe (terminal_busy atomique)', async () => {
    sims.stripe.faults.autoPresentMs = 1500;
    const ref = (s: string) => `CL-BUSY-${s}-${Date.now()}`;
    const mk = (reference: string) => ({ posId: 'pos_demo_NL', reference, amount: 300, currency: 'EUR' });
    const [a, b] = await Promise.all([call(0, 'POST', '/v1/payments', mk(ref('A'))), call(1, 'POST', '/v1/payments', mk(ref('B')))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).json.error.code).toBe('terminal_busy');
    const winner = (a.status === 201 ? a : b).json.reference as string;
    const fin = await call(1, 'GET', `/v1/payments/${winner}?posId=pos_demo_NL&waitMs=8000`);
    expect(fin.json.state).toBe('authorized');
    sims.stripe.faults.autoPresentMs = 150;
  });

  it('annulation demandée sur B, appliquée par A qui pilote', async () => {
    sims.stripe.faults.autoPresentMs = null;
    const ref = `CL-3-${Date.now()}`;
    await call(0, 'POST', '/v1/payments', { posId: 'pos_demo_ES', reference: ref, amount: 500, currency: 'EUR' });
    await new Promise((r) => setTimeout(r, 300));
    await call(1, 'POST', `/v1/payments/${ref}/cancel`, { posId: 'pos_demo_ES' });
    const fin = await call(1, 'GET', `/v1/payments/${ref}?posId=pos_demo_ES&waitMs=6000`);
    expect(fin.json.state).toBe('cancelled');
    sims.stripe.faults.autoPresentMs = 150;
  });

  it('A tombe en plein paiement : B reprend (verrou libéré), un seul débit', async () => {
    sims.stripe.faults.autoPresentMs = 1500;
    const before = sims.debits();
    const ref = `CL-4-${Date.now()}`;
    await call(0, 'POST', '/v1/payments', { posId: 'pos_demo_IT', reference: ref, amount: 2450, currency: 'EUR' });
    await new Promise((r) => setTimeout(r, 300));
    await servers[0]!.app.close(); // instance A arrêtée : son verrou de session disparaît
    const fin = await call(1, 'GET', `/v1/payments/${ref}?posId=pos_demo_IT&waitMs=10000`);
    expect(fin.json.state).toBe('authorized');
    expect(sims.debits() - before).toBe(1);
    sims.stripe.faults.autoPresentMs = 150;
  });

  it('journal intact malgré les écritures concurrentes ; webhooks signés délivrés depuis la file en base', async () => {
    expect((await call(1, 'GET', '/v1/journal/verify')).json.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    const finals = hooks.map((h) => JSON.parse(h.body) as { type: string; data: { reference: string } });
    expect(finals.some((e) => e.type === 'payment.authorized')).toBe(true);
    const h = hooks[0]!;
    const [t, v1] = h.sig.replace('t=', '').split(',v1=');
    expect(createHmac('sha256', 'whsec_test').update(`${t}.${h.body}`).digest('hex')).toBe(v1);
  });
});
