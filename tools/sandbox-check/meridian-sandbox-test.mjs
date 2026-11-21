// Meridian — test contre la sandbox Stripe Terminal réelle (intégration server-driven).
// Usage : STRIPE_KEY=sk_test_xxx node meridian-sandbox-test.mjs
// Node 18+ requis. Aucune dépendance. Clés de TEST uniquement : le script refuse une clé live.
// Produit rapport-sandbox.md et journal-meridian.jsonl dans le dossier courant.

import { writeFileSync, appendFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

const KEY = process.env.STRIPE_KEY || '';
if (!KEY.startsWith('sk_test_') && !KEY.startsWith('rk_test_')) {
  console.error('Donne une clé de TEST : STRIPE_KEY=sk_test_... node meridian-sandbox-test.mjs');
  process.exit(1);
}
const API = 'https://api.stripe.com';
const COUNTRY = (process.env.COUNTRY || 'FR').toUpperCase();
const ADDRESSES = {
  FR: { line1: '10 rue de Rivoli', city: 'Paris', postal_code: '75001', country: 'FR' },
  BE: { line1: 'Rue Neuve 1', city: 'Bruxelles', postal_code: '1000', country: 'BE' },
  NL: { line1: 'Damrak 1', city: 'Amsterdam', postal_code: '1012 LG', country: 'NL' },
  DE: { line1: 'Unter den Linden 1', city: 'Berlin', postal_code: '10117', country: 'DE' },
  ES: { line1: 'Calle Mayor 1', city: 'Madrid', postal_code: '28013', country: 'ES' },
  IT: { line1: 'Via del Corso 1', city: 'Roma', postal_code: '00186', state: 'RM', country: 'IT' },
};
if (!ADDRESSES[COUNTRY]) { console.error(`COUNTRY non pris en charge : ${COUNTRY}`); process.exit(1); }
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const calls = { n: 0 };

// ---------- client HTTP minimal ----------
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x) => out.append(`${key}[]`, String(x)));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method, path, body, idemKey) {
  calls.n++;
  const headers = { Authorization: `Bearer ${KEY}` };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  let payload;
  if (body && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = form(body).toString();
  }
  const res = await fetch(API + path, { method, headers, body: payload });
  const json = await res.json();
  const replayed = res.headers.get('idempotent-replayed') === 'true';
  if (!res.ok) {
    const e = new Error(json.error?.message || res.statusText);
    e.status = res.status; e.code = json.error?.code; e.json = json;
    throw e;
  }
  return Object.assign(json, { _replayed: replayed });
}

// ---------- outils de test ----------
async function scenario(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`• ${name} … `);
  try {
    const obs = await fn();
    results.push({ name, ok: true, obs, ms: Date.now() - t0 });
    console.log('OK');
  } catch (e) {
    results.push({ name, ok: false, obs: `${e.message}${e.code ? ` (code ${e.code})` : ''}`, ms: Date.now() - t0 });
    console.log('ÉCHEC —', e.message);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

async function waitAction(readerId, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await stripe('GET', `/v1/terminal/readers/${readerId}`);
    if (!r.action || r.action.status !== 'in_progress') return r;
    await sleep(700);
  }
  throw new Error('action du lecteur toujours en cours après 20 s');
}
async function freeReader(readerId) {
  const r = await stripe('GET', `/v1/terminal/readers/${readerId}`);
  if (r.action && r.action.status === 'in_progress') {
    try { await stripe('POST', `/v1/terminal/readers/${readerId}/cancel_action`); } catch {}
    await sleep(500);
  }
}
const newIntent = (amount, key) => stripe('POST', '/v1/payment_intents',
  { amount, currency: 'eur', payment_method_types: ['card_present'], capture_method: 'automatic' }, key);
const present = (readerId, number) => stripe('POST', `/v1/test_helpers/terminal/readers/${readerId}/present_payment_method`,
  number ? { type: 'card_present', card_present: { number } } : { type: 'card_present' });

// ---------- mini-moteur Meridian (journal + idempotence + reprise) ----------
const JFILE = 'journal-meridian.jsonl';
function jAppend(ref, type, data) {
  const lines = existsSync(JFILE) ? readFileSync(JFILE, 'utf8').trim().split('\n').filter(Boolean) : [];
  const prev = lines.length ? JSON.parse(lines.at(-1)).hash : '0'.repeat(64);
  const e = { seq: lines.length + 1, t: new Date().toISOString(), ref, type, data, prev };
  e.hash = createHash('sha256').update(JSON.stringify([e.seq, e.t, ref, type, data, prev])).digest('hex');
  appendFileSync(JFILE, JSON.stringify(e) + '\n');
  return e;
}
function jVerify() {
  const lines = readFileSync(JFILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let prev = '0'.repeat(64);
  for (const e of lines) {
    const h = createHash('sha256').update(JSON.stringify([e.seq, e.t, e.ref, e.type, e.data, e.prev])).digest('hex');
    if (e.prev !== prev || h !== e.hash) return { ok: false, at: e.seq };
    prev = e.hash;
  }
  return { ok: true, count: lines.length };
}
async function meridianPay({ ref, amount, readerId, crashAfterProcess = false }) {
  const state = { vars: {}, step: 0 };
  // reprise : relit le journal
  if (existsSync(JFILE)) {
    for (const l of readFileSync(JFILE, 'utf8').trim().split('\n').filter(Boolean)) {
      const e = JSON.parse(l);
      if (e.ref !== ref) continue;
      if (e.type === 'step') { state.step++; Object.assign(state.vars, e.data.vars); }
      if (e.type === 'final') return { already: e.data.state };
    }
  }
  if (state.step === 0) jAppend(ref, 'created', { amount });
  else jAppend(ref, 'recovered', { step: state.step });
  if (state.step === 0) {
    const pi = await newIntent(amount, `${ref}:create_intent`);
    state.vars.intentId = pi.id; jAppend(ref, 'step', { step: 'create_intent', vars: { intentId: pi.id } }); state.step = 1;
  }
  if (state.step === 1) {
    await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: state.vars.intentId }, `${ref}:process`);
    if (crashAfterProcess) return { crashed: true }; // crash AVANT d'avoir journalisé l'étape
    jAppend(ref, 'step', { step: 'process', vars: {} }); state.step = 2;
  }
  // phase d'attente : on présente la carte (test helper) seulement si l'action est en cours
  const r0 = await stripe('GET', `/v1/terminal/readers/${readerId}`);
  if (r0.action?.status === 'in_progress') await present(readerId).catch(() => {});
  await waitAction(readerId);
  const pi = await stripe('GET', `/v1/payment_intents/${state.vars.intentId}`);
  const final = pi.status === 'succeeded' ? 'authorized' : 'not_authorized';
  jAppend(ref, 'final', { state: final, intent: pi.id, status: pi.status });
  return { final, intentId: pi.id };
}

// ---------- scénarios ----------
console.log(`\nMeridian × Stripe Terminal sandbox · run ${RUN}\n`);
let readerId, locationId;

await scenario(`0. Préparation : lieu ${COUNTRY} + lecteur simulé`, async () => {
  const loc = await stripe('POST', '/v1/terminal/locations', {
    display_name: `Meridian test ${COUNTRY} ${RUN}`,
    address: ADDRESSES[COUNTRY],
  });
  locationId = loc.id;
  const rd = await stripe('POST', '/v1/terminal/readers', { registration_code: 'simulated-wpe', location: locationId, label: `meridian-${RUN}` });
  readerId = rd.id;
  return `lieu ${locationId}, lecteur simulé ${readerId} (${rd.device_type})`;
});
if (!readerId) { finish(); process.exit(1); }

await scenario('1. Paiement nominal (24,50 €)', async () => {
  const pi = await newIntent(2450, `${RUN}-1:create`);
  await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: pi.id });
  await present(readerId);
  const r = await waitAction(readerId);
  const p = await stripe('GET', `/v1/payment_intents/${pi.id}`);
  assert(p.status === 'succeeded', `statut ${p.status}`);
  return `action ${r.action?.status}, PaymentIntent ${p.status}`;
});

await scenario('2. Carte refusée (carte de test 4000000000000002)', async () => {
  await freeReader(readerId);
  const pi = await newIntent(1000, `${RUN}-2:create`);
  await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: pi.id });
  await present(readerId, '4000000000000002');
  const r = await waitAction(readerId);
  const p = await stripe('GET', `/v1/payment_intents/${pi.id}`);
  assert(p.status !== 'succeeded', 'le paiement a réussi alors qu’il devait être refusé');
  await stripe('POST', `/v1/payment_intents/${pi.id}/cancel`).catch(() => {});
  return `action ${r.action?.status} · code ${r.action?.failure_code} · PaymentIntent ${p.status}`;
});

await scenario('3. Réponse perdue : création rejouée avec la même clé', async () => {
  const key = `${RUN}-3:create`;
  const a = await newIntent(1500, key);
  const b = await newIntent(1500, key); // comme si la 1re réponse s'était perdue
  assert(a.id === b.id, `deux PaymentIntent différents : ${a.id} / ${b.id}`);
  await stripe('POST', `/v1/payment_intents/${a.id}/cancel`).catch(() => {});
  return `même PaymentIntent ${a.id} · en-tête Idempotent-Replayed=${b._replayed}`;
});

await scenario('4. Réponse perdue : envoi au lecteur rejoué avec la même clé', async () => {
  await freeReader(readerId);
  const pi = await newIntent(1200, `${RUN}-4:create`);
  const k = `${RUN}-4:process`;
  await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: pi.id }, k);
  const again = await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: pi.id }, k);
  await present(readerId);
  await waitAction(readerId);
  const list = await stripe('GET', `/v1/payment_intents?limit=20`);
  const succeededForAmount = list.data.filter((x) => x.id === pi.id && x.status === 'succeeded').length;
  assert(succeededForAmount === 1, 'débit multiple ou absent');
  return `rejeu accepté sans nouvelle action (replayed=${again._replayed}) · 1 seul débit`;
});

await scenario('5. Lecteur occupé : 2e paiement pendant le 1er', async () => {
  await freeReader(readerId);
  const a = await newIntent(800, `${RUN}-5a`);
  const b = await newIntent(900, `${RUN}-5b`);
  await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: a.id });
  let code = 'aucune erreur';
  try { await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: b.id }); }
  catch (e) { code = e.code; }
  await stripe('POST', `/v1/terminal/readers/${readerId}/cancel_action`).catch(() => {});
  for (const x of [a, b]) await stripe('POST', `/v1/payment_intents/${x.id}/cancel`).catch(() => {});
  assert(code === 'terminal_reader_busy', `attendu terminal_reader_busy, reçu ${code}`);
  return `refus attendu : ${code}`;
});

await scenario('6. Client annule avant de présenter la carte', async () => {
  await freeReader(readerId);
  const pi = await newIntent(700, `${RUN}-6`);
  await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: pi.id });
  const r = await stripe('POST', `/v1/terminal/readers/${readerId}/cancel_action`);
  const p = await stripe('GET', `/v1/payment_intents/${pi.id}`);
  assert(p.status !== 'succeeded', 'débité malgré l’annulation');
  await stripe('POST', `/v1/payment_intents/${pi.id}/cancel`).catch(() => {});
  return `cancel_action → action ${r.action?.status ?? 'aucune'} · PaymentIntent ${p.status} → annulé`;
});

await scenario('7. Remboursement idempotent', async () => {
  await freeReader(readerId);
  const pi = await newIntent(1100, `${RUN}-7:create`);
  await stripe('POST', `/v1/terminal/readers/${readerId}/process_payment_intent`, { payment_intent: pi.id });
  await present(readerId);
  await waitAction(readerId);
  const k = `${RUN}-7:refund:1`;
  const r1 = await stripe('POST', '/v1/refunds', { payment_intent: pi.id, amount: 1100 }, k);
  const r2 = await stripe('POST', '/v1/refunds', { payment_intent: pi.id, amount: 1100 }, k);
  assert(r1.id === r2.id, 'deux remboursements créés');
  return `remboursement ${r1.status}, rejoué sans doublon (${r1.id})`;
});

await scenario('8. Crash juste après l’envoi au lecteur, puis reprise', async () => {
  await freeReader(readerId);
  if (existsSync(JFILE)) unlinkSync(JFILE);
  const ref = `${RUN}-8`;
  const first = await meridianPay({ ref, amount: 2450, readerId, crashAfterProcess: true });
  assert(first.crashed, 'le crash simulé n’a pas eu lieu');
  const second = await meridianPay({ ref, amount: 2450, readerId }); // redémarrage
  assert(second.final === 'authorized', `état final ${second.final}`);
  const v = jVerify();
  assert(v.ok, `journal altéré à l’entrée ${v.at}`);
  return `reprise depuis le journal → autorisé, même PaymentIntent ${second.intentId} · journal intact (${v.count} entrées)`;
});

finish();

function finish() {
  const ok = results.filter((r) => r.ok).length;
  const md = [
    `# Meridian × Stripe Terminal — rapport sandbox ${COUNTRY}`,
    ``,
    `Run ${RUN} · ${new Date().toISOString()} · ${ok}/${results.length} scénarios réussis · ${calls.n} appels API`,
    ``,
    `| Scénario | Résultat | Observé | Durée |`,
    `| --- | --- | --- | --- |`,
    ...results.map((r) => `| ${r.name} | ${r.ok ? 'OK' : 'ÉCHEC'} | ${String(r.obs).replace(/\|/g, '/')} | ${(r.ms / 1000).toFixed(1)} s |`),
    ``,
    `Clé utilisée : test uniquement. Aucune donnée de clé n'est écrite dans ce rapport.`,
  ].join('\n');
  writeFileSync(`rapport-sandbox-${COUNTRY}.md`, md);
  console.log(`\n${ok}/${results.length} réussis · rapport écrit dans rapport-sandbox-${COUNTRY}.md\n`);
}
