// Accès aux modèles de langage. Fournisseur par défaut : Mistral AI, sur son point d'accès européen
// (api.eu.mistral.ai : inférence traitée dans l'UE ; données d'API non utilisées pour l'entraînement).
// Un modèle par usage, choisi pour ce que l'usage demande :
//   statement  lecture d'un relevé de commissions : Mistral OCR (PDF, y compris scannés) puis Mistral Medium (extraction)
//   advisor    description d'activité en langage naturel → Mistral Small (simple, rapide, volume)
//   support    explication d'un paiement en clair        → Mistral Small (latence ; faits fournis par le journal)
//   modulegen  module PSP à partir de sa documentation   → Mistral Medium (code et raisonnement, faible volume)
// Anthropic (Claude) reste disponible : AI_PROVIDER=anthropic. Chaque modèle se remplace par AI_MODEL_<USAGE>.
// Le modèle ne décide de rien : sa sortie est validée par un schéma, et les calculs restent faits par le code.
import type { z } from 'zod';

export type Purpose = 'statement' | 'advisor' | 'support' | 'modulegen';
export type Provider = 'mistral' | 'anthropic';

export const PROVIDERS: Record<Provider, { baseUrl: string; models: Record<Purpose, string>; ocr?: string }> = {
  mistral: {
    baseUrl: 'https://api.eu.mistral.ai',
    models: { statement: 'mistral-medium-latest', advisor: 'mistral-small-latest', support: 'mistral-small-latest', modulegen: 'mistral-medium-latest' },
    ocr: 'mistral-ocr-latest',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    models: { statement: 'claude-sonnet-5-5', advisor: 'claude-haiku-5-5', support: 'claude-haiku-5-5', modulegen: 'claude-opus-5-5' },
  },
};
/** Modèles par défaut du fournisseur par défaut (Mistral). */
export const DEFAULT_MODELS = PROVIDERS.mistral.models;

const MAX_TOKENS: Record<Purpose, number> = { statement: 1500, advisor: 800, support: 700, modulegen: 8000 };
const TIMEOUT: Record<Purpose, number> = { statement: 60_000, advisor: 20_000, support: 20_000, modulegen: 180_000 };

export interface Usage { purpose: Purpose | 'ocr'; provider: Provider; model: string; inputTokens: number; outputTokens: number; pages?: number; ms: number }

export class AiUnavailable extends Error { readonly code = 'ai_unavailable'; }
export class AiFailed extends Error { readonly code = 'ai_failed'; }

export interface Llm {
  readonly enabled: boolean;
  readonly provider: Provider;
  readonly models: Record<Purpose, string>;
  /** Modèle d'OCR (lecture de PDF, y compris scannés), si le fournisseur en propose un. */
  readonly ocrModel?: string;
  text(purpose: Purpose, p: { system: string; user: string }): Promise<string>;
  /** Réponse JSON validée par le schéma ; une seconde tentative reçoit les erreurs de validation. */
  json<T>(purpose: Purpose, p: { system: string; user: string; schema: z.ZodType<T> }): Promise<T>;
  /** Texte d'un document (PDF ou image) par OCR ; absent si le fournisseur n'en a pas. */
  ocr?(doc: { type: string; data: Uint8Array }): Promise<string>;
}

export interface LlmOptions {
  provider?: Provider;
  apiKey?: string;
  models?: Partial<Record<Purpose, string>>;
  ocrModel?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  onUsage?: (u: Usage) => void;
}

/**
 * Variables d'environnement : AI_PROVIDER (mistral par défaut, ou anthropic), MISTRAL_API_KEY / ANTHROPIC_API_KEY,
 * AI_MODEL_STATEMENT, AI_MODEL_ADVISOR, AI_MODEL_SUPPORT, AI_MODEL_MODULEGEN, AI_MODEL_OCR, AI_BASE_URL.
 */
export function llmFromEnv(env: Record<string, string | undefined>, extra: Omit<LlmOptions, 'provider' | 'apiKey' | 'models' | 'baseUrl' | 'ocrModel'> = {}): Llm {
  const provider: Provider = env.AI_PROVIDER === 'anthropic' || (!env.AI_PROVIDER && !env.MISTRAL_API_KEY && env.ANTHROPIC_API_KEY) ? 'anthropic' : 'mistral';
  const models: Partial<Record<Purpose, string>> = {};
  for (const p of Object.keys(DEFAULT_MODELS) as Purpose[]) { const v = env[`AI_MODEL_${p.toUpperCase()}`]; if (v) models[p] = v; }
  return createLlm({
    provider, apiKey: provider === 'mistral' ? env.MISTRAL_API_KEY : env.ANTHROPIC_API_KEY,
    models, ocrModel: env.AI_MODEL_OCR, baseUrl: env.AI_BASE_URL, ...extra,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Premier objet ou tableau JSON d'une réponse (tolère un bloc ```json). */
export function firstJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = (fenced ? fenced[1]! : text).trim();
  const start = s.search(/[[{]/);
  if (start < 0) throw new AiFailed('Réponse sans JSON');
  const open = s[start]!, close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new AiFailed('JSON incomplet');
}

type Msg = { role: 'user' | 'assistant'; content: string };

export function createLlm(o: LlmOptions): Llm {
  const provider = o.provider ?? 'mistral';
  const def = PROVIDERS[provider];
  const models = { ...def.models, ...o.models };
  const ocrModel = o.ocrModel ?? def.ocr;
  const f = o.fetcher ?? fetch;
  const base = (o.baseUrl ?? def.baseUrl).replace(/\/$/, '');

  /** Requête HTTP avec délai, et nouvelles tentatives sur surcharge (429, 5xx) ou coupure réseau. */
  async function post(path: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!o.apiKey) throw new AiUnavailable(`Aucune clé de modèle configurée (${provider === 'mistral' ? 'MISTRAL_API_KEY' : 'ANTHROPIC_API_KEY'})`);
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let r: Response;
      try {
        r = await f(`${base}${path}`, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      } catch (e) {
        clearTimeout(timer);
        if (attempt < 1) { await sleep(800); continue; }
        throw new AiFailed(`Modèle injoignable : ${(e as Error).message}`);
      }
      clearTimeout(timer);
      if ((r.status === 429 || r.status === 529 || r.status >= 500) && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
      const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        const err = json.error as { message?: string } | string | undefined;
        throw new AiFailed(`Modèle : ${r.status} ${typeof err === 'string' ? err : err?.message ?? (json.message as string | undefined) ?? ''}`.trim());
      }
      return json;
    }
  }

  async function call(purpose: Purpose, system: string, messages: Msg[], json: boolean): Promise<string> {
    const t0 = Date.now();
    const model = models[purpose];
    if (provider === 'mistral') {
      const r = await post('/v1/chat/completions', { authorization: `Bearer ${o.apiKey}` }, {
        model, max_tokens: MAX_TOKENS[purpose], temperature: 0.1,
        messages: [{ role: 'system', content: system }, ...messages],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }, TIMEOUT[purpose]);
      const usage = r.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      o.onUsage?.({ purpose, provider, model, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0, ms: Date.now() - t0 });
      const content = (r.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content;
      return typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('') : '';
    }
    const r = await post('/v1/messages', { 'x-api-key': o.apiKey!, 'anthropic-version': '2023-06-01' }, { model, max_tokens: MAX_TOKENS[purpose], system, messages }, TIMEOUT[purpose]);
    const usage = r.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    o.onUsage?.({ purpose, provider, model, inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, ms: Date.now() - t0 });
    return ((r.content as { type: string; text?: string }[] | undefined) ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }

  const llm: Llm = {
    enabled: !!o.apiKey,
    provider,
    models,
    ocrModel: provider === 'mistral' ? ocrModel : undefined,
    text: (purpose, p) => call(purpose, p.system, [{ role: 'user', content: p.user }], false),
    async json(purpose, p) {
      const system = `${p.system}\n\nRéponds uniquement par un objet JSON valide, sans texte autour.`;
      const messages: Msg[] = [{ role: 'user', content: p.user }];
      let lastErr = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await call(purpose, system, messages, true);
        try {
          const parsed = p.schema.safeParse(firstJson(out));
          if (parsed.success) return parsed.data;
          lastErr = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join('\n');
        } catch (e) { lastErr = (e as Error).message; }
        messages.push({ role: 'assistant', content: out }, { role: 'user', content: `Ta réponse ne respecte pas le format attendu :\n${lastErr}\nRenvoie l'objet JSON corrigé, complet.` });
      }
      throw new AiFailed(`Réponse du modèle invalide : ${lastErr}`);
    },
  };
  if (provider === 'mistral' && ocrModel) {
    llm.ocr = async (doc) => {
      const t0 = Date.now();
      const b64 = Buffer.from(doc.data).toString('base64');
      const isImage = doc.type.startsWith('image/');
      const r = await post('/v1/ocr', { authorization: `Bearer ${o.apiKey}` }, {
        model: ocrModel,
        document: isImage ? { type: 'image_url', image_url: `data:${doc.type};base64,${b64}` } : { type: 'document_url', document_url: `data:application/pdf;base64,${b64}` },
      }, TIMEOUT.statement);
      const pages = (r.pages as { markdown?: string }[] | undefined) ?? [];
      o.onUsage?.({ purpose: 'ocr', provider, model: ocrModel, inputTokens: 0, outputTokens: 0, pages: pages.length, ms: Date.now() - t0 });
      return pages.map((pg) => pg.markdown ?? '').join('\n\n');
    };
  }
  return llm;
}
