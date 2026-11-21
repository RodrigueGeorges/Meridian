// Simulateurs de PSP fidèles aux API publiques (routes, statuts, codes d'erreur, idempotence),
// avec injection de pannes pilotable : réponse perdue, réseau coupé, connexion refusée, carte refusée.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

export interface Faults {
  /** Nombre de réponses à perdre par motif de route (la requête EST traitée, la réponse ne revient pas). */
  dropResponse: Record<string, number>;
  /** Jusqu'à cette date (ms), les requêtes n'arrivent pas (socket coupée avant traitement). */
  netDownUntil: number;
  declineNext: boolean;
  latencyMs: number;
  /** Présentation automatique de la carte après ce délai ; null = attendre le test helper. */
  autoPresentMs: number | null;
  authMs: number;
}
const defaultFaults = (): Faults => ({ dropResponse: {}, netDownUntil: 0, declineNext: false, latencyMs: 0, autoPresentMs: 150, authMs: 250 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;

function formParser(app: FastifyInstance) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(body as string)) {
      const cur = out[k];
      if (cur === undefined) out[k] = v;
      else out[k] = Array.isArray(cur) ? [...cur, v] : [cur, v];
    }
    done(null, out);
  });
}

/** Pannes réseau communes : coupure avant traitement, perte de réponse après traitement. */
function wireFaults(app: FastifyInstance, faults: Faults) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/__')) return;
    if (faults.latencyMs) await sleep(faults.latencyMs);
    if (Date.now() < faults.netDownUntil) {
      reply.raw.destroy();
      return reply;
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/__')) return payload;
    for (const [pattern, n] of Object.entries(faults.dropResponse)) {
      if (n > 0 && req.url.includes(pattern)) {
        faults.dropResponse[pattern] = n - 1;
        reply.raw.destroy();
        return payload;
      }
    }
    if (Date.now() < faults.netDownUntil) reply.raw.destroy();
    return payload;
  });
  app.post('/__faults', async (req) => {
    Object.assign(faults, req.body as Partial<Faults>);
    return faults;
  });
}

const stripeErr = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { type: status === 401 ? 'invalid_request_error' : 'invalid_request_error', code, message } });

// ======================= Stripe Terminal (server-driven) =======================
interface Intent { id: string; object: 'payment_intent'; amount: number; currency: string; status: string; metadata: Record<string, string>; latest_charge: unknown; amount_refunded: number }
interface Reader { id: string; object: 'terminal.reader'; label: string; device_type: string; location: string | null; action: null | { type: string; status: 'in_progress' | 'succeeded' | 'failed'; failure_code?: string; process_payment_intent: { payment_intent: string }; phase?: 'waiting_for_card' | 'authorizing' } }

export function createStripeSim(faults: Faults = defaultFaults()) {
  const app = Fastify({ logger: false });
  formParser(app);
  const state = { intents: new Map<string, Intent>(), readers: new Map<string, Reader>(), idem: new Map<string, { params: string; status: number; body: unknown }>(), debits: 0, refunds: new Map<string, { id: string; amount: number; payment_intent: string }>() };
  const addReader = (rid: string, label = 'sim') => state.readers.set(rid, { id: rid, object: 'terminal.reader', label, device_type: 'simulated_wisepos_e', location: null, action: null });
  for (const c of ['FR', 'BE', 'NL', 'DE', 'ES', 'IT']) addReader(`tmr_sim_${c}`, `Lecteur simulé ${c}`);

  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/__')) return;
    const auth = req.headers.authorization ?? '';
    if (!/^Bearer (sk|rk)_test_/.test(auth)) return stripeErr(reply, 401, 'api_key_invalid', 'Invalid API Key provided');
    // Idempotence Stripe : même clé + mêmes paramètres = réponse d'origine rejouée.
    const key = req.headers['idempotency-key'];
    if (req.method === 'POST' && typeof key === 'string') {
      const params = JSON.stringify([req.url, req.body]);
      const hit = state.idem.get(key);
      if (hit) {
        if (hit.params !== params) return stripeErr(reply, 400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters');
        reply.header('idempotent-replayed', 'true');
        return reply.code(hit.status).send(hit.body);
      }
      (req as FastifyRequest & { idemKey?: string; idemParams?: string }).idemKey = key;
      (req as FastifyRequest & { idemParams?: string }).idemParams = params;
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const r = req as FastifyRequest & { idemKey?: string; idemParams?: string };
    if (r.idemKey && reply.statusCode < 500 && !state.idem.has(r.idemKey)) {
      state.idem.set(r.idemKey, { params: r.idemParams!, status: reply.statusCode, body: JSON.parse(String(payload)) });
    }
    return payload;
  });
  wireFaults(app, faults);

  const authorize = (reader: Reader, decline: boolean) => {
    const act = reader.action;
    if (!act || act.status !== 'in_progress') return;
    act.phase = 'authorizing';
    setTimeout(() => {
      if (act.status !== 'in_progress') return;
      const pi = state.intents.get(act.process_payment_intent.payment_intent)!;
      if (decline) {
        act.status = 'failed';
        act.failure_code = 'card_declined';
      } else {
        act.status = 'succeeded';
        pi.status = 'succeeded';
        pi.latest_charge = { id: id('ch'), payment_method_details: { card_present: { brand: 'visa', last4: '4242' } } };
        state.debits++;
      }
    }, faults.authMs);
  };

  app.post('/v1/payment_intents', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount <= 0) return stripeErr(reply, 400, 'parameter_invalid_integer', 'Invalid amount');
    const pi: Intent = { id: id('pi'), object: 'payment_intent', amount, currency: b.currency ?? 'eur', status: 'requires_payment_method', metadata: { meridian_ref: b['metadata[meridian_ref]'] ?? '' }, latest_charge: null, amount_refunded: 0 };
    state.intents.set(pi.id, pi);
    return pi;
  });
  app.get('/v1/payment_intents/:id', async (req, reply) => {
    const pi = state.intents.get((req.params as { id: string }).id);
    return pi ?? stripeErr(reply, 404, 'resource_missing', 'No such payment_intent');
  });
  app.post('/v1/payment_intents/:id/cancel', async (req, reply) => {
    const pi = state.intents.get((req.params as { id: string }).id);
    if (!pi) return stripeErr(reply, 404, 'resource_missing', 'No such payment_intent');
    if (pi.status === 'succeeded') return stripeErr(reply, 400, 'payment_intent_unexpected_state', 'Cannot cancel a succeeded PaymentIntent');
    pi.status = 'canceled';
    return pi;
  });
  app.post('/v1/terminal/readers', async (req) => {
    const b = req.body as Record<string, string>;
    const rid = id('tmr');
    addReader(rid, b.label);
    return state.readers.get(rid);
  });
  app.get('/v1/terminal/readers/:id', async (req, reply) => {
    const r = state.readers.get((req.params as { id: string }).id);
    if (!r) return stripeErr(reply, 404, 'resource_missing', 'No such reader');
    const { action } = r;
    return { ...r, action: action && { type: action.type, status: action.status, failure_code: action.failure_code, process_payment_intent: action.process_payment_intent } };
  });
  app.post('/v1/terminal/readers/:id/process_payment_intent', async (req, reply) => {
    const r = state.readers.get((req.params as { id: string }).id);
    if (!r) return stripeErr(reply, 404, 'resource_missing', 'No such reader');
    if (r.action?.status === 'in_progress') return stripeErr(reply, 409, 'terminal_reader_busy', 'Reader is currently busy processing another request');
    const piId = (req.body as Record<string, string>).payment_intent ?? '';
    const pi = state.intents.get(piId);
    if (!pi) return stripeErr(reply, 404, 'resource_missing', 'No such payment_intent');
    if (pi.status !== 'requires_payment_method') return stripeErr(reply, 400, 'payment_intent_unexpected_state', `PaymentIntent status is ${pi.status}`);
    r.action = { type: 'process_payment_intent', status: 'in_progress', process_payment_intent: { payment_intent: pi.id }, phase: 'waiting_for_card' };
    if (faults.autoPresentMs !== null) {
      const decline = faults.declineNext;
      faults.declineNext = false;
      const act = r.action;
      setTimeout(() => r.action === act && authorize(r, decline), faults.autoPresentMs);
    }
    return { ...r, action: { type: r.action.type, status: r.action.status, process_payment_intent: r.action.process_payment_intent } };
  });
  app.post('/v1/terminal/readers/:id/cancel_action', async (req, reply) => {
    const r = state.readers.get((req.params as { id: string }).id);
    if (!r) return stripeErr(reply, 404, 'resource_missing', 'No such reader');
    if (r.action?.status === 'in_progress' && r.action.phase === 'authorizing') {
      return stripeErr(reply, 409, 'terminal_reader_busy', 'Reader is processing a payment and cannot be canceled');
    }
    if (r.action?.status === 'in_progress') {
      r.action.status = 'failed';
      r.action.failure_code = 'customer_canceled';
    }
    return { ...r, action: r.action && { type: r.action.type, status: r.action.status, failure_code: r.action.failure_code } };
  });
  app.post('/v1/test_helpers/terminal/readers/:id/present_payment_method', async (req, reply) => {
    const r = state.readers.get((req.params as { id: string }).id);
    if (!r?.action || r.action.status !== 'in_progress') return stripeErr(reply, 400, 'terminal_reader_invalid_state', 'No action in progress');
    const num = ((req.body ?? {}) as Record<string, string>)['card_present[number]'];
    authorize(r, num === '4000000000000002' || faults.declineNext);
    faults.declineNext = false;
    return { ...r, action: { type: r.action.type, status: r.action.status } };
  });
  app.post('/v1/refunds', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const pi = state.intents.get(b.payment_intent ?? '');
    if (!pi || pi.status !== 'succeeded') return stripeErr(reply, 400, 'charge_not_refundable', 'This PaymentIntent cannot be refunded');
    const amount = Number(b.amount ?? pi.amount);
    if (pi.amount_refunded + amount > pi.amount) return stripeErr(reply, 400, 'amount_too_large', 'Refund amount exceeds charge');
    pi.amount_refunded += amount;
    const ref = { id: id('re'), object: 'refund', amount, payment_intent: pi.id, status: 'succeeded' };
    state.refunds.set(ref.id, ref);
    return ref;
  });
  app.get('/__state', async () => ({
    debits: state.debits,
    intents: [...state.intents.values()],
    refunds: [...state.refunds.values()],
  }));
  return { app, state, faults };
}

// ======================= PSP de secours (API générique) =======================
export function createSecoursSim(faults: Faults = defaultFaults()) {
  const app = Fastify({ logger: false });
  const state = { checkouts: new Map<string, { id: string; amount: number; currency: string; reference: string; status: string; reason?: string; card?: { brand: string; last4: string }; processing: boolean; refunded: number }>(), idem: new Map<string, unknown>(), debits: 0 };
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/__') || req.url === '/health') return;
    if (!(req.headers.authorization ?? '').startsWith('Bearer ')) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing key' } });
    const key = req.headers['x-idempotency-key'];
    if (req.method === 'POST' && typeof key === 'string' && state.idem.has(key)) return reply.send(state.idem.get(key));
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const key = req.headers['x-idempotency-key'];
    if (req.method === 'POST' && typeof key === 'string' && reply.statusCode < 300 && !state.idem.has(key)) state.idem.set(key, JSON.parse(String(payload)));
    return payload;
  });
  wireFaults(app, faults);
  app.get('/health', async () => ({ ok: true }));
  app.post('/checkouts', async (req, reply) => {
    const b = req.body as { amount: number; currency: string; reference: string };
    if (!Number.isInteger(b.amount) || b.amount <= 0) return reply.code(400).send({ error: { code: 'invalid_amount', message: 'amount' } });
    const c = { id: id('chk'), amount: b.amount, currency: b.currency, reference: b.reference, status: 'PENDING', processing: false, refunded: 0 } as { id: string; amount: number; currency: string; reference: string; status: string; reason?: string; card?: { brand: string; last4: string }; processing: boolean; refunded: number };
    state.checkouts.set(c.id, c);
    const decline = faults.declineNext;
    faults.declineNext = false;
    setTimeout(() => {
      if (c.status !== 'PENDING') return;
      c.processing = true;
      setTimeout(() => {
        if (c.status !== 'PENDING') return;
        if (decline) Object.assign(c, { status: 'FAILED', reason: 'card_declined' });
        else {
          Object.assign(c, { status: 'SUCCESSFUL', card: { brand: 'visa', last4: '1881' } });
          state.debits++;
        }
      }, faults.authMs);
    }, faults.autoPresentMs ?? 150);
    return reply.code(201).send(c);
  });
  app.get('/checkouts/:id', async (req, reply) => state.checkouts.get((req.params as { id: string }).id) ?? reply.code(404).send({ error: { code: 'not_found', message: 'checkout' } }));
  app.delete('/checkouts/:id', async (req, reply) => {
    const c = state.checkouts.get((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: { code: 'not_found', message: 'checkout' } });
    if (c.status === 'PENDING' && c.processing) return reply.code(409).send({ error: { code: 'checkout_processing', message: 'Authorization in progress' } });
    if (c.status === 'PENDING') c.status = 'CANCELLED';
    return c;
  });
  app.post('/refunds', async (req, reply) => {
    const b = req.body as { checkout: string; amount: number };
    const c = state.checkouts.get(b.checkout);
    if (!c || c.status !== 'SUCCESSFUL' || c.refunded + b.amount > c.amount) return reply.code(400).send({ error: { code: 'not_refundable', message: 'refund' } });
    c.refunded += b.amount;
    return { id: id('rf'), amount: b.amount, status: 'DONE' };
  });
  app.get('/__state', async () => ({ debits: state.debits, checkouts: [...state.checkouts.values()] }));
  return { app, state, faults };
}

/** Lance les deux simulateurs. Ports 0 = ports libres (tests). */
export async function startSims(opts: { stripePort?: number; secoursPort?: number; host?: string } = {}) {
  const host = opts.host ?? '127.0.0.1';
  const stripe = createStripeSim();
  const secours = createSecoursSim();
  await stripe.app.listen({ port: opts.stripePort ?? 0, host });
  await secours.app.listen({ port: opts.secoursPort ?? 0, host });
  const portOf = (a: FastifyInstance) => (a.server.address() as { port: number }).port;
  const stripePort = portOf(stripe.app);
  const stripeApp = stripe.app;
  return {
    stripe, secours,
    get stripeUrl() { return `http://${host}:${stripePort}`; },
    secoursUrl: `http://${host}:${portOf(secours.app)}`,
    /** Arrête Stripe : les connexions sont refusées (ECONNREFUSED), comme un PSP injoignable. */
    async stopStripe() { await stripeApp.close(); },
    async close() {
      await Promise.allSettled([stripeApp.close(), secours.app.close()]);
    },
    debits: () => stripe.state.debits + secours.state.debits,
    
  };
}
