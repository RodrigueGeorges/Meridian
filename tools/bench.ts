// Benchmark de charge local : paiements concurrents sur un serveur branché à PostgreSQL.
// Usage : DATABASE_URL=postgres://meridian:meridian@localhost:55432/meridian pnpm bench [total] [pos] [conc] [orgs]
//   total=200 pos=20 conc=50 orgs=1 par défaut. pos=1 reproduit la sérialisation d'un seul terminal ;
//   orgs>1 répartit les POS sur plusieurs organisations (limite par org : 300 req/min chacune).
import { createHash } from 'node:crypto';
import { startSims } from '@meridian/sim';
import { pg } from '@meridian/store-pg';
import { buildServer } from '../apps/api/src/server.ts';

const TOTAL = Number(process.argv[2] ?? 200);
const POSN = Number(process.argv[3] ?? 20);
const ORGS = Math.max(1, Math.min(Number(process.argv[5] ?? 1), POSN));
// Un paiement par terminal à la fois (terminal_busy sinon) : la concurrence utile est ≤ au nombre de POS.
const CONC = Math.min(Number(process.argv[4] ?? 50), POSN);
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) { console.error('DATABASE_URL requis (PostgreSQL local).'); process.exit(1); }

const SCHEMA = `bench_${Date.now()}`;
const dbUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const admin = new pg.Client({ connectionString: baseUrl });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
await admin.end();

const sims = await startSims();
sims.stripe.faults.autoPresentMs = 20; // latence PSP simulée minimale : on mesure le pipeline, pas la carte
const KEY = 'mk_test_bench0123456789abcdef';
const sha = (x: string) => createHash('sha256').update(x).digest('hex');
const { app } = await buildServer({
  databaseUrl: dbUrl,
  journalKey: 'bench-journal-key-0123456789',
  masterKey: 'bench-master-key-0123456789abcdef012345',
  bootstrapKey: KEY,
  allowTestBaseUrl: true,
  demoSeed: { stripeUrl: sims.stripeUrl, secoursUrl: sims.secoursUrl },
  engine: { pollMs: 40, retryMs: 80, scanMs: 400 },
  dbPoolMax: Number(process.env.DATABASE_POOL_MAX ?? 20),
  trustProxy: true,
});
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
try {
  // Organisations + clés dédiées (insertion directe : pas d'endpoint de gestion des orgs).
  const orgKeys: string[] = [];
  {
    const c = new pg.Client({ connectionString: dbUrl });
    await c.connect();
    for (let o = 0; o < ORGS; o++) {
      const orgId = `bench_org_${o}`;
      const key = `mk_test_bench${o}${sha(`org${o}`).slice(0, 24)}`;
      await c.query('INSERT INTO organizations (id, name, kind) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [orgId, `Bench ${o}`, 'editor']);
      await c.query('INSERT INTO api_keys (id, org_id, prefix, hash, mode) VALUES ($1,$2,$3,$4,$5)', [`key_bench_${o}`, orgId, key.slice(0, 12), sha(key), 'test']);
      orgKeys.push(key);
    }
    await c.end();
  }

  // POS distincts répartis sur les orgs, liés au PSP simulé : le journal étant shardé par POS,
  // ils progressent en parallèle. Un reader Stripe dédié par POS (une action à la fois, comme en réel).
  const posByOrg: string[][] = Array.from({ length: ORGS }, () => []);
  for (let i = 0; i < POSN; i++) {
    const o = i % ORGS;
    const h = { authorization: `Bearer ${orgKeys[o]}`, 'content-type': 'application/json', 'x-forwarded-for': `10.8.${Math.floor(i / 250)}.${i % 250 + 1}` };
    const pos = (await fetch(`${base}/v1/pos`, { method: 'POST', headers: h, body: JSON.stringify({ label: `bench_${i}`, country: 'FR' }) }).then((r) => r.json())) as { id: string };
    const reader = (await fetch(`${sims.stripeUrl}/v1/terminal/readers`, { method: 'POST', headers: { authorization: 'Bearer sk_test_sim', 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())) as { id: string };
    const bind = await fetch(`${base}/v1/pos/${pos.id}/psp`, { method: 'PUT', headers: h, body: JSON.stringify({ primary: { moduleId: 'stripe-terminal', config: { secretKey: 'sk_test_sim', readerId: reader.id }, baseUrl: sims.stripeUrl } }) });
    if (bind.status !== 200) throw new Error(`binding ${pos.id} : ${bind.status} ${await bind.text()}`);
    posByOrg[o]!.push(pos.id);
  }

  const before = sims.debits();
  const t0 = performance.now();
  let done = 0, failed = 0;
  const states = new Map<string, number>();
  const count = (s?: string) => states.set(s ?? '?', (states.get(s ?? '?') ?? 0) + 1);
  const pendingRefs: { posId: string; ref: string; key: string }[] = [];
  const worker = async (w: number) => {
    for (let i = w; i < TOTAL; i += CONC) {
      const o = i % ORGS;
      const posId = posByOrg[o]![Math.floor(i / ORGS) % posByOrg[o]!.length]!;
      const ref = `BENCH-${i}`;
      const r = await fetch(`${base}/v1/payments`, {
        // XFF distinct par worker : la limite par IP (120/min) sépare chaque « marchand » comme en réel.
        method: 'POST', headers: { authorization: `Bearer ${orgKeys[o]}`, 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(w / 250)}.${w % 250 + 1}` },
        body: JSON.stringify({ posId, reference: ref, amount: 1000 + (i % 90) * 10, currency: 'EUR', waitMs: 60_000 }),
      }).then((x) => x.json() as Promise<{ state?: string; error?: { code: string } }>).catch(() => ({ error: { code: 'fetch' } }));
      if (r.state === 'pending') pendingRefs.push({ posId, ref, key: orgKeys[o]! });
      else if (r.state) { count(r.state); done++; }
      else { failed++; if (failed < 5) console.error('échec', i, JSON.stringify(r)); }
    }
  };
  await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));

  // Les paiements restés « pending » au-delà de waitMs : sondage jusqu'à l'issue finale.
  const deadline = Date.now() + 120_000;
  while (pendingRefs.length && Date.now() < deadline) {
    const x = pendingRefs.shift()!;
    const r = (await fetch(`${base}/v1/payments/${x.ref}?posId=${x.posId}&waitMs=1000`, { headers: { authorization: `Bearer ${x.key}` } }).then((y) => y.json()).catch(() => ({}))) as { state?: string };
    if (r.state === 'pending') pendingRefs.push(x); else { count(r.state); done++; }
  }

  const sec = (performance.now() - t0) / 1000;
  const debits = sims.debits() - before;
  console.log(JSON.stringify({
    paiements: TOTAL, pos: POSN, organisations: ORGS, concurrence: CONC,
    terminés: done, échoués: failed, restésEnCours: pendingRefs.length, débitsPsp: debits,
    états: Object.fromEntries(states),
    secondes: Math.round(sec * 10) / 10,
    'paiements/s': Math.round(done / sec * 10) / 10,
  }, null, 1));
} finally {
  await app.close().catch(() => undefined);
  await sims.close();
  const c = new pg.Client({ connectionString: baseUrl });
  await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await c.end();
}
