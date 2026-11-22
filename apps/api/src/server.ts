// API publique Meridian : 5 appels de paiement, points de vente, catalogue. Le moteur tourne dans le même process
// (worker intégré) et reprend les paiements inachevés au démarrage.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCompress from '@fastify/compress';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { COUNTRIES, isCurrency, MeridianError, type Currency } from '@meridian/core';
import { Engine, Journal, JsonlStore, MemoryStore, type JournalStore, type PaymentView } from '@meridian/engine';
import { BUILTIN_MODULES, ModuleRuntime } from '@meridian/modules';
import { createConcertServer, createZvtServer, engineTarget, handleNexo } from '@meridian/bridges';
import type { Server as NetServer } from 'node:net';
import { MemoryPosRepo, PgCluster, PgJournalStore, PgPosRepo, SecretBox, migrate, pg, type PosRepo } from '@meridian/store-pg';

export interface ServerOptions {
  databaseUrl?: string;
  journalFile?: string;
  journalKey: string;
  masterKey: string;
  bootstrapKey?: string;
  allowTestBaseUrl?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  demoSeed?: { stripeUrl: string; secoursUrl: string };
  engine?: { pollMs?: number; retryMs?: number; payTimeoutMs?: number; scanMs?: number };
  logger?: boolean;
  /** Derrière un proxy (Fly) : lire l'IP client dans X-Forwarded-For. Ne jamais activer sans proxy de confiance. */
  trustProxy?: boolean;
  /** URL publique du site, pour robots.txt et sitemap.xml (ex. https://meridian.example). */
  publicUrl?: string;
  /** Durée de conservation des demandes de contact, en jours (défaut 1095 = 3 ans). */
  contactRetentionDays?: number;
  /** Passerelles pour caisses existantes. À exposer uniquement sur le réseau local du magasin (agent local). */
  bridges?: { concertPort?: number; concertMap?: Record<string, string>; zvtPort?: number; zvtPosId?: string; host?: string };
}

interface Org { id: string; mode: 'test' | 'live'; webhookUrl?: string }
interface KeyStore {
  find(hash: string): Promise<Org | undefined>;
  add(orgId: string, name: string, key: string, mode: 'test' | 'live'): Promise<void>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function buildServer(o: ServerOptions) {
  const app = Fastify({ trustProxy: o.trustProxy ?? false, logger: o.logger ? { level: 'info', redact: ['req.headers.authorization'] } : false });

  // ---------- En-têtes de sécurité et compression ----------
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"],
        baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null,
      },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  });
  await app.register(fastifyCompress, { global: true, threshold: 1024 });

  // ---------- Stockage ----------
  let store: JournalStore;
  let repo: PosRepo;
  let keys: KeyStore;
  let pool: pg.Pool | undefined;
  let cluster: PgCluster | undefined;
  if (o.databaseUrl) {
    pool = new pg.Pool({ connectionString: o.databaseUrl });
    await migrate(pool);
    store = new PgJournalStore(pool);
    cluster = new PgCluster(pool);
    repo = new PgPosRepo(pool, new SecretBox(o.masterKey));
    const p = pool;
    keys = {
      async find(hash) {
        const r = await p.query('SELECT k.org_id, k.mode, o.webhook_url FROM api_keys k JOIN organizations o ON o.id=k.org_id WHERE k.hash=$1 AND k.revoked_at IS NULL', [hash]);
        const row = r.rows[0];
        return row ? { id: row.org_id, mode: row.mode, webhookUrl: row.webhook_url ?? undefined } : undefined;
      },
      async add(orgId, name, key, mode) {
        await p.query('INSERT INTO organizations (id, name, kind) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [orgId, name, 'editor']);
        await p.query('INSERT INTO api_keys (id, org_id, prefix, hash, mode) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (hash) DO NOTHING', [`key_${sha(key).slice(0, 12)}`, orgId, key.slice(0, 12), sha(key), mode]);
      },
    };
  } else {
    store = o.journalFile ? new JsonlStore(o.journalFile) : new MemoryStore();
    repo = new MemoryPosRepo();
    const mem = new Map<string, Org>();
    keys = {
      async find(hash) { return mem.get(hash); },
      async add(orgId, _name, key, mode) { mem.set(sha(key), { id: orgId, mode, webhookUrl: o.webhookUrl }); },
    };
  }
  if (o.bootstrapKey) await keys.add('org_demo', 'Démo', o.bootstrapKey, o.bootstrapKey.startsWith('mk_live_') ? 'live' : 'test');

  // ---------- Webhooks sortants signés (file persistante en base, mémoire en mode local) ----------
  const sign = (body: string) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', o.webhookSecret ?? '').update(`${t}.${body}`).digest('hex')}`;
  };
  const post = async (url: string, body: string) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'meridian-signature': sign(body) }, body, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  };
  const deliver = async (orgId: string, event: string, data: unknown) => {
    const url = o.webhookUrl;
    if (!url || !o.webhookSecret) return;
    const id = `evt_${randomBytes(8).toString('hex')}`;
    const payload = { id, type: event, created: new Date().toISOString(), org: orgId, data };
    if (pool) {
      await pool.query('INSERT INTO webhook_deliveries (id, org_id, url, event, payload) VALUES ($1,$2,$3,$4,$5)', [id, orgId, url, event, JSON.stringify(payload)]);
      return;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await post(url, JSON.stringify(payload));
      } catch { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); }
    }
  };
  let webhookTimer: NodeJS.Timeout | undefined;
  if (pool) {
    const p = pool;
    webhookTimer = setInterval(async () => {
      const client = await p.connect().catch(() => undefined);
      if (!client) return;
      try {
        await client.query('BEGIN');
        const r = await client.query("SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_at <= now() ORDER BY next_at LIMIT 20 FOR UPDATE SKIP LOCKED");
        for (const w of r.rows) {
          try {
            await post(w.url, JSON.stringify(w.payload));
            await client.query("UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1 WHERE id = $1", [w.id]);
          } catch (e) {
            const attempts = (w.attempts as number) + 1;
            await client.query(
              "UPDATE webhook_deliveries SET attempts = $2, last_error = $3, status = CASE WHEN $2 >= 12 THEN 'failed' ELSE 'pending' END, next_at = now() + make_interval(secs => LEAST(3600, 2 ^ $2)) WHERE id = $1",
              [w.id, attempts, (e as Error).message],
            );
          }
        }
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
      } finally {
        client.release();
      }
    }, 1000);
    webhookTimer.unref();
  }
  const orgOfPos = async (posId: string) => (await repo.get(posId))?.orgId;

  // ---------- Moteur ----------
  const engine = new Engine({
    journal: new Journal(store, o.journalKey),
    modules: BUILTIN_MODULES,
    routing: (posId) => repo.routing(posId),
    cluster,
    ...o.engine,
    onFinal: (v) => void orgOfPos(v.posId).then((org) => { if (org) void deliver(org, `payment.${v.state}`, v); }),
    onRefund: (v, amount) => void orgOfPos(v.posId).then((org) => { if (org) void deliver(org, 'payment.refunded', { ...v, amount }); }),
  });

  // ---------- Démo : un point de vente par pays de lancement, branché sur les simulateurs ----------
  if (o.demoSeed) {
    for (const c of ['FR', 'BE', 'NL', 'DE', 'ES', 'IT']) {
      const id = `pos_demo_${c}`;
      if (await repo.get(id)) continue;
      const prof = COUNTRIES[c]!;
      await repo.create({ id, orgId: 'org_demo', label: `Borne démo ${c}`, country: c, currency: prof.currency, locale: prof.locales[0]!, timezone: prof.timezone });
      await repo.setRouting(id,
        { moduleId: 'stripe-terminal', config: { secretKey: 'sk_test_sim', readerId: `tmr_sim_${c}` }, baseUrl: o.demoSeed.stripeUrl },
        { moduleId: 'psp-secours', config: { apiKey: 'sim' }, baseUrl: o.demoSeed.secoursUrl });
    }
  }
  const recovery = await engine.recover();
  engine.startScanner(o.engine?.scanMs ?? 3000);
  app.log.info(recovery, 'reprise depuis le journal');

  // ---------- Erreurs ----------
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof MeridianError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: { code: status >= 500 ? 'internal_error' : 'bad_request', message: status >= 500 ? 'Erreur interne' : err.message } });
  });

  // ---------- Authentification ----------
  const auth = async (req: FastifyRequest): Promise<Org> => {
    const h = req.headers.authorization ?? '';
    const m = h.match(/^Bearer (mk_(test|live)_[A-Za-z0-9]+)$/);
    const org = m ? await keys.find(sha(m[1]!)) : undefined;
    if (!org) throw new MeridianError('unauthorized', 'Clé API Meridian invalide', 401);
    return org;
  };
  const ownPos = async (org: Org, posId: string) => {
    const pos = await repo.get(posId);
    if (!pos || pos.orgId !== org.id) throw new MeridianError('pos_not_found', 'Point de vente introuvable', 404);
    return pos;
  };

  // ---------- Limites de débit (partagées entre instances si PostgreSQL) ----------
  // La clé est une empreinte HMAC de l'IP : l'adresse en clair n'est jamais stockée.
  const ipKey = (ip: string) => createHmac('sha256', o.journalKey).update(`ip:${ip}`).digest('hex').slice(0, 32);
  const memHits = new Map<string, number[]>();
  const allow = async (bucket: string, ip: string, max: number, windowMs: number): Promise<boolean> => {
    const key = ipKey(ip);
    if (pool) {
      const r = await pool.query(
        `WITH c AS (SELECT count(*)::int AS n FROM rate_hits WHERE bucket=$1 AND key=$2 AND at > now() - make_interval(secs => $3::double precision))
         INSERT INTO rate_hits (bucket, key) SELECT $1, $2 FROM c WHERE c.n < $4 RETURNING 1`,
        [bucket, key, windowMs / 1000, max]);
      return r.rowCount === 1;
    }
    const now = Date.now(), id = `${bucket}:${key}`;
    const recent = (memHits.get(id) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    memHits.set(id, [...recent, now]);
    return true;
  };
  // Purge RGPD : traces de limite de débit après 24 h, demandes de contact après la durée de conservation.
  const retentionDays = o.contactRetentionDays ?? 1095;
  const purge = async () => {
    if (!pool) return;
    try {
      await pool.query("DELETE FROM rate_hits WHERE at < now() - interval '1 day'");
      await pool.query('DELETE FROM contact_requests WHERE created_at < now() - make_interval(days => $1::int)', [retentionDays]);
    } catch (e) { app.log.warn({ err: e }, 'purge'); }
  };
  void purge();
  const purgeTimer = setInterval(() => void purge(), 3_600_000);
  purgeTimer.unref();

  // ---------- Démo publique « Essayez de le casser » (mode démo uniquement) ----------
  // Vraies pannes injectées dans le simulateur PSP, vrai moteur, vrai journal ; une exécution à la fois.
  if (o.demoSeed) {
    const seed = o.demoSeed;
    let queue: Promise<unknown> = Promise.resolve();
    const simDebits = async () => {
      const [a, b] = await Promise.all([seed.stripeUrl, seed.secoursUrl].map((u) => fetch(`${u}/__state`).then((r) => r.json() as Promise<{ debits: number }>)));
      return a!.debits + b!.debits;
    };
    const faults = (body: Record<string, unknown>) =>
      fetch(`${seed.stripeUrl}/__faults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const SCENARIOS = ['nominal', 'network', 'lost_response', 'declined'] as const;
    app.post('/v1/demo/run', async (req, reply) => {
      const { scenario, amount } = z.object({ scenario: z.enum(SCENARIOS), amount: z.number().int().min(100).max(50_000).default(2450) }).parse(req.body ?? {});
      const now = Date.now();
      if (!(await allow('demo', req.ip, 12, 60_000))) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Trop de démos, réessayez dans une minute' } });
      const run = async () => {
        const posId = 'pos_demo_FR';
        const reference = `DEMO-${now.toString(36)}-${randomBytes(3).toString('hex')}`.toUpperCase();
        await faults({ dropResponse: {}, netDownUntil: 0, declineNext: false, autoPresentMs: 400, authMs: 600 });
        if (scenario === 'declined') await faults({ declineNext: true });
        if (scenario === 'lost_response') await faults({ dropResponse: { process_payment_intent: 1 } });
        const before = await simDebits();
        const t0 = Date.now();
        await engine.pay({ posId, reference, amount, currency: 'EUR' });
        if (scenario === 'network') {
          await new Promise((r) => setTimeout(r, 250));
          await faults({ netDownUntil: Date.now() + 2500 });
        }
        const fin = await engine.waitForFinal(posId, reference, 20_000);
        await new Promise((r) => setTimeout(r, 400)); // laisse arriver un éventuel débit tardif
        const debits = (await simDebits()) - before;
        await faults({ dropResponse: {}, netDownUntil: 0, declineNext: false, autoPresentMs: 150, authMs: 250 });
        const journal = (await store.byReference(posId, reference)).map((e) => ({ seq: e.seq, ms: Date.parse(e.ts) - t0, type: e.type, hash: e.hash, prev: e.prev, data: e.data }));
        return { scenario, reference, amount, currency: 'EUR', state: fin.state, detail: fin.detail ?? null, debits, durationMs: Date.now() - t0, journal, verified: (await engine.verify()).ok };
      };
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    });
  }

  // ---------- Contact (site public) ----------
  const contacts: unknown[] = [];
  app.post('/v1/contact', async (req, reply) => {
    const body = z.object({
      role: z.enum(['software', 'psp', 'other']),
      name: z.string().trim().min(2).max(120),
      company: z.string().trim().min(2).max(160),
      email: z.string().trim().email().max(200),
      country: z.string().trim().max(60).optional(),
      message: z.string().trim().max(2000).optional(),
      lang: z.string().max(5).optional(),
      website: z.string().max(0).optional(), // champ piège anti-robot : doit rester vide
    }).parse(req.body ?? {});
    if (!(await allow('contact', req.ip, 5, 3_600_000))) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Trop de demandes, réessayez plus tard' } });
    const id = `ct_${randomBytes(8).toString('hex')}`;
    const rec = { id, role: body.role, name: body.name, company: body.company, email: body.email, country: body.country ?? null, message: body.message ?? null, lang: body.lang ?? null };
    if (pool) {
      await pool.query('INSERT INTO contact_requests (id, role, name, company, email, country, message, lang) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, rec.role, rec.name, rec.company, rec.email, rec.country, rec.message, rec.lang]);
    } else contacts.push(rec);
    void deliver('org_demo', 'contact.created', rec);
    return reply.code(201).send({ id });
  });

  // ---------- Routes publiques ----------
  app.get('/health', async () => ({ ok: true, journal: (await engine.verify()).ok }));
  app.get('/v1/modules', async () => Object.values(BUILTIN_MODULES).map((m) => ({
    id: m.id, name: m.name, version: m.version, kind: m.kind, capabilities: m.capabilities,
    config: m.config.map((c) => ({ key: c.key, type: c.type, secret: c.secret, label: c.label })),
  })));
  app.get('/v1/countries', async () => COUNTRIES);

  // ---------- Paiements ----------
  const PayBody = z.object({ posId: z.string(), reference: z.string().min(1).max(64), amount: z.number().int().positive(), currency: z.string().length(3), waitMs: z.number().int().min(0).max(120_000).optional() });
  app.post('/v1/payments', async (req, reply) => {
    const org = await auth(req);
    const b = PayBody.parse(req.body);
    await ownPos(org, b.posId);
    let v: PaymentView = await engine.pay(b);
    if (b.waitMs) v = await engine.waitForFinal(b.posId, b.reference, b.waitMs);
    return reply.code(201).send(v);
  });
  const PosQuery = z.object({ posId: z.string() });
  app.get('/v1/payments', async (req) => {
    const org = await auth(req);
    const { posId } = PosQuery.parse(req.query);
    await ownPos(org, posId);
    return engine.listFresh(posId);
  });
  app.get('/v1/payments/:reference', async (req) => {
    const org = await auth(req);
    const { posId } = PosQuery.parse(req.query);
    await ownPos(org, posId);
    const { reference } = req.params as { reference: string };
    const waitMs = Number((req.query as { waitMs?: string }).waitMs ?? 0);
    return waitMs ? engine.waitForFinal(posId, reference, Math.min(waitMs, 60_000)) : engine.statusFresh(posId, reference);
  });
  app.post('/v1/payments/:reference/cancel', async (req) => {
    const org = await auth(req);
    const { posId } = PosQuery.parse(req.body);
    await ownPos(org, posId);
    return engine.cancel(posId, (req.params as { reference: string }).reference);
  });
  const RefundBody = z.object({ posId: z.string(), amount: z.number().int().positive(), refundNumber: z.number().int().positive().optional() });
  app.post('/v1/payments/:reference/refunds', async (req) => {
    const org = await auth(req);
    const b = RefundBody.parse(req.body);
    await ownPos(org, b.posId);
    return engine.refund(b.posId, (req.params as { reference: string }).reference, b.amount, b.refundNumber);
  });
  app.get('/v1/payments/:reference/receipt', async (req) => {
    const org = await auth(req);
    const { posId } = PosQuery.parse(req.query);
    await ownPos(org, posId);
    return engine.receiptFresh(posId, (req.params as { reference: string }).reference);
  });
  app.get('/v1/payments/:reference/journal', async (req) => {
    const org = await auth(req);
    const { posId } = PosQuery.parse(req.query);
    await ownPos(org, posId);
    return store.byReference(posId, (req.params as { reference: string }).reference);
  });
  app.get('/v1/journal/verify', async (req) => {
    await auth(req);
    return engine.verify();
  });

  // ---------- Points de vente ----------
  const PosBody = z.object({
    id: z.string().regex(/^pos_[A-Za-z0-9_]{3,40}$/).optional(),
    label: z.string().min(1).max(80),
    country: z.string().length(2).refine((c) => c in COUNTRIES, 'pays non pris en charge'),
    currency: z.string().length(3).optional(),
    locale: z.string().optional(),
  });
  app.post('/v1/pos', async (req, reply) => {
    const org = await auth(req);
    const b = PosBody.parse(req.body);
    const prof = COUNTRIES[b.country]!;
    const currency = (b.currency ?? prof.currency).toUpperCase();
    if (!isCurrency(currency)) throw new MeridianError('unsupported_currency', `Devise non prise en charge : ${currency}`);
    const pos = await repo.create({
      id: b.id ?? `pos_${randomBytes(8).toString('hex')}`, orgId: org.id, label: b.label, country: b.country,
      currency: currency as Currency, locale: b.locale ?? prof.locales[0]!, timezone: prof.timezone,
    });
    return reply.code(201).send(pos);
  });
  app.get('/v1/pos', async (req) => repo.list((await auth(req)).id));
  app.get('/v1/pos/:id', async (req) => ownPos(await auth(req), (req.params as { id: string }).id));

  const Binding = z.object({ moduleId: z.string(), config: z.record(z.unknown()), baseUrl: z.string().url().optional() });
  app.put('/v1/pos/:id/routing', async (req) => {
    const org = await auth(req);
    const pos = await ownPos(org, (req.params as { id: string }).id);
    const b = z.object({ primary: Binding, fallback: Binding.optional() }).parse(req.body);
    for (const bind of [b.primary, b.fallback].filter(Boolean) as z.infer<typeof Binding>[]) {
      const def = BUILTIN_MODULES[bind.moduleId];
      if (!def) throw new MeridianError('module_not_found', `Module inconnu : ${bind.moduleId}`, 422);
      if (!def.capabilities.countries.includes(pos.country)) throw new MeridianError('module_not_available', `${def.name} n'est pas disponible pour ${pos.country}`, 422);
      if (!def.capabilities.currencies.includes(pos.currency)) throw new MeridianError('module_not_available', `${def.name} n'accepte pas ${pos.currency}`, 422);
      if (bind.baseUrl && !(o.allowTestBaseUrl && org.mode === 'test')) throw new MeridianError('base_url_forbidden', 'URL de PSP personnalisée autorisée uniquement en mode test', 403);
      new ModuleRuntime(def, bind.config); // valide les paramètres obligatoires
    }
    await repo.setRouting(pos.id, b.primary, b.fallback);
    return { posId: pos.id, primary: b.primary.moduleId, fallback: b.fallback?.moduleId ?? null };
  });
  app.post('/v1/pos/:id/health', async (req) => {
    const org = await auth(req);
    const pos = await ownPos(org, (req.params as { id: string }).id);
    const r = await repo.routing(pos.id);
    if (!r) throw new MeridianError('pos_not_configured', 'Aucun module actif', 422);
    const check = async (bnd: typeof r.primary) => {
      try {
        await new ModuleRuntime(BUILTIN_MODULES[bnd.moduleId]!, bnd.config, { baseUrlOverride: bnd.baseUrl, timeoutMs: 4000 }).health();
        return { module: bnd.moduleId, ok: true };
      } catch (e) {
        return { module: bnd.moduleId, ok: false, error: (e as Error).message };
      }
    };
    return { primary: await check(r.primary), fallback: r.fallback ? await check(r.fallback) : null };
  });

  // ---------- Passerelles de compatibilité ----------
  const target = engineTarget(engine);
  app.post('/v1/nexo', async (req) => {
    const org = await auth(req);
    const poi = (req.body as { SaleToPOIRequest?: { MessageHeader?: { POIID?: string } } })?.SaleToPOIRequest?.MessageHeader?.POIID;
    if (poi) await ownPos(org, poi);
    return handleNexo(req.body as Record<string, unknown>, target);
  });
  const netServers: NetServer[] = [];
  const bridgeHost = o.bridges?.host ?? '127.0.0.1';
  if (o.bridges?.concertPort !== undefined) {
    const map = o.bridges.concertMap ?? {};
    const srv = createConcertServer(target, { posFor: (ca) => map[ca] ?? map[String(Number(ca))] });
    await new Promise<void>((r) => srv.listen(o.bridges!.concertPort, bridgeHost, r));
    netServers.push(srv);
  }
  if (o.bridges?.zvtPort !== undefined && o.bridges.zvtPosId) {
    const srv = createZvtServer(target, { posId: o.bridges.zvtPosId });
    await new Promise<void>((r) => srv.listen(o.bridges!.zvtPort, bridgeHost, r));
    netServers.push(srv);
  }
  const bridgePorts = () => netServers.map((s) => (s.address() as { port: number }).port);

  // ---------- Portail ----------
  const portalDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'portal', 'public');
  await app.register(fastifyStatic, {
    root: portalDir, prefix: '/portal/', cacheControl: false, index: false,
    setHeaders: (res, path) => {
      // HTML toujours revalidé ; polices immuables ; le reste court + revalidation (empreintes de fichiers : semaine 2).
      if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (path.includes('/fonts/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    },
  });
  app.get('/', async (_req, reply) => reply.redirect('/portal/'));
  // Pages HTML publiques : l'URL absolue du site ({{BASE}}) est injectée pour canonical, hreflang et Open Graph.
  const PAGES: Record<string, string> = {
    '/portal/': 'index.html', '/portal/index.html': 'index.html',
    '/portal/mentions-legales.html': 'mentions-legales.html', '/portal/legal-notice.html': 'legal-notice.html',
    '/portal/confidentialite.html': 'confidentialite.html', '/portal/privacy.html': 'privacy.html',
  };
  for (const [route, file] of Object.entries(PAGES)) {
    app.get(route, async (req, reply) => {
      const html = (await readFile(join(portalDir, file), 'utf8')).replaceAll('{{BASE}}', base(req));
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
    });
  }
  const base = (req: FastifyRequest) => (o.publicUrl ?? `${req.protocol}://${req.host}`).replace(/\/$/, '');
  app.get('/robots.txt', async (req, reply) => reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600')
    .send(`User-agent: *\nAllow: /portal/\nDisallow: /v1/\nDisallow: /portal/console.html\n\nSitemap: ${base(req)}/sitemap.xml\n`));
  app.get('/sitemap.xml', async (req, reply) => {
    const b = base(req);
    const alt = (fr: string, en: string) => [fr, en].map((u) => `  <url><loc>${b}/portal/${u}</loc>`
      + `<xhtml:link rel="alternate" hreflang="fr" href="${b}/portal/${fr}"/><xhtml:link rel="alternate" hreflang="en" href="${b}/portal/${en}"/></url>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`
      + `  <url><loc>${b}/portal/</loc></url>\n${alt('mentions-legales.html', 'legal-notice.html')}\n${alt('confidentialite.html', 'privacy.html')}\n</urlset>\n`;
    return reply.type('application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(xml);
  });

  app.addHook('onClose', async () => {
    engine.kill();
    if (webhookTimer) clearInterval(webhookTimer);
    clearInterval(purgeTimer);
    await cluster?.close();
    await Promise.all(netServers.map((s) => new Promise((r) => s.close(r))));
    await pool?.end();
  });
  return { app, engine, repo, store, bridgePorts };
}
