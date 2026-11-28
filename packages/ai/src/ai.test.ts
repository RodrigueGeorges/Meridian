import { describe, expect, it } from 'vitest';
import { OFFERS } from '@meridian/modules';
import { createLlm, documentText, draftModule, estimate, explainPayment, firstJson, fromStatement, llmFromEnv, profileFromText, readStatement, redact, AiUnavailable, type Purpose } from './index.ts';

/** Faux fournisseurs : Mistral (chat, OCR) et Anthropic (Messages). Répond, par modèle, avec les textes donnés à la suite. */
function fakeModel(answers: Partial<Record<string, string[]>>, seen: { url: string; model: string; body: string }[] = []) {
  const fetcher: typeof fetch = async (url, init) => {
    const b = JSON.parse(String(init?.body)) as { model: string; messages?: { content: string }[]; document?: unknown };
    seen.push({ url: String(url), model: b.model, body: (b.messages ?? []).map((m) => m.content).join('\n') });
    const text = answers[b.model]!.shift()!;
    const u = String(url);
    const payload = u.endsWith('/v1/ocr') ? { pages: [{ markdown: text }] }
      : u.endsWith('/v1/chat/completions') ? { choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
      : { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return fetcher;
}

describe('moteur de coût (sans modèle)', () => {
  it('calcule le coût mensuel par offre, choisit la meilleure formule et compare au coût actuel', () => {
    const r = estimate(OFFERS, { country: 'FR', monthlyVolume: 20_000, avgTicket: 25, businessShare: 0, nonEeaShare: 0, terminals: 1, needs: [] }, { monthlyCost: 400 });
    const by = (id: string) => r.estimates.find((e) => e.id === id)!;
    expect(r.transactions).toBe(800);
    expect(by('stripe-terminal').monthly).toBe(360); // 1,4 % × 20 000 + 0,10 × 800
    expect(by('sumup-solo')).toMatchObject({ monthly: 197, plan: 'plus' }); // 0,89 % × 20 000 + 19
    expect(by('stripe-terminal').savings).toBe(40);
    expect(by('adyen-terminal')).toMatchObject({ monthly: null, reason: 'icpp' });
    expect(r.estimates[0]!.monthly).toBe(197); // trié du moins cher au plus cher
  });
  it('« je garde ma banque » ne propose que le terminal du magasin et le contrat de la banque', () => {
    const r = estimate(OFFERS, { country: 'FR', monthlyVolume: 10_000, businessShare: 0.05, nonEeaShare: 0.05, terminals: 1, needs: ['keep_bank'] });
    expect(r.estimates.map((e) => e.id).sort()).toEqual(['bank-acquiring', 'store-terminal']);
  });
});

describe('modèles', () => {
  it('Mistral par défaut, sur le point d’accès européen, un modèle par usage ; Anthropic en option ; sans clé, refus explicite', async () => {
    const seen: { url: string; model: string; body: string }[] = [];
    const llm = createLlm({ apiKey: 'k', fetcher: fakeModel({ 'mistral-small-latest': ['ok'], 'mistral-medium-latest': ['ok', 'ok'] }, seen) });
    for (const p of ['advisor', 'statement', 'modulegen'] as Purpose[]) await llm.text(p, { system: 's', user: 'u' });
    expect(seen.map((x) => x.model)).toEqual(['mistral-small-latest', 'mistral-medium-latest', 'mistral-medium-latest']);
    expect(seen[0]!.url).toBe('https://api.eu.mistral.ai/v1/chat/completions');
    const env = llmFromEnv({ ANTHROPIC_API_KEY: 'a' });
    expect([env.provider, env.models.statement]).toEqual(['anthropic', 'claude-sonnet-5-5']);
    expect(llmFromEnv({ MISTRAL_API_KEY: 'm', AI_MODEL_SUPPORT: 'ministral-8b-latest' }).models.support).toBe('ministral-8b-latest');
    await expect(createLlm({}).text('support', { system: 's', user: 'u' })).rejects.toBeInstanceOf(AiUnavailable);
  });
  it('Mistral OCR lit un PDF (même scanné) avant l’extraction', async () => {
    const seen: { url: string; model: string; body: string }[] = [];
    const llm = createLlm({ apiKey: 'k', fetcher: fakeModel({ 'mistral-ocr-latest': ['| Total CB | 18 430,50 € |\n| Commissions | 312,40 € HT |'] }, seen) });
    const text = await documentText({ type: 'application/pdf', data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }, llm);
    expect(text).toContain('18 430,50');
    expect(seen[0]!.url).toBe('https://api.eu.mistral.ai/v1/ocr');
  });
  it('JSON invalide : une seconde tentative avec les erreurs, puis validation', async () => {
    const seen: { url: string; model: string; body: string }[] = [];
    const llm = createLlm({ apiKey: 'k', fetcher: fakeModel({ 'mistral-small-latest': ['pas du json', 'Voici : {"monthlyVolume": 40000, "avgTicket": 32, "transactions": null, "businessShare": null, "nonEeaShare": 0.25, "terminals": 2, "needs": ["keep_bank"], "missing": []}'] }, seen) });
    const r = await profileFromText(llm, 'Restaurant à Paris, 40 k€ par mois, beaucoup de touristes, 2 caisses, je veux garder ma banque', 'FR');
    expect(r.profile).toMatchObject({ monthlyVolume: 40000, nonEeaShare: 0.25, terminals: 2, needs: ['keep_bank'] });
    expect(seen[1]!.body).toContain('ne respecte pas le format');
  });
  it('extrait le JSON d’un bloc de code', () => expect(firstJson('```json\n{"a":[1,{"b":"}"}]}\n```')).toEqual({ a: [1, { b: '}' }] }));
});

describe('lecture de relevé', () => {
  it('masque IBAN, e-mails et numéros avant l’envoi au modèle ; ramène au mois ; compare', async () => {
    const seen: { url: string; model: string; body: string }[] = [];
    const answer = JSON.stringify({ provider: 'Banque Exemple', currency: 'EUR', periodDays: 30, cardVolume: 18430.5, transactions: 712, totalFees: 312.4, rate: 1.2, fixedPerTx: 0.05, monthlyFees: 28, businessShare: null, nonEeaShare: null, terminals: 1, confidence: 'high', notes: [] });
    const llm = createLlm({ provider: 'anthropic', apiKey: 'k', fetcher: fakeModel({ 'claude-sonnet-5-5': [answer] }, seen) });
    const text = 'Relevé novembre — IBAN FR76 3000 6000 0112 3456 7890 189 — contact@commerce.fr — carte 4970 1012 3456 7890\nTotal CB 18 430,50 € — 712 opérations — commissions 312,40 € HT';
    expect(redact(text)).not.toMatch(/FR76|contact@|4970/);
    const facts = await readStatement(llm, text);
    expect(seen[0]!.body).not.toMatch(/FR76 3000|contact@commerce|4970 1012/);
    const { profile, current } = fromStatement(facts, 'FR');
    const r = estimate(OFFERS, profile, current);
    expect(r.current).toBe(312.4);
    expect(r.estimates.find((e) => e.id === 'stripe-terminal')!.savings).toBeCloseTo(312.4 - r.estimates.find((e) => e.id === 'stripe-terminal')!.monthly!, 2);
  });
});

describe('assistant de support', () => {
  const view = { reference: 'T-1', state: 'authorized', detail: null, amount: 2450, currency: 'EUR', module: 'stripe-terminal', refunded: 0 };
  const journal = [
    { seq: 1, ts: '2026-11-28T10:00:00Z', type: 'created', data: {} },
    { seq: 2, ts: '2026-11-28T10:00:01Z', type: 'network_error', data: { where: 'process_payment_intent' } },
    { seq: 3, ts: '2026-11-28T10:00:03Z', type: 'final', data: { state: 'authorized', detail: null } },
  ];
  it('sans modèle : les faits du journal, en clair', async () => {
    const r = await explainPayment(undefined, view, journal);
    expect(r.method).toBe('facts');
    expect(r.explanation).toMatch(/un seul ordre de paiement/);
  });
  it('avec modèle : les faits seuls sont transmis, la réponse est rendue', async () => {
    const seen: { url: string; model: string; body: string }[] = [];
    const llm = createLlm({ apiKey: 'k', fetcher: fakeModel({ 'mistral-small-latest': ['Le réseau a coupé, le paiement est passé une seule fois.\nÀ faire : rien.'] }, seen) });
    const r = await explainPayment(llm, { ...view, state: 'declined', detail: 'terminal_busy' }, journal);
    expect(r.method).toBe('ai');
    expect(seen[0]!.body).toContain('Code terminal_busy');
  });
});

describe('brouillon de module PSP', () => {
  it('module invalide corrigé une fois, puis validé et forcé en aperçu', async () => {
    const good = JSON.parse(JSON.stringify((await import('@meridian/modules')).BUILTIN_MODULES['mollie-pos']));
    const llm = createLlm({ apiKey: 'k', fetcher: fakeModel({ 'mistral-medium-latest': ['{"id":"x"}', JSON.stringify({ ...good, maturity: 'available', $todo: ['Vérifier le code d’erreur des refus'] })] }) });
    const r = await draftModule(llm, { id: 'psp-exemple', name: 'PSP Exemple', doc: 'POST /payments …' });
    expect(r.module).toMatchObject({ id: 'psp-exemple', maturity: 'preview' });
    expect(r.todo).toEqual(['Vérifier le code d’erreur des refus']);
  });
});
