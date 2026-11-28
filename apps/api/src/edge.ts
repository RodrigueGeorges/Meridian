// Relais cloud vers les agents Meridian des magasins.
// L'agent ouvre une connexion WebSocket sortante (aucun port à ouvrir au magasin), authentifiée par la clé de
// l'organisation. Le moteur appelle le terminal comme un PSP, par des URL edge://relay/<org>/<agent>/terminal/… :
//   agent absent        → connexion refusée : rien n'est parti, bascule possible vers le PSP de secours ;
//   réponse perdue      → délai dépassé : issue inconnue, rejeu sûr (l'agent déduplique par Idempotency-Key).
import { randomUUID } from 'node:crypto';
import type { WebSocket } from '@fastify/websocket';

interface Pending { resolve: (r: Response) => void; reject: (e: unknown) => void }
export interface EdgeAgentInfo { agentId: string; protocol?: string; version?: string; connectedAt: string; lastSeen: string }

/** Bus inter-instances (PostgreSQL LISTEN/NOTIFY) : un agent connecté à l'instance A peut être
 *  piloté par la requête reçue sur l'instance B. Payload < ~8 Ko (limite pg_notify). */
export interface EdgeBus {
  instanceId: string;
  publish(channel: 'edge_cmd' | 'edge_resp', payload: string): Promise<void>;
}

const netErr = (code: string, msg: string) => Object.assign(new TypeError(msg), { cause: { code } });

interface EdgeFrame { id: string; method: string; path: string; idempotencyKey?: string; body?: unknown }

export class EdgeRelay {
  private conns = new Map<string, { ws: WebSocket; info: EdgeAgentInfo; pending: Map<string, Pending> }>();
  private remotePending = new Map<string, Pending>();
  private bus?: EdgeBus;

  /** Active le relais multi-instance ; appelé une fois le canal LISTEN prêt. */
  setBus(bus: EdgeBus) {
    this.bus = bus;
  }

  /** Message LISTEN/NOTIFY reçu : `edge_cmd` à exécuter ici si l'agent est local, `edge_resp` à résoudre. */
  handleNotify(channel: string, raw: string | undefined) {
    if (!raw || !this.bus) return;
    let m: { id?: string; from?: string; to?: string; org?: string; agent?: string; frame?: EdgeFrame; status?: number; body?: unknown };
    try { m = JSON.parse(raw); } catch { return; }
    if (channel === 'edge_cmd' && m.from !== this.bus.instanceId && m.org && m.agent && m.frame) {
      this.sendToAgent(m.org, m.agent, m.frame)
        .then(async (r) => {
          let payload = JSON.stringify({ id: m.id, to: m.from, status: r.status, body: await r.json().catch(() => ({})) });
          if (payload.length > 7000) payload = JSON.stringify({ id: m.id, to: m.from, status: 502, body: { error: 'réponse agent trop grande pour le bus' } });
          return this.bus!.publish('edge_resp', payload);
        })
        .catch((e) => this.bus!.publish('edge_resp', JSON.stringify({ id: m.id, to: m.from, status: 502, body: { error: String((e as Error).message) } })))
        .catch(() => undefined);
      return;
    }
    if (channel === 'edge_resp' && m.to === this.bus.instanceId && m.id) {
      const p = this.remotePending.get(m.id);
      if (!p) return;
      this.remotePending.delete(m.id);
      p.resolve(new Response(JSON.stringify(m.body ?? {}), { status: m.status ?? 502, headers: { 'content-type': 'application/json' } }));
    }
  }

  /** Aller-retour requête/réponse vers l'agent s'il est connecté à CETTE instance. */
  private sendToAgent(orgId: string, agentId: string, frame: EdgeFrame, signal?: AbortSignal): Promise<Response> {
    const conn = this.conns.get(`${orgId}/${agentId}`);
    if (!conn) return Promise.reject(netErr('ECONNREFUSED', `Agent ${agentId} non connecté`));
    return new Promise<Response>((resolve, reject) => {
      const settle = { resolve: (r: Response) => { clearTimeout(cap); resolve(r); }, reject: (e: unknown) => { clearTimeout(cap); reject(e); } };
      // Garde-fou : un agent qui ne répond jamais ne doit pas laisser la requête pendre à vie
      // (cas des exécutions relayées par le bus, sans signal côté demandeur).
      const cap = setTimeout(() => { if (conn.pending.delete(frame.id)) reject(netErr('ECONNRESET', 'délai agent dépassé')); }, 60_000);
      cap.unref();
      conn.pending.set(frame.id, settle);
      signal?.addEventListener('abort', () => {
        if (conn.pending.delete(frame.id)) { clearTimeout(cap); reject(Object.assign(new Error('Délai dépassé avec l\'agent'), { name: 'AbortError' })); }
      });
      try { conn.ws.send(JSON.stringify(frame)); } catch (e) { conn.pending.delete(frame.id); clearTimeout(cap); reject(netErr('ECONNRESET', (e as Error).message)); }
    });
  }

  attach(orgId: string, agentId: string, ws: WebSocket, hello: { protocol?: string; version?: string } = {}) {
    const k = `${orgId}/${agentId}`;
    const prev = this.conns.get(k);
    if (prev) prev.ws.close(4409, 'remplacé par une nouvelle connexion');
    const now = new Date().toISOString();
    const conn = { ws, info: { agentId, protocol: hello.protocol, version: hello.version, connectedAt: now, lastSeen: now }, pending: new Map<string, Pending>() };
    this.conns.set(k, conn);
    ws.on('message', (raw: unknown) => {
      conn.info.lastSeen = new Date().toISOString();
      let m: { id?: string; status?: number; body?: unknown; type?: string; protocol?: string; version?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'hello') { conn.info.protocol = m.protocol; conn.info.version = m.version; return; }
      const p = m.id ? conn.pending.get(m.id) : undefined;
      if (!p) return;
      conn.pending.delete(m.id!);
      p.resolve(new Response(JSON.stringify(m.body ?? {}), { status: m.status ?? 502, headers: { 'content-type': 'application/json' } }));
    });
    ws.on('close', () => {
      if (this.conns.get(k)?.ws === ws) this.conns.delete(k);
      for (const p of conn.pending.values()) p.reject(netErr('ECONNRESET', 'Agent déconnecté pendant la requête'));
      conn.pending.clear();
    });
    const ping = setInterval(() => { try { ws.ping(); } catch { /* fermé */ } }, 20_000);
    ping.unref();
    ws.on('close', () => clearInterval(ping));
  }

  agents(orgId: string): EdgeAgentInfo[] {
    return [...this.conns.entries()].filter(([k]) => k.startsWith(`${orgId}/`)).map(([, c]) => c.info);
  }

  /** Nombre total d'agents connectés au relais de cette instance (toutes organisations). */
  count(): number {
    return this.conns.size;
  }

  /** Arrêt : termine les connexions agents (sinon app.close() attend leurs sockets indéfiniment). */
  close() {
    for (const p of this.remotePending.values()) p.reject(netErr('ECONNRESET', 'arrêt du serveur'));
    this.remotePending.clear();
    for (const c of this.conns.values()) {
      for (const p of c.pending.values()) p.reject(netErr('ECONNRESET', 'arrêt du serveur'));
      try { c.ws.terminate(); } catch { /* déjà fermé */ }
    }
    this.conns.clear();
  }

  /** Enveloppe un fetch : les URL edge:// passent par l'agent — local à cette instance, ou via le
   *  bus NOTIFY si l'agent est rattaché à une autre instance ; les autres URL partent sur Internet. */
  fetcher(base: typeof fetch = fetch): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('edge://')) return base(input, init);
      const u = new URL(url);
      const [orgId, agentId, ...rest] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (!orgId || !agentId) throw netErr('ECONNREFUSED', 'URL edge:// mal formée');
      const id = randomUUID();
      const headers = new Headers(init?.headers);
      const frame = {
        id, method: init?.method ?? 'GET', path: `/${rest.map(encodeURIComponent).join('/')}${u.search}`,
        idempotencyKey: headers.get('idempotency-key') ?? undefined,
        body: typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined,
      };
      if (this.conns.has(`${orgId}/${agentId}`)) return this.sendToAgent(orgId, agentId, frame, init?.signal ?? undefined);
      if (!this.bus) throw netErr('ECONNREFUSED', `Agent ${agentId} non connecté`);
      const payload = JSON.stringify({ id, from: this.bus.instanceId, org: orgId, agent: agentId, frame });
      if (payload.length > 7000) throw netErr('ECONNREFUSED', `Agent ${agentId} non connecté localement, requête trop grande pour le bus`);
      return new Promise<Response>((resolve, reject) => {
        this.remotePending.set(id, { resolve, reject });
        const giveUp = (e: Error) => { if (this.remotePending.delete(id)) reject(e); };
        init?.signal?.addEventListener('abort', () => giveUp(Object.assign(new Error('Délai dépassé avec l\'agent'), { name: 'AbortError' })));
        setTimeout(() => giveUp(netErr('ECONNREFUSED', `Agent ${agentId} injoignable via le bus`)), 35_000).unref();
        this.bus!.publish('edge_cmd', payload).catch((e) => giveUp(netErr('ECONNRESET', (e as Error).message)));
      });
    }) as typeof fetch;
  }
}
