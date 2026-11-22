// Serveur MCP Meridian : expose l'API à un assistant de code (Claude Code, Cursor…) chez l'éditeur.
// Règle de sûreté : lecture avec toute clé ; création de paiement et routage uniquement avec une clé de test (mk_test_).
// Aucun outil ne rembourse ni n'annule : ces actions restent dans la caisse ou la console.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface McpOptions { apiKey: string; baseUrl: string; fetcher?: typeof fetch }

export function createMeridianMcp(o: McpOptions): McpServer {
  const f = o.fetcher ?? fetch;
  const isTest = o.apiKey.startsWith('mk_test_');
  const base = o.baseUrl.replace(/\/$/, '');
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await f(base + path, {
      method,
      headers: { authorization: `Bearer ${o.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* texte brut */ }
    if (!r.ok) {
      const err = (data as { error?: { code?: string; message?: string } })?.error;
      throw new Error(`${r.status} ${err?.code ?? ''} ${err?.message ?? text}`.trim());
    }
    return data;
  };
  const out = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
  const run = (fn: () => Promise<unknown>) => fn().then(out, fail);
  const testOnly = () => {
    if (!isTest) throw new Error('Outil réservé aux clés de test (mk_test_…). Utilisez la console pour la production.');
  };
  const q = encodeURIComponent;

  const s = new McpServer({ name: 'meridian', version: '0.1.0' }, {
    instructions: 'Meridian relie une caisse à tous les PSP par cinq appels : pay, status, cancel, refund, receipt. Montants en unités mineures entières (2450 = 24,50 €). Une référence identifie un paiement : la rejouer ne crée jamais un second débit. Commencez par meridian_list_pos puis meridian_list_modules.',
  });

  s.registerTool('meridian_list_modules', {
    title: 'Catalogue des PSP',
    description: 'Liste les modules PSP disponibles, avec pays, devises, moyens de paiement et paramètres à fournir.',
    annotations: { readOnlyHint: true },
  }, () => run(() => call('GET', '/v1/modules')));

  s.registerTool('meridian_status', {
    title: 'Statut des PSP',
    description: 'Taux de réponse et délai moyen de chaque PSP du catalogue, mesurés sur les paiements réels.',
    annotations: { readOnlyHint: true },
  }, () => run(() => call('GET', '/v1/status')));

  s.registerTool('meridian_list_pos', {
    title: 'Points de vente',
    description: 'Liste les points de vente (caisses, bornes) de l’organisation de la clé, avec pays, devise, PSP branché et PSP de secours.',
    annotations: { readOnlyHint: true },
  }, () => run(() => call('GET', '/v1/pos')));

  s.registerTool('meridian_get_payment', {
    title: 'État d’un paiement',
    description: 'État d’un paiement (created, pending, authorized, declined, cancelled, failed), module utilisé et montant remboursé.',
    inputSchema: { posId: z.string(), reference: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ posId, reference }) => run(() => call('GET', `/v1/payments/${q(reference)}?posId=${q(posId)}`)));

  s.registerTool('meridian_payment_journal', {
    title: 'Journal d’un paiement',
    description: 'Entrées signées et chaînées du journal d’un paiement : chaque étape, bascule, reprise et issue. Sert à expliquer ce qui s’est passé.',
    inputSchema: { posId: z.string(), reference: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ posId, reference }) => run(() => call('GET', `/v1/payments/${q(reference)}/journal?posId=${q(posId)}`)));

  s.registerTool('meridian_verify_journal', {
    title: 'Vérifier le journal',
    description: 'Vérifie la chaîne de hachage et les signatures de tout le journal.',
    annotations: { readOnlyHint: true },
  }, () => run(() => call('GET', '/v1/journal/verify')));

  s.registerTool('meridian_test_payment', {
    title: 'Paiement de test',
    description: 'Crée un paiement avec une clé de test et attend son issue (60 s maximum). Refusé avec une clé de production.',
    inputSchema: {
      posId: z.string(),
      reference: z.string().min(1).max(64),
      amount: z.number().int().positive(),
      currency: z.string().length(3),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, (b) => run(async () => { testOnly(); return call('POST', '/v1/payments', { ...b, waitMs: 60_000 }); }));

  return s;
}
