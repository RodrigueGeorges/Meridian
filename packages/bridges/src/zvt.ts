// Passerelle ZVT (Allemagne, Autriche, Suisse) sur TCP/IP : Meridian se présente comme un terminal ZVT.
// Trames APDU : CLASS INSTR LEN [DATA] (LEN = 0xFF + 2 octets little-endian au-delà de 254).
// Pris en charge : 06 00 Registration · 06 02 Log-Off · 06 01 Authorization (BMP 04 montant BCD 6 octets, BMP 49 devise)
//                  06 30 Reversal (BMP 87 n° de reçu) · 06 31 Refund (BMP 04 montant) · 06 B0 Abort
//                  06 50 End-of-Day (BMP 04 total du jour) · 05 01 Status Enquiry · 06 70 Diagnosis.
// Réponses : 80 00 00 (ACK) · 04 0F Status-Information (27 code résultat, 04 montant, 87 n° de reçu) · 06 0F Completion
//            06 1E Abort (code d'erreur : 6C abandon, FF autre/refus — à valider sur terminal réel avec la spec VDT).
import net from 'node:net';
import { bridgeRef, ISO_NUMERIC, type BridgeTarget } from './target.ts';

export const ACK = Buffer.from([0x80, 0x00, 0x00]);
export const COMPLETION = Buffer.from([0x06, 0x0f, 0x00]);

export function apdu(cls: number, ins: number, data: number[] | Buffer = []): Buffer {
  const d = Buffer.from(data);
  const len = d.length < 0xff ? Buffer.from([d.length]) : Buffer.from([0xff, d.length & 0xff, d.length >> 8]);
  return Buffer.concat([Buffer.from([cls, ins]), len, d]);
}

export function readApdu(buf: Buffer): { cls: number; ins: number; data: Buffer; size: number } | undefined {
  if (buf.length < 3) return undefined;
  let len = buf[2]!;
  let head = 3;
  if (len === 0xff) {
    if (buf.length < 5) return undefined;
    len = buf[3]! | (buf[4]! << 8);
    head = 5;
  }
  if (buf.length < head + len) return undefined;
  return { cls: buf[0]!, ins: buf[1]!, data: buf.subarray(head, head + len), size: head + len };
}

export const toBcd = (n: number, bytes: number): number[] => {
  const s = String(n).padStart(bytes * 2, '0');
  return Array.from({ length: bytes }, (_, i) => (Number(s[2 * i]) << 4) | Number(s[2 * i + 1]));
};
export const fromBcd = (b: Buffer): number => Number([...b].map((x) => `${x >> 4}${x & 0x0f}`).join(''));

/** Lit les BMP connus d'une Authorization / Reversal. */
export function parseBmps(d: Buffer): { amount?: number; currency?: string; receipt?: number } {
  const out: { amount?: number; currency?: string; receipt?: number } = {};
  let i = 0;
  while (i < d.length) {
    const b = d[i]!;
    if (b === 0x04) { if (i + 7 > d.length) break; out.amount = fromBcd(d.subarray(i + 1, i + 7)); i += 7; }
    else if (b === 0x49) { if (i + 3 > d.length) break; out.currency = String(fromBcd(d.subarray(i + 1, i + 3))).padStart(3, '0'); i += 3; }
    else if (b === 0x87) { if (i + 3 > d.length) break; out.receipt = fromBcd(d.subarray(i + 1, i + 3)); i += 3; }
    else if (b === 0x01 || b === 0x19) { if (i + 2 > d.length) break; i += 2; }
    else if (b === 0x02) { if (i + 2 > d.length) break; i += 2; }
    else break; // BMP inconnu : on s'arrête, le montant est en tête dans la pratique
  }
  return out;
}

export interface ZvtOptions { posId: string; currency?: string; timeoutMs?: number }

/** Serveur TCP ZVT. Bornes : 64 Ko de trame maximum, 200 connexions simultanées, inactivité 2 min. */
export function createZvtServer(target: BridgeTarget, o: ZvtOptions): net.Server {
  const receipts = new Map<number, string>(); // n° de reçu → référence Meridian
  let receiptNo = 0;
  let day: string[] = []; // références autorisées par ce terminal depuis la dernière clôture
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let current: string | undefined;
    const send = (b: Buffer) => !sock.destroyed && sock.write(b);
    sock.setTimeout(120_000, () => sock.end());
    sock.on('data', async (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 64 * 1024) { sock.destroy(); return; } // au-delà de la trame maximale : connexion détruite
      for (;;) {
        const m = readApdu(buf);
        if (!m) return;
        buf = buf.subarray(m.size);
        if (m.cls === 0x80 && m.ins === 0x00) continue; // ACK de la caisse
        const cmd = (m.cls << 8) | m.ins;
        if (cmd === 0x0600) { send(ACK); send(COMPLETION); continue; }
        if (cmd === 0x0602 || cmd === 0x0501 || cmd === 0x0670) { send(ACK); send(COMPLETION); continue; }
        if (cmd === 0x0650) {
          // Clôture de journée : total net des paiements autorisés depuis la dernière clôture.
          send(ACK);
          const total = day.map((ref) => target.status(o.posId, ref))
            .filter((v) => v.state === 'authorized')
            .reduce((n, v) => n + v.amount - v.refunded, 0);
          day = [];
          send(apdu(0x04, 0x0f, [0x27, 0x00, 0x04, ...toBcd(total, 6)]));
          send(COMPLETION);
          continue;
        }
        if (cmd === 0x0631) {
          const p = parseBmps(m.data);
          send(ACK);
          try {
            const original = p.amount ? target.lastRefundable(o.posId, p.amount) : undefined;
            if (!original || !p.amount) throw new Error('nothing to refund');
            await target.refund(o.posId, original.reference, p.amount);
            send(apdu(0x04, 0x0f, [0x27, 0x00, 0x04, ...toBcd(p.amount, 6)]));
            send(COMPLETION);
          } catch {
            send(apdu(0x06, 0x1e, [0xb4]));
          }
          continue;
        }
        if (cmd === 0x06b0) { send(ACK); if (current) void target.cancel(o.posId, current).catch(() => undefined); continue; }
        if (cmd === 0x0601) {
          const p = parseBmps(m.data);
          const currency = p.currency ? ISO_NUMERIC[p.currency] : (o.currency ?? 'EUR');
          if (!p.amount || !currency) { send(apdu(0x06, 0x1e, [0xff])); continue; }
          send(ACK);
          const reference = bridgeRef('ZVT', o.posId.slice(-6));
          current = reference;
          try {
            await target.pay(o.posId, reference, p.amount, currency);
            const v = await target.waitFinal(o.posId, reference, o.timeoutMs ?? 120_000);
            if (v.state === 'authorized') {
              receiptNo = (receiptNo % 9999) + 1;
              receipts.set(receiptNo, reference);
              day.push(reference);
              send(apdu(0x04, 0x0f, [0x27, 0x00, 0x04, ...toBcd(p.amount, 6), 0x87, ...toBcd(receiptNo, 2)]));
              send(COMPLETION);
            } else {
              send(apdu(0x06, 0x1e, [v.state === 'cancelled' ? 0x6c : 0xff]));
            }
          } catch {
            send(apdu(0x06, 0x1e, [0xff]));
          }
          current = undefined;
          continue;
        }
        if (cmd === 0x0630) {
          const p = parseBmps(m.data);
          const ref = p.receipt !== undefined ? receipts.get(p.receipt) : undefined;
          send(ACK);
          try {
            if (!ref) throw new Error('unknown receipt');
            const view = target.status(o.posId, ref);
            if (view.state !== 'authorized' || view.amount - view.refunded <= 0) throw new Error('not refundable');
            await target.refund(o.posId, ref, view.amount - view.refunded);
            send(apdu(0x04, 0x0f, [0x27, 0x00, 0x87, ...toBcd(p.receipt!, 2)]));
            send(COMPLETION);
          } catch {
            send(apdu(0x06, 0x1e, [0xb4]));
          }
          continue;
        }
        send(apdu(0x84, 0x83)); // commande non prise en charge
      }
    });
    sock.on('error', () => undefined);
  });
  srv.maxConnections = 200; // au-delà : la connexion est refusée (événement 'drop'), le serveur reste vivant
  // Arrêt propre : server.close() n'attend pas les sockets déjà ouvertes, on les suit pour les détruire.
  const socks = new Set<net.Socket>();
  srv.on('connection', (sock) => { socks.add(sock); sock.on('close', () => socks.delete(sock)); });
  (srv as net.Server & { closeAll?: () => void }).closeAll = () => { for (const s of socks) s.destroy(); };
  return srv;
}
