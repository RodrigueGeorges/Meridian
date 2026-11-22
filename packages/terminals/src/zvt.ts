// Pilote ZVT sur TCP/IP (Allemagne, Autriche, Suisse), côté caisse (ECR).
// Authorization 06 01 (BMP 04 montant, BMP 49 devise), Abort 06 B0 sur la même liaison, Refund 06 31, Reversal 06 30.
// La caisse acquitte chaque Status-Information (04 0F) et la Completion (06 0F) par 80 00 00.
import net from 'node:net';
import { ACK, apdu, fromBcd, ISO_NUMERIC_REV, readApdu, toBcd } from '@meridian/bridges';
import { LinkError, type TerminalDriver, type TerminalResult } from './types.ts';

export interface ZvtDriverOptions { host: string; port: number; timeoutMs?: number }

interface Frame { cls: number; ins: number; data: Buffer }

function parseStatus(d: Buffer): { result?: number; amount?: number; receipt?: number } {
  const out: { result?: number; amount?: number; receipt?: number } = {};
  let i = 0;
  while (i < d.length) {
    const b = d[i]!;
    if (b === 0x27) { out.result = d[i + 1]; i += 2; }
    else if (b === 0x04) { out.amount = fromBcd(d.subarray(i + 1, i + 7)); i += 7; }
    else if (b === 0x87) { out.receipt = fromBcd(d.subarray(i + 1, i + 3)); i += 3; }
    else if (b === 0x00) i += 1;
    else break;
  }
  return out;
}

export class ZvtDriver implements TerminalDriver {
  readonly protocol = 'zvt' as const;
  private live?: { sock: net.Socket; reference: string };
  constructor(private readonly o: ZvtDriverOptions) {}

  /** Envoie une commande et lit jusqu'à Completion (06 0F) ou Abort (06 1E). */
  private run(cmd: Buffer, reference?: string): Promise<{ frames: Frame[]; aborted?: number }> {
    return new Promise((resolve, reject) => {
      let sent = false;
      let buf = Buffer.alloc(0);
      const frames: Frame[] = [];
      const sock = net.connect({ host: this.o.host, port: this.o.port });
      if (reference) this.live = { sock, reference };
      const done = (fn: () => void) => { clearTimeout(timer); if (this.live?.sock === sock) this.live = undefined; sock.end(); fn(); };
      const timer = setTimeout(() => { sock.destroy(); reject(new LinkError('Délai dépassé avec le terminal', !sent)); }, this.o.timeoutMs ?? 180_000);
      sock.on('connect', () => { sock.write(cmd); sent = true; });
      sock.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const m = readApdu(buf);
          if (!m) return;
          buf = buf.subarray(m.size);
          if (m.cls === 0x80 && m.ins === 0x00) continue; // ACK du terminal
          if (m.cls === 0x84) return done(() => reject(new LinkError(`Commande refusée par le terminal (84 ${m.ins.toString(16)})`, false)));
          sock.write(ACK);
          if (m.cls === 0x06 && m.ins === 0x0f) return done(() => resolve({ frames }));
          if (m.cls === 0x06 && m.ins === 0x1e) return done(() => resolve({ frames, aborted: m.data[0] ?? 0xff }));
          frames.push({ cls: m.cls, ins: m.ins, data: Buffer.from(m.data) });
        }
      });
      sock.on('close', () => { clearTimeout(timer); if (this.live?.sock === sock) this.live = undefined; reject(new LinkError('Liaison fermée par le terminal', !sent)); });
      sock.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new LinkError(e.message, !sent || e.code === 'ECONNREFUSED')); });
    });
  }

  private currency(c: string): number[] {
    const n = ISO_NUMERIC_REV[c];
    if (!n) throw new Error(`Devise non prise en charge par ZVT : ${c}`);
    return toBcd(Number(n), 2);
  }

  async pay(p: { reference: string; amount: number; currency: string }): Promise<TerminalResult> {
    let r: { frames: Frame[]; aborted?: number };
    try {
      r = await this.run(apdu(0x06, 0x01, [0x04, ...toBcd(p.amount, 6), 0x49, ...this.currency(p.currency)]), p.reference);
    } catch (e) {
      if (e instanceof LinkError && e.beforeSend) throw e;
      return { state: 'unknown', detail: 'terminal_link_lost' };
    }
    if (r.aborted !== undefined) return r.aborted === 0x6c ? { state: 'cancelled', detail: 'aborted' } : { state: 'declined', detail: `zvt_${r.aborted.toString(16).padStart(2, '0')}` };
    const st = r.frames.filter((f) => f.cls === 0x04 && f.ins === 0x0f).map((f) => parseStatus(f.data)).find((s) => s.result !== undefined);
    if (st?.result === 0x00) return { state: 'authorized', terminalRef: st.receipt !== undefined ? String(st.receipt) : undefined };
    return { state: 'declined', detail: `zvt_${(st?.result ?? 0xff).toString(16).padStart(2, '0')}` };
  }

  async cancel(reference: string): Promise<'sent' | 'unsupported'> {
    if (!this.live || this.live.reference !== reference) return 'unsupported';
    this.live.sock.write(apdu(0x06, 0xb0));
    return 'sent';
  }

  async refund(p: { amount: number; currency: string; terminalRef?: string; originalAmount: number }): Promise<'done' | 'refused'> {
    // Annulation totale par n° de reçu (Reversal) quand c'est possible, sinon remboursement du montant (Refund).
    const cmd = p.terminalRef && p.amount === p.originalAmount
      ? apdu(0x06, 0x30, [0x87, ...toBcd(Number(p.terminalRef), 2)])
      : apdu(0x06, 0x31, [0x04, ...toBcd(p.amount, 6)]);
    const r = await this.run(cmd);
    return r.aborted === undefined ? 'done' : 'refused';
  }

  async health(): Promise<boolean> {
    try {
      await this.run(apdu(0x05, 0x01));
      return true;
    } catch {
      return false;
    }
  }
}
