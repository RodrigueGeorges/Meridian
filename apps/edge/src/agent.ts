// Agent Meridian du magasin.
// Il pilote le TPE du réseau local (Caisse-AP sur IP, ZVT ou nexo) et l'expose de deux façons, avec les mêmes 5 appels :
//   API locale  : la caisse installée appelle http://127.0.0.1:8787/v1/payments… — fonctionne même sans Internet ;
//   API cloud   : la caisse SaaS appelle l'API Meridian, qui relaie à l'agent par une connexion sortante (aucun port ouvert).
// Dans les deux cas : journal signé, idempotence par référence, jamais « échec » sans issue connue.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { COUNTRIES, MeridianError } from '@meridian/core';
import { Engine, Journal, JsonlStore, MemoryStore } from '@meridian/engine';
import { BUILTIN_MODULES } from '@meridian/modules';
import { CaisseApDriver, NexoDriver, TerminalService, ZvtDriver, type TerminalDriver } from '@meridian/terminals';

export const AGENT_VERSION = '0.1.0';

export interface AgentOptions {
  driver: TerminalDriver;
  /** Dossier de données (journal, état du terminal). Sans dossier : en mémoire (tests). */
  dataDir?: string;
  country?: string;
  /** API locale. Port 0 = libre (tests). Par défaut 127.0.0.1:8787. */
  local?: { port?: number; host?: string; token?: string } | false;
  /** Relais cloud : URL de l'API Meridian, clé de l'organisation et identifiant de l'agent. */
  cloud?: { url: string; apiKey: string; agentId: string };
  /** Tests : ignorer les N prochaines réponses vers le cloud (réponse perdue). */
  dropReplies?: number;
}

export function driverFromEnv(env: NodeJS.ProcessEnv = process.env): TerminalDriver {
  const kind = env.TERMINAL ?? 'caisse-ap';
  if (kind === 'zvt') return new ZvtDriver({ host: env.TERMINAL_HOST ?? '127.0.0.1', port: Number(env.TERMINAL_PORT ?? 20007) });
  if (kind === 'nexo') return new NexoDriver({ url: env.TERMINAL_URL ?? 'http://127.0.0.1:8080/', poiId: env.TERMINAL_POIID ?? 'POI1', saleId: env.MERIDIAN_AGENT_ID });
  return new CaisseApDriver({ host: env.TERMINAL_HOST ?? '127.0.0.1', port: Number(env.TERMINAL_PORT ?? 8888), caisse: env.TERMINAL_CAISSE ?? '01' });
}

export async function startAgent(o: AgentOptions) {
  if (o.dataDir) mkdirSync(o.dataDir, { recursive: true });
  const service = new TerminalService(o.driver, o.dataDir ? join(o.dataDir, 'terminal.json') : undefined);
  const country = (o.country ?? 'FR').toUpperCase();
  const profile = COUNTRIES[country];
  if (!profile) throw new Error(`Pays non pris en charge : ${country}`);

  // ---------- Moteur local : mêmes 5 appels que l'API cloud, journal signé sur disque ----------
  let key = 'meridian-edge-memory-key-0000000000';
  if (o.dataDir) {
    const kf = join(o.dataDir, 'journal.key');
    if (!existsSync(kf)) writeFileSync(kf, randomBytes(32).toString('hex'), { mode: 0o600 });
    key = readFileSync(kf, 'utf8').trim();
  }
  const binding = { moduleId: 'edge-terminal', config: { orgId: 'local', agentId: 'local' } };
  const localFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = '/' + u.pathname.split('/').filter(Boolean).slice(2).join('/');
    const r = await service.handle(init?.method ?? 'GET', path, typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const journal = new Journal(o.dataDir ? new JsonlStore(join(o.dataDir, 'journal.jsonl')) : new MemoryStore(), key);
  const engine = new Engine({
    journal,
    modules: { 'edge-terminal': BUILTIN_MODULES['edge-terminal']! },
    routing: async (posId) => ({ posId, country, currency: profile.currency, primary: binding }),
    fetcher: localFetch, pollMs: 150, retryMs: 300, payTimeoutMs: 240_000,
  });
  await engine.recover();
  engine.startScanner(3000);

  // ---------- API locale ----------
  let localServer: http.Server | undefined;
  let localUrl: string | undefined;
  let localToken: string | undefined;
  if (o.local !== false) {
    const lo = o.local ?? {};
    // Jeton obligatoire. Absent de la config : généré et persisté à côté de la clé du journal (mode 0600),
    // imprimé une seule fois — aux redémarrages suivants il est relu depuis le fichier, pas ré-imprimé.
    let token = lo.token;
    const tf = o.dataDir ? join(o.dataDir, 'local.token') : undefined;
    if (!token && tf && existsSync(tf)) token = readFileSync(tf, 'utf8').trim();
    if (!token) {
      token = `edge_${randomBytes(24).toString('hex')}`;
      if (tf) writeFileSync(tf, token, { mode: 0o600 });
      console.log(`[meridian-edge] jeton API locale : ${token}`);
    }
    localToken = token;
    localServer = http.createServer(async (req, res) => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
      try {
        if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: 'unauthorized', message: 'Jeton local invalide' } });
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 64 * 1024) return send(413, { error: { code: 'too_large', message: 'Requête trop grande' } }); }
        const body = raw ? JSON.parse(raw) : {};
        const url = new URL(req.url ?? '/', 'http://local');
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const posId = String(body.posId ?? url.searchParams.get('posId') ?? 'local');
        if (parts[0] === 'terminal') { const r = await service.handle(req.method ?? 'GET', url.pathname, body); return send(r.status, r.body); }
        if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, version: AGENT_VERSION, protocol: service.protocol, terminal: await o.driver.health(), cloud: cloudState() });
        if (parts[0] !== 'v1') return send(404, { error: { code: 'not_found', message: 'Ressource inconnue' } });
        if (req.method === 'POST' && url.pathname === '/v1/payments') {
          let v = await engine.pay({ posId, reference: String(body.reference ?? ''), amount: body.amount, currency: String(body.currency ?? '') });
          if (body.waitMs) v = await engine.waitForFinal(posId, v.reference, Math.min(Number(body.waitMs), 120_000));
          return send(201, v);
        }
        if (parts[1] === 'payments' && parts[2]) {
          const ref = parts[2];
          if (req.method === 'GET' && parts.length === 3) {
            const wait = Number(url.searchParams.get('waitMs') ?? 0);
            return send(200, wait ? await engine.waitForFinal(posId, ref, Math.min(wait, 60_000)) : await engine.statusFresh(posId, ref));
          }
          if (req.method === 'POST' && parts[3] === 'cancel') return send(200, await engine.cancel(posId, ref));
          if (req.method === 'POST' && parts[3] === 'refunds') return send(200, await engine.refund(posId, ref, body.amount, body.refundNumber));
          if (req.method === 'GET' && parts[3] === 'receipt') return send(200, await engine.receiptFresh(posId, ref));
          if (req.method === 'GET' && parts[3] === 'journal') return send(200, await journal.byReference(posId, ref));
        }
        if (req.method === 'GET' && url.pathname === '/v1/payments') return send(200, await engine.listFresh(posId));
        if (req.method === 'GET' && url.pathname === '/v1/journal/verify') return send(200, await engine.verify());
        return send(404, { error: { code: 'not_found', message: 'Ressource inconnue' } });
      } catch (e) {
        if (e instanceof MeridianError) return send(e.status, { error: { code: e.code, message: e.message } });
        return send(500, { error: { code: 'internal_error', message: (e as Error).message } });
      }
    });
    await new Promise<void>((r) => localServer!.listen(lo.port ?? 8787, lo.host ?? '127.0.0.1', r));
    localUrl = `http://${lo.host ?? '127.0.0.1'}:${(localServer.address() as AddressInfo).port}`;
  }

  // ---------- Relais cloud (connexion sortante, reconnexion automatique) ----------
  let ws: WebSocket | undefined;
  let stopped = false;
  let connected = false;
  let backoff = 1000;
  let drop = o.dropReplies ?? 0;
  const cloudState = () => (o.cloud ? (connected ? 'connected' : 'reconnecting') : 'disabled');
  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>((r) => { readyResolve = r; });
  const connect = () => {
    if (!o.cloud || stopped) return;
    const url = o.cloud.url.replace(/^http/, 'ws').replace(/\/$/, '') + '/v1/edge/connect';
    ws = new WebSocket(url, { headers: { authorization: `Bearer ${o.cloud.apiKey}`, 'x-meridian-agent': o.cloud.agentId } });
    ws.on('open', () => {
      connected = true; backoff = 1000;
      ws!.send(JSON.stringify({ type: 'hello', protocol: service.protocol, version: AGENT_VERSION }));
      readyResolve();
    });
    ws.on('message', async (raw) => {
      let f: { id?: string; method?: string; path?: string; body?: unknown };
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (!f.id || !f.method || !f.path) return;
      const r = await service.handle(f.method, f.path, f.body);
      if (drop > 0) { drop--; return; } // test : réponse perdue
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: f.id, status: r.status, body: r.body }));
    });
    ws.on('close', () => {
      connected = false;
      if (stopped) return;
      setTimeout(connect, backoff).unref();
      backoff = Math.min(backoff * 2, 30_000);
    });
    ws.on('error', () => undefined);
  };
  if (o.cloud) connect(); else readyResolve();

  return {
    service, engine, localUrl, localToken,
    /** Résolu à la première connexion au cloud (ou tout de suite sans cloud). */
    ready,
    get cloudConnected() { return connected; },
    async close() {
      stopped = true;
      engine.kill();
      ws?.close();
      await new Promise((r) => (localServer ? localServer.close(() => r(null)) : r(null)));
    },
    /** Tests : couper la liaison cloud sans arrêter l'agent. */
    disconnect() { ws?.terminate(); },
  };
}

export type Agent = Awaited<ReturnType<typeof startAgent>>;
