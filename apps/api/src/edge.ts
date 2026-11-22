// Relais cloud vers les agents Meridian des magasins.
// L'agent ouvre une connexion WebSocket sortante (aucun port à ouvrir au magasin), authentifiée par la clé de
// l'organisation. Le moteur appelle le terminal comme un PSP, par des URL edge://relay/<org>/<agent>/terminal/… :
//   agent absent        → connexion refusée : rien n'est parti, bascule possible vers le PSP de secours ;
//   réponse perdue      → délai dépassé : issue inconnue, rejeu sûr (l'agent déduplique par Idempotency-Key).
import { randomUUID } from 'node:crypto';
import type { WebSocket } from '@fastify/websocket';

interface Pending { resolve: (r: Response) => void; reject: (e: unknown) => void }
export interface EdgeAgentInfo { agentId: string; protocol?: string; version?: string; connectedAt: string; lastSeen: string }

const netErr = (code: string, msg: string) => Object.assign(new TypeError(msg), { cause: { code } });

export class EdgeRelay {
  private conns = new Map<string, { ws: WebSocket; info: EdgeAgentInfo; pending: Map<string, Pending> }>();

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

  /** Enveloppe un fetch : les URL edge:// passent par l'agent, les autres partent sur Internet. */
  fetcher(base: typeof fetch = fetch): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('edge://')) return base(input, init);
      const u = new URL(url);
      const [orgId, agentId, ...rest] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const conn = orgId && agentId ? this.conns.get(`${orgId}/${agentId}`) : undefined;
      if (!conn) throw netErr('ECONNREFUSED', `Agent ${agentId ?? '?'} non connecté`);
      const id = randomUUID();
      const headers = new Headers(init?.headers);
      const frame = {
        id, method: init?.method ?? 'GET', path: `/${rest.map(encodeURIComponent).join('/')}${u.search}`,
        idempotencyKey: headers.get('idempotency-key') ?? undefined,
        body: typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined,
      };
      return new Promise<Response>((resolve, reject) => {
        conn.pending.set(id, { resolve, reject });
        init?.signal?.addEventListener('abort', () => {
          if (conn.pending.delete(id)) reject(Object.assign(new Error('Délai dépassé avec l\'agent'), { name: 'AbortError' }));
        });
        try { conn.ws.send(JSON.stringify(frame)); } catch (e) { conn.pending.delete(id); reject(netErr('ECONNRESET', (e as Error).message)); }
      });
    }) as typeof fetch;
  }
}
