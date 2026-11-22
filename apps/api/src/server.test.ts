// Bout en bout : SDK → API → moteur → simulateurs. En mémoire, puis sur PostgreSQL si DATABASE_URL est défini.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

    it('contact : enregistre une demande valide, refuse un e-mail invalide et le champ piège', async () => {
      const post = (b: unknown) => fetch(`${base}/v1/contact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      const ok = { role: 'software', name: 'Ada Martin', company: 'Caisse Lab', email: 'ada@caisselab.example', country: 'FR', lang: 'fr' };
      expect((await post(ok)).status).toBe(201);
      expect((await post({ ...ok, email: 'pas-un-email' })).status).toBe(400);
      expect((await post({ ...ok, website: 'http://spam' })).status).toBe(400);
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
      const bad = await fetch(`${base}/v1/pos/${pos.id}/routing`, { method: 'PUT', headers: h, body: JSON.stringify({ primary: { moduleId: 'stripe-terminal', config: { secretKey: 'sk_test_x', readerId: 'tmr_x' } } }) });
      expect(bad.status).toBe(422);
      const ok = await fetch(`${base}/v1/pos/${pos.id}/routing`, { method: 'PUT', headers: h, body: JSON.stringify({ primary: { moduleId: 'psp-secours', config: { apiKey: 'sim' }, baseUrl: sims.secoursUrl } }) });
      expect(ok.status).toBe(200);
      const m = new Meridian({ apiKey: KEY, posId: pos.id, baseUrl: base });
      await m.pay({ reference: `CHF-${Date.now()}`, amount: 1290, currency: 'CHF' });
      await expect(m.pay({ reference: `EUR-${Date.now()}`, amount: 100, currency: 'EUR' })).rejects.toBeInstanceOf(MeridianApiError);
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
      expect((await fetch(`${base}/portal/`)).status).toBe(200);
      const mods = await (await fetch(`${base}/v1/modules`)).json();
      expect(mods.map((m: { id: string }) => m.id)).toContain('stripe-terminal');
    });

    it('site public : en-têtes de sécurité, compression, robots, sitemap, URL absolues, pages légales', async () => {
      const home = await fetch(`${base}/portal/`, { headers: { 'accept-encoding': 'br' } });
      expect(home.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(home.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(home.headers.get('strict-transport-security')).toContain('max-age=31536000');
      expect(home.headers.get('x-content-type-options')).toBe('nosniff');
      expect(home.headers.get('content-encoding')).toBe('br');
      expect(home.headers.get('cache-control')).toBe('no-cache');
      const html = await home.text();
      expect(html).not.toContain('{{BASE}}');
      expect(html).toContain(`<link rel="canonical" href="${base}/portal/">`);
      const font = await fetch(`${base}/portal/fonts/instrument-sans-latin-500-normal.woff2`);
      expect(font.headers.get('cache-control')).toContain('immutable');
      expect(await (await fetch(`${base}/robots.txt`)).text()).toContain(`Sitemap: ${base}/sitemap.xml`);
      const map = await (await fetch(`${base}/sitemap.xml`)).text();
      expect(map).toContain(`${base}/portal/confidentialite.html`);
      for (const f of ['mentions-legales', 'legal-notice', 'confidentialite', 'privacy']) {
        expect((await fetch(`${base}/portal/${f}.html`)).status).toBe(200);
      }
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
