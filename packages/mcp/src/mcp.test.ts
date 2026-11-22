import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMeridianMcp } from './server.ts';

async function connect(apiKey: string, seen: string[]) {
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method} ${url.replace('http://x', '')}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const server = createMeridianMcp({ apiKey, baseUrl: 'http://x', fetcher });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return client;
}

describe('serveur MCP', () => {
  it('expose les outils, en lecture seule sauf le paiement de test ; ni annulation ni remboursement', async () => {
    const c = await connect('mk_test_x', []);
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'meridian_get_payment', 'meridian_list_modules', 'meridian_list_pos', 'meridian_payment_journal',
      'meridian_status', 'meridian_test_payment', 'meridian_verify_journal',
    ]);
    expect(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(['meridian_test_payment']);
  });
  it('appelle la bonne route ; refuse le paiement avec une clé de production', async () => {
    const seen: string[] = [];
    const test = await connect('mk_test_x', seen);
    await test.callTool({ name: 'meridian_get_payment', arguments: { posId: 'pos_a b', reference: 'R/1' } });
    const ok = await test.callTool({ name: 'meridian_test_payment', arguments: { posId: 'pos_a', reference: 'R1', amount: 100, currency: 'EUR' } });
    expect(ok.isError).toBeFalsy();
    expect(seen).toEqual(['GET /v1/payments/R%2F1?posId=pos_a%20b', 'POST /v1/payments']);
    const liveSeen: string[] = [];
    const live = await connect('mk_live_x', liveSeen);
    const r = await live.callTool({ name: 'meridian_test_payment', arguments: { posId: 'pos_a', reference: 'R1', amount: 100, currency: 'EUR' } });
    expect(r.isError).toBe(true);
    expect(liveSeen).toEqual([]);
  });
});
