// Bout en bout : SDK → API → moteur → simulateurs. En mémoire, puis sur PostgreSQL si DATABASE_URL est défini.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLlm } from '@meridian/ai';
import { Meridian, MeridianApiError } from '../../../packages/sdk-js/src/index.ts';
import { startSims } from '@meridian/sim';
import { pg } from '@meridian/store-pg';
import { buildServer } from './server.ts';

const KEY = 'mk_test_e2e0123456789abcdef';

for (const mode of ['memory', 'postgres'] as const) {
  const dbUrl = process.env.DATABASE_URL;
  describe.skipIf(mode === 'postgres' && !dbUrl)(`API de bout en bout (${mode})`, () => {
    let sims: Awaited<ReturnType<typeof startSims>>;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let base: string;
    beforeAll(async () => {
      if (mode === 'postgres') {
        const p = new pg.Pool({ connectionString: dbUrl });
        await p.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        await p.end();
      }
      sims = await startSims();
      server = await buildServer({
        databaseUrl: mode === 'postgres' ? dbUrl : undefined,
        journalKey: 'e2e-journal-key-0123456789', masterKey: 'e2e-master-key-0123456789abcdef0123456789',
        bootstrapKey: KEY, allowTestBaseUrl: true,
        demoSeed: { stripeUrl: sims.stripeUrl, secoursUrl: sims.secoursUrl },
        engine: { pollMs: 40, retryMs: 60 },
        metricsToken: 'metrics-test-token',
        ai: createLlm({}),
      });
      await server.app.listen({ port: 0, host: '127.0.0.1' });
      base = `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`;
    });
    afterAll(async () => {
      await server?.app.close();
      await sims?.close();
    });

    it('paie via le SDK dans chaque pays de lancement, avec reçu et preuve', async () => {
      for (const c of ['FR', 'DE', 'IT']) {
        const m = new Meridian({ apiKey: KEY, posId: `pos_demo_${c}`, baseUrl: base });
        const ref = `E2E-${mode}-${c}-${Date.now()}`;
        const p = await m.pay({ reference: ref, amount: 2450, currency: 'EUR' });
        expect(['pending', 'authorized']).toContain(p.state);
        const fin = await m.waitForFinal(ref, { timeoutMs: 10_000 });
        expect(fin.state).toBe('authorized');
        const r = await m.receipt(ref);
        expect(r.proof.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('rejeu de pay avec la même référence = même paiement ; remboursement idempotent', async () => {
      const m = new Meridian({ apiKey: KEY, posId: 'pos_demo_ES', baseUrl: base });
      const ref = `E2E-${mode}-RF-${Date.now()}`;
      await m.pay({ reference: ref, amount: 1000, currency: 'EUR', waitMs: 5000 });
      const again = await m.pay({ reference: ref, amount: 1000, currency: 'EUR' });
      expect(again.state).toBe('authorized');
      await m.refund(ref, { amount: 400, refundNumber: 1 });
      const after = await m.refund(ref, { amount: 400, refundNumber: 1 });
      expect(after.refunded).toBe(400);
      expect(sims.stripe.state.refunds.size).toBe(1);
    });

    it('démo publique : vraies pannes injectées, un seul débit, journal vérifié', async () => {
      const run = async (scenario: string) => (await fetch(`${base}/v1/demo/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario }) })).json();
      for (const scenario of ['network', 'lost_response']) {
        const r = await run(scenario);
        expect(r.state).toBe('authorized');
        expect(r.debits).toBe(1);
        expect(r.verified).toBe(true);
        expect(r.journal.some((e: { type: string }) => e.type === 'network_error')).toBe(true);
      }
      const d = await run('declined');
      expect([d.state, d.debits]).toEqual(['declined', 0]);
      expect((await fetch(`${base}/v1/demo/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"scenario":"rm -rf"}' })).status).toBe(400);
    });

    it('catalogue public : fiches sourcées, rôle acceptation / acquisition, état réel du connecteur', async () => {
      const list = await (await fetch(`${base}/v1/catalogue`)).json();
      const by = (id: string) => list.find((o: { id: string }) => o.id === id);
      expect(by('stripe-terminal')).toMatchObject({ status: 'available', roles: ['acceptance', 'acquiring'], pricing: { model: 'blended' } });
      expect(by('sumup-solo').status).toBe('preview');
      expect(by('viva').status).toBe('planned');
      expect(by('store-terminal').roles).toEqual(['acceptance']);
      expect(by('bank-acquiring')).toMatchObject({ status: 'external', roles: ['acquiring'], pricing: { model: 'quote' } });
      for (const o of list) if (o.pricing.model === 'blended') expect(o.pricing.source).toMatch(/^https:\/\//);
    });

    it('IA : estimation publique déterministe ; sans clé de modèle, 503 explicite ; journal expliqué par les faits', async () => {
      const est = await (await fetch(`${base}/v1/catalogue/estimate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: { country: 'FR', monthlyVolume: 20000, avgTicket: 25, businessShare: 0, nonEeaShare: 0 }, current: { monthlyCost: 400 } }) })).json();
      expect(est.estimates.find((e: { id: string }) => e.id === 'stripe-terminal')).toMatchObject({ monthly: 360, savings: 40 });
      const h = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
      expect(await (await fetch(`${base}/v1/console/config`)).json()).toEqual({ demoKey: KEY });
      const demo = await (await fetch(`${base}/v1/demo/statement`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      expect(demo.method).toBe('manual');
      expect(demo.facts.cardVolume).toBe(21870.4);
      expect(demo.result.estimates[0].savings).toBeGreaterThan(0);
      const adv = await fetch(`${base}/v1/ai/advisor`, { method: 'POST', headers: h, body: JSON.stringify({ country: 'FR', text: 'Boulangerie, 15 000 € par mois' }) });
      expect([adv.status, (await adv.json()).error.code]).toEqual([503, 'ai_unavailable']);
      expect((await fetch(`${base}/v1/ai/advisor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
      await fetch(`${base}/v1/payments`, { method: 'POST', headers: h, body: JSON.stringify({ posId: 'pos_demo_FR', reference: `AI-EXPL-${mode}`, amount: 1200, currency: 'EUR', waitMs: 8000 }) });
      const ex = await (await fetch(`${base}/v1/ai/explain`, { method: 'POST', headers: h, body: JSON.stringify({ posId: 'pos_demo_FR', reference: `AI-EXPL-${mode}` }) })).json();
      expect(ex.method).toBe('facts');
      expect(ex.facts[0]).toContain(`AI-EXPL-${mode}`);
    });

    it('démo terminal : vrai agent, TPE simulé, réponse perdue sans double ordre', async () => {
      const r = await (await fetch(`${base}/v1/demo/terminal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"cloud","incident":"lost_reply"}' })).json();
      expect(r).toMatchObject({ state: 'authorized', orders: 1, debits: 1 });
      expect((await fetch(`${base}/v1/demo/terminal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"x","incident":"none"}' })).status).toBe(400);
    });

    it('contact : enregistre une demande valide, refuse un e-mail invalide et le champ piège', async () => {
      const post = (b: unknown) => fetch(`${base}/v1/contact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      const ok = { role: 'reseller', name: 'Ada Martin', company: 'Caisse Lab', email: 'ada@caisselab.example', country: 'FR', lang: 'fr' };
      expect((await post(ok)).status).toBe(201);
      expect((await post({ ...ok, email: 'pas-un-email' })).status).toBe(400);
      expect((await post({ ...ok, website: 'http://spam' })).status).toBe(400);
    });

    it('PSP de la caisse et rapprochement : chaque paiement terminé concorde avec le PSP', async () => {
      const h = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
      const pos = await (await fetch(`${base}/v1/pos`, { method: 'POST', headers: h, body: JSON.stringify({ label: 'Caisse rapprochement', country: 'FR' }) })).json();
      const stripe = { moduleId: 'stripe-terminal', config: { secretKey: 'sk_test_sim', readerId: 'tmr_sim_FR' }, baseUrl: sims.stripeUrl };
      const put = (body: unknown) => fetch(`${base}/v1/pos/${pos.id}/psp`, { method: 'PUT', headers: h, body: JSON.stringify(body) });
      expect((await put({ primary: stripe, fallback: stripe })).status).toBe(422);
      expect((await put({ primary: stripe })).status).toBe(200);
      const m = new Meridian({ apiKey: KEY, posId: pos.id, baseUrl: base });
      for (const [i, amount] of [60_000, 1000].entries()) {
        const ref = `REC-${mode}-${Date.now()}-${i}`;
        await m.pay({ reference: ref, amount, currency: 'EUR' });
        expect(await m.waitForFinal(ref, { timeoutMs: 10_000 })).toMatchObject({ state: 'authorized', module: 'stripe-terminal' });
      }
      expect(JSON.stringify(await (await fetch(`${base}/v1/audit`, { headers: h })).json())).not.toContain('sk_test_sim');
      const rec = await (await fetch(`${base}/v1/reconcile`, { method: 'POST', headers: h, body: JSON.stringify({ posId: pos.id }) })).json();
      expect(rec).toMatchObject({ count: 2, mismatches: 0 });
      expect(rec.rows.map((r: { meridian: string; psp: string }) => `${r.meridian}/${r.psp}`)).toEqual(['authorized/authorized', 'authorized/authorized']);
      expect(rec.totals).toEqual([{ module: 'stripe-terminal', currency: 'EUR', authorized: 61_000, refunded: 0, count: 2 }]);
    });

    it('bascule vers le secours quand Stripe est injoignable', async () => {
      await sims.stopStripe();
      const m = new Meridian({ apiKey: KEY, posId: 'pos_demo_NL', baseUrl: base });
      const ref = `E2E-${mode}-FB-${Date.now()}`;
      await m.pay({ reference: ref, amount: 700, currency: 'EUR' });
      const fin = await m.waitForFinal(ref, { timeoutMs: 10_000 });
      expect(fin.state).toBe('authorized');
      expect(fin.module).toBe('psp-secours');
    });

    it('refuse une clé invalide et un point de vente d’une autre organisation', async () => {
      const bad = new Meridian({ apiKey: 'mk_test_nope', posId: 'pos_demo_FR', baseUrl: base, retries: 0 });
      await expect(bad.status('x')).rejects.toMatchObject({ status: 401 });
      const res = await fetch(`${base}/v1/pos/pos_inconnu`, { headers: { authorization: `Bearer ${KEY}` } });
      expect(res.status).toBe(404);
    });

    it('crée un point de vente en Suisse (CHF) et refuse un module qui n’y est pas disponible', async () => {
      const h = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
      const pos = await (await fetch(`${base}/v1/pos`, { method: 'POST', headers: h, body: JSON.stringify({ label: 'Kiosque Genève', country: 'CH' }) })).json();
      expect(pos.currency).toBe('CHF');
      const bad = await fetch(`${base}/v1/pos/${pos.id}/psp`, { method: 'PUT', headers: h, body: JSON.stringify({ primary: { moduleId: 'stripe-terminal', config: { secretKey: 'sk_test_x', readerId: 'tmr_x' } } }) });
      expect(bad.status).toBe(422);
      const ok = await fetch(`${base}/v1/pos/${pos.id}/psp`, { method: 'PUT', headers: h, body: JSON.stringify({ primary: { moduleId: 'psp-secours', config: { apiKey: 'sim' }, baseUrl: sims.secoursUrl } }) });
      expect(ok.status).toBe(200);
      const m = new Meridian({ apiKey: KEY, posId: pos.id, baseUrl: base });
      await m.pay({ reference: `CHF-${Date.now()}`, amount: 1290, currency: 'CHF' });
      await expect(m.pay({ reference: `EUR-${Date.now()}`, amount: 100, currency: 'EUR' })).rejects.toBeInstanceOf(MeridianApiError);
    });

    it('journal d\'audit : actions d\'administration tracées, sans aucun secret ; échec d\'authentification tracé', async () => {
      const h = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
      const pos = await (await fetch(`${base}/v1/pos`, { method: 'POST', headers: h, body: JSON.stringify({ label: 'Audit', country: 'FR' }) })).json();
      await fetch(`${base}/v1/pos/${pos.id}/psp`, { method: 'PUT', headers: h, body: JSON.stringify({ primary: { moduleId: 'psp-secours', config: { apiKey: 'secret-ne-doit-pas-apparaitre' }, baseUrl: sims.secoursUrl } }) });
      await fetch(`${base}/v1/pos`, { headers: { authorization: 'Bearer mk_test_inconnue000' } });
      const log = await (await fetch(`${base}/v1/audit?limit=50`, { headers: h })).json();
      const mine = log.filter((e: { target: string }) => e.target === pos.id).map((e: { action: string }) => e.action);
      expect(mine).toEqual(expect.arrayContaining(['pos.created', 'pos.psp_changed']));
      expect(JSON.stringify(log)).not.toContain('secret-ne-doit-pas-apparaitre');
      expect(log.find((e: { action: string }) => e.action === 'pos.psp_changed').detail).toEqual({ primary: 'psp-secours', fallback: null });
      if (mode === 'postgres') {
        const p = new pg.Pool({ connectionString: dbUrl });
        expect((await p.query("SELECT count(*)::int AS n FROM audit_log WHERE action='auth.failed'")).rows[0].n).toBeGreaterThan(0);
        await expect(p.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
        await p.end();
      }
    });

    it('nexo Retailer en XML par l\'API : réponse XML', async () => {
      const xml = `<SaleToPOIRequest><MessageHeader ProtocolVersion="3.1" MessageClass="Service" MessageCategory="Payment" MessageType="Request" ServiceID="X1" SaleID="C1" POIID="pos_demo_FR"/><PaymentRequest><SaleData><SaleTransactionID TransactionID="XML-${Date.now()}"/></SaleData><PaymentTransaction><AmountsReq Currency="EUR" RequestedAmount="7.50"/></PaymentTransaction></PaymentRequest></SaleToPOIRequest>`;
      const r = await fetch(`${base}/v1/nexo`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/xml' }, body: xml });
      expect(r.headers.get('content-type')).toContain('application/xml');
      const out = await r.text();
      expect(out).toContain('<Response Result="Success"');
      expect(out).toContain('AuthorizedAmount="7.5"');
      const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY boom "expansion">]><SaleToPOIRequest><MessageHeader POIID="pos_demo_FR" MessageCategory="Login" MessageType="Request"/></SaleToPOIRequest>`;
      const r2 = await fetch(`${base}/v1/nexo`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/xml' }, body: evil });
      expect(r2.status).toBe(400);
      expect(JSON.stringify(await r2.json())).not.toContain('expansion');
    });

    it('deux paiements différents en même temps sur le même terminal : un seul passe (terminal_busy)', async () => {
      const h = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
      const [a, b] = await Promise.all([
        fetch(`${base}/v1/payments`, { method: 'POST', headers: h, body: JSON.stringify({ posId: 'pos_demo_FR', reference: `BUSY-A-${mode}-${Date.now()}`, amount: 100, currency: 'EUR' }) }),
        fetch(`${base}/v1/payments`, { method: 'POST', headers: h, body: JSON.stringify({ posId: 'pos_demo_FR', reference: `BUSY-B-${mode}-${Date.now()}`, amount: 100, currency: 'EUR' }) }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const ko = a.status === 409 ? a : b;
      expect((await ko.json()).error.code).toBe('terminal_busy');
      const winner = a.status === 201 ? await a.json() : await b.json();
      const m = new Meridian({ apiKey: KEY, posId: 'pos_demo_FR', baseUrl: base });
      expect((await m.waitForFinal(winner.reference, { timeoutMs: 10_000 })).state).toBe('authorized');
    });

    it('remboursements concurrents plafonnés : un seul passe ; rejeu après réponse perdue sans double', async () => {
      const m = new Meridian({ apiKey: KEY, posId: 'pos_demo_BE', baseUrl: base, retries: 0 });
      const ref = `CAP-${mode}-${Date.now()}`;
      await m.pay({ reference: ref, amount: 1000, currency: 'EUR', waitMs: 5000 });
      // Montant remboursé chez le PSP qui a encaissé (Stripe peut être arrêté par le test de bascule).
      const pspRefunded = (r: string) =>
        ([...sims.stripe.state.intents.values()].find((x) => x.metadata.meridian_ref === r)?.amount_refunded ?? 0)
        + ([...sims.secours.state.checkouts.values()].find((c) => c.reference === r)?.refunded ?? 0);
      const res = await Promise.allSettled([
        m.refund(ref, { amount: 600, refundNumber: 1 }),
        m.refund(ref, { amount: 600, refundNumber: 2 }),
      ]);
      expect(res.filter((x) => x.status === 'fulfilled').length).toBe(1);
      const ko = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      expect(ko.reason).toMatchObject({ status: 400, code: 'refund_exceeds_amount' });
      await new Promise((r) => setTimeout(r, 300));
      expect(pspRefunded(ref)).toBe(600);
      // Réponse perdue : le remboursement est traité chez le PSP, la reprise avec le même n ne double pas.
      const which = [...sims.stripe.state.intents.values()].some((x) => x.metadata.meridian_ref === ref) ? sims.stripe : sims.secours;
      which.faults.dropResponse = { '/v1/refunds': 1, '/refunds': 1 };
      await expect(m.refund(ref, { amount: 200, refundNumber: 3 })).rejects.toMatchObject({ status: 503, code: 'refund_pending' });
      which.faults.dropResponse = {};
      const v = await m.refund(ref, { amount: 200, refundNumber: 3 });
      expect(v.refunded).toBe(800);
      expect(pspRefunded(ref)).toBe(800);
      // Montant différent pour le même n : conflit.
      await expect(m.refund(ref, { amount: 250, refundNumber: 3 })).rejects.toMatchObject({ status: 409, code: 'refund_conflict' });
    });

    it('montant au-delà du plafond : refusé avant tout envoi', async () => {
      const m = new Meridian({ apiKey: KEY, posId: 'pos_demo_DE', baseUrl: base, retries: 0 });
      await expect(m.pay({ reference: `MAX-${mode}-${Date.now()}`, amount: 100_000_000, currency: 'EUR' }))
        .rejects.toMatchObject({ status: 400, code: 'invalid_request' });
      const ref = `MAXOK-${mode}-${Date.now()}`;
      await m.pay({ reference: ref, amount: 99_999_999, currency: 'EUR' });
      expect((await m.waitForFinal(ref, { timeoutMs: 10_000 })).state).toBe('authorized');
    });

    it('santé : /health léger ne lit pas le journal et expose les compteurs du moteur', async () => {
      const spy = vi.spyOn(server.store, 'all');
      spy.mockClear();
      const r = await fetch(`${base}/health`);
      expect(r.status).toBe(200);
      const h = await r.json();
      expect(h).toMatchObject({ ok: true, persistent: mode === 'postgres', pending: expect.any(Number), stuck: expect.any(Number) });
      if (mode === 'postgres') expect(h.db).toBe(true);
      expect(h.journal).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('journal intact et, sur PostgreSQL, non modifiable', async () => {
      const v = await (await fetch(`${base}/v1/journal/verify`, { headers: { authorization: `Bearer ${KEY}` } })).json();
      expect(v.ok).toBe(true);
      if (mode === 'postgres') {
        const p = new pg.Pool({ connectionString: dbUrl });
        await expect(p.query('UPDATE journal SET data = \'{}\' WHERE seq = 1')).rejects.toThrow(/append-only/);
        await p.end();
      }
    });

    it('sert le portail et le catalogue', async () => {
      expect((await fetch(`${base}/fr/`)).status).toBe(200);
      const mods = await (await fetch(`${base}/v1/modules`)).json();
      expect(mods.map((m: { id: string }) => m.id)).toContain('stripe-terminal');
    });

    it('site public : 24 pages pré-rendues, hreflang, en-têtes de sécurité, compression, redirections', async () => {
      const home = await fetch(`${base}/fr/`, { headers: { 'accept-encoding': 'br' } });
      expect(home.status).toBe(200);
      expect(home.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(home.headers.get('strict-transport-security')).toContain('max-age=31536000');
      expect(home.headers.get('content-encoding')).toBe('br');
      const html = await home.text();
      expect(html).not.toContain('{{BASE}}');
      expect(html).toContain(`<link rel="canonical" href="${base}/fr/">`);
      expect(html).toContain(`hreflang="de" href="${base}/de/"`);
      // texte déjà dans le HTML, sans JavaScript, dans la bonne langue
      const de = await (await fetch(`${base}/de/kassensoftware/`)).text();
      expect(de).toMatch(/<html[^>]*lang="de"/);
      expect(de).toContain('Verlieren Sie keinen Verkauf mehr');
      expect(de).not.toContain('data-view="home"');
      const css = de.match(/href="(\/assets\/site\.[0-9a-f]+\.css)"/)![1]!;
      expect((await fetch(`${base}${css}`)).headers.get('cache-control')).toContain('immutable');
      for (const p of ['/fr/editeurs/', '/fr/distributeurs/', '/de/haendler/', '/en/pos-software/', '/it/demo/', '/nl/psp/', '/fr/securite/', '/en/developers/', '/fr/contact/', '/en/zvt-protocol/', '/fr/mentions-legales/', '/en/privacy/']) {
        expect((await fetch(`${base}${p}`)).status, p).toBe(200);
      }
      const root = await fetch(`${base}/`, { redirect: 'manual', headers: { 'accept-language': 'es-ES,es;q=0.9' } });
      expect(root.headers.get('location')).toBe('/es/');
      expect((await fetch(`${base}/portal/`, { redirect: 'manual' })).status).toBe(301);
      expect((await fetch(`${base}/portal/confidentialite.html`, { redirect: 'manual' })).headers.get('location')).toBe('/fr/confidentialite/');
      expect((await fetch(`${base}/fr/nexistepas/`, { headers: { accept: 'text/html' } })).status).toBe(404);
      expect((await fetch(`${base}/portal/console.html`)).status).toBe(200);
      const map = await (await fetch(`${base}/sitemap.xml`)).text();
      expect(map.match(/<url>/g)!.length).toBe(52);
      expect(await (await fetch(`${base}/robots.txt`)).text()).toContain(`Sitemap: ${base}/sitemap.xml`);
      expect(await (await fetch(`${base}/.well-known/security.txt`)).text()).toMatch(/^Contact: mailto:security@/);
    });

    it('statut public des PSP : sans authentification, sans volumes, page FR et EN', async () => {
      const r = await fetch(`${base}/v1/status`);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.modules.map((m: { module: string }) => m.module)).toContain('stripe-terminal');
      expect(j.modules.map((m: { module: string }) => m.module)).not.toContain('psp-secours');
      expect(JSON.stringify(j)).not.toMatch(/pos_|"amount"/);
      const llms = await (await fetch(`${base}/llms.txt`)).text();
      expect(llms).toMatch(/^# Meridian/);
      expect(llms).not.toContain('{{BASE}}');
      for (const u of ['/fr/statut/', '/en/status/']) {
        const page = await (await fetch(`${base}${u}`)).text();
        expect(page).toContain('id="psp-status"');
      }
    });

    it('mesure d\'audience : compteurs anonymes, lecture protégée', async () => {
      const beacon = (b: unknown) => fetch(`${base}/v1/a`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(b) });
      expect((await beacon({ e: 'view', p: '/fr/', l: 'fr', r: 'linkedin.com' })).status).toBe(204);
      expect((await beacon({ e: 'cta_psp', p: '/fr/psp/', l: 'fr' })).status).toBe(204);
      expect((await beacon({ e: 'inconnu', p: '/x' })).status).toBe(204); // ignoré
      expect((await fetch(`${base}/v1/metrics`)).status).toBe(404);
      const m = await (await fetch(`${base}/v1/metrics?days=2`, { headers: { authorization: 'Bearer metrics-test-token' } })).json();
      expect(m.events.view).toBeGreaterThanOrEqual(1);
      expect(m.events.cta_psp).toBeGreaterThanOrEqual(1);
      expect(m.referrers['linkedin.com']).toBeGreaterThanOrEqual(1);
      expect(m.events.inconnu).toBeUndefined();
    });

    it('contact : limite de 5 demandes par heure et par adresse', async () => {
      const post = () => fetch(`${base}/v1/contact`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'psp', name: 'Test', company: 'Acme', email: 'a@acme.example' }) });
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await post()).status);
      expect(codes).toContain(429);
      expect(codes.at(-1)).toBe(429);
    });
  });
}

describe('garde pooler en mode transaction', () => {
  const opts = (databaseUrl: string) => ({ databaseUrl, journalKey: 'pooler-key-0123456789abcdef', masterKey: 'pooler-master-key-0123456789abcdef' });
  it('refuse les URL de pooler sans contournement explicite', async () => {
    await expect(buildServer(opts('postgres://u:x@ep-a-pooler.eu-west-2.aws.neon.tech/db'))).rejects.toThrow(/connexion directe/);
    await expect(buildServer(opts('postgres://u:x@db.ref.supabase.co:6543/postgres'))).rejects.toThrow(/connexion directe/);
    await expect(buildServer(opts('postgres://u:x@hôte:5432/db?pgbouncer=true'))).rejects.toThrow(/connexion directe/);
  });
});
