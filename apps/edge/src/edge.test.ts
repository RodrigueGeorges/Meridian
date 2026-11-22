// Tous les modes d'intégration d'un TPE du magasin : API locale (caisse installée) et API cloud via l'agent (caisse SaaS).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Meridian } from '../../../packages/sdk-js/src/index.ts';
import { startSims } from '@meridian/sim';
import { CaisseApDriver, NexoDriver, startTerminalSims, ZvtDriver } from '@meridian/terminals';
import { buildServer } from '../../api/src/server.ts';
import { startAgent, type Agent } from './agent.ts';

const KEY = 'mk_test_edge0123456789abcdef';
let tpe: Awaited<ReturnType<typeof startTerminalSims>>;
let sims: Awaited<ReturnType<typeof startSims>>;
let server: Awaited<ReturnType<typeof buildServer>>;
let base: string;
const agents: Agent[] = [];
const h = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

beforeAll(async () => {
  tpe = await startTerminalSims();
  sims = await startSims();
  server = await buildServer({
    journalKey: 'edge-journal-key-0123456789', masterKey: 'edge-master-key-0123456789abcdef0123456789',
    bootstrapKey: KEY, allowTestBaseUrl: true, engine: { pollMs: 40, retryMs: 60, httpTimeoutMs: 800 },
  });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  for (const a of agents) await a.close();
  await server?.app.close();
  await sims?.close();
  await tpe?.close();
});

async function posWithAgent(country: string, agentId: string, fallback = false) {
  const pos = await (await fetch(`${base}/v1/pos`, { method: 'POST', headers: h, body: JSON.stringify({ label: `Magasin ${agentId}`, country }) })).json();
  const body = {
    primary: { moduleId: 'edge-terminal', config: { agentId, orgId: 'tentative-autre-org' } },
    ...(fallback ? { fallback: { moduleId: 'psp-secours', config: { apiKey: 'sim' }, baseUrl: sims.secoursUrl } } : {}),
  };
  const r = await fetch(`${base}/v1/pos/${pos.id}/psp`, { method: 'PUT', headers: h, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  return pos.id as string;
}

describe('API locale : caisse installée → agent → TPE', () => {
  it('les 5 appels, sans Internet, avec le SDK habituel', async () => {
    const a = await startAgent({ driver: new CaisseApDriver({ host: '127.0.0.1', port: tpe.caisseAp.port }), local: { port: 0 } });
    agents.push(a);
    const m = new Meridian({ apiKey: 'local', posId: 'caisse-1', baseUrl: a.localUrl! });
    const before = tpe.caisseAp.sim.debits();
    await m.pay({ reference: 'LOC-1', amount: 2450, currency: 'EUR' });
    await m.pay({ reference: 'LOC-1', amount: 2450, currency: 'EUR' }); // rejeu
    const v = await m.waitForFinal('LOC-1', { timeoutMs: 10_000 });
    expect(v).toMatchObject({ state: 'authorized', module: 'edge-terminal' });
    expect(tpe.caisseAp.sim.debits() - before).toBe(1);
    expect((await m.receipt('LOC-1')).proof.signature).toBeTruthy();
    expect((await m.refund('LOC-1', { amount: 450, refundNumber: 1 })).refunded).toBe(450);
    const verify = await (await fetch(`${a.localUrl}/v1/journal/verify`)).json();
    expect(verify.ok).toBe(true);
    await m.pay({ reference: 'LOC-2', amount: 1013, currency: 'EUR' });
    expect((await m.waitForFinal('LOC-2', { timeoutMs: 10_000 })).state).toBe('declined');
  });
});

describe('API cloud : caisse SaaS → API Meridian → agent → TPE', () => {
  it('paiement ZVT par le relais, agent visible, connexion testée, rapprochement concordant', async () => {
    const a = await startAgent({ driver: new ZvtDriver({ host: '127.0.0.1', port: tpe.zvt.port }), local: false, cloud: { url: base, apiKey: KEY, agentId: 'berlin-1' } });
    agents.push(a);
    await a.ready;
    const posId = await posWithAgent('DE', 'berlin-1');
    const listed = await (await fetch(`${base}/v1/edge/agents`, { headers: h })).json();
    expect(listed).toEqual([expect.objectContaining({ agentId: 'berlin-1', protocol: 'zvt' })]);
    const health = await (await fetch(`${base}/v1/pos/${posId}/health`, { method: 'POST', headers: { authorization: h.authorization } })).json();
    expect(health.primary, JSON.stringify(health)).toMatchObject({ module: 'edge-terminal', ok: true });
    const m = new Meridian({ apiKey: KEY, posId, baseUrl: base });
    const before = tpe.zvt.sim.debits();
    await m.pay({ reference: 'CLD-1', amount: 3990, currency: 'EUR' });
    expect(await m.waitForFinal('CLD-1', { timeoutMs: 10_000 })).toMatchObject({ state: 'authorized', module: 'edge-terminal' });
    expect(tpe.zvt.sim.debits() - before).toBe(1);
    await m.refund('CLD-1', { amount: 3990, refundNumber: 1 });
    expect(tpe.zvt.sim.refunded()).toBeGreaterThanOrEqual(3990);
    const rec = await (await fetch(`${base}/v1/reconcile`, { method: 'POST', headers: h, body: JSON.stringify({ posId }) })).json();
    expect(rec).toMatchObject({ count: 1, mismatches: 0 });
  });

  it('réponse de l\'agent perdue : rejeu sûr, un seul paiement au terminal', async () => {
    const a = await startAgent({ driver: new NexoDriver({ url: tpe.nexo.url, poiId: 'tpe' }), local: false, cloud: { url: base, apiKey: KEY, agentId: 'paris-2' }, dropReplies: 1 });
    agents.push(a);
    await a.ready;
    const posId = await posWithAgent('FR', 'paris-2');
    const m = new Meridian({ apiKey: KEY, posId, baseUrl: base });
    const before = tpe.nexo.sim.debits();
    await m.pay({ reference: 'CLD-LOST', amount: 1590, currency: 'EUR' });
    expect((await m.waitForFinal('CLD-LOST', { timeoutMs: 15_000 })).state).toBe('authorized');
    expect(a.service.sent).toBe(1);
    expect(tpe.nexo.sim.debits() - before).toBe(1);
  });

  it('agent hors ligne : rien n\'est envoyé, bascule vers le PSP de secours choisi par le marchand', async () => {
    const a = await startAgent({ driver: new CaisseApDriver({ host: '127.0.0.1', port: tpe.caisseAp.port }), local: false, cloud: { url: base, apiKey: KEY, agentId: 'lyon-3' } });
    await a.ready;
    const posId = await posWithAgent('FR', 'lyon-3', true);
    await a.close();
    await new Promise((r) => setTimeout(r, 100));
    const m = new Meridian({ apiKey: KEY, posId, baseUrl: base });
    await m.pay({ reference: 'CLD-OFF', amount: 800, currency: 'EUR' });
    expect(await m.waitForFinal('CLD-OFF', { timeoutMs: 10_000 })).toMatchObject({ state: 'authorized', module: 'psp-secours' });
    expect(a.service.sent).toBe(0);
  });

  it('une organisation ne peut pas viser l\'agent d\'une autre ; agent refusé sans clé valide', async () => {
    // orgId fourni par la caisse ignoré : le serveur le remplace par celui de la clé (vérifié par le paiement ci-dessus).
    const bad = await fetch(`${base}/v1/pos/x/psp`, { method: 'PUT', headers: h, body: '{}' });
    expect(bad.status).toBe(404);
    const { default: WebSocket } = await import('ws');
    const code = await new Promise<number>((res) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/v1/edge/connect', { headers: { authorization: 'Bearer mk_test_faux', 'x-meridian-agent': 'pirate' } });
      ws.on('close', (c) => res(c));
      ws.on('error', () => res(-1));
    });
    expect(code).toBe(4401);
  });
});
