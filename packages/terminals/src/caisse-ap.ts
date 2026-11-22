// Pilote Caisse-AP / Concert sur IP (France), côté caisse : une requête par connexion TCP, messages TLV « TT LLL valeur ».
// Le protocole ne porte ni référence de transaction ni consultation d'état : si la liaison tombe après l'envoi,
// l'issue est « inconnue » et le paiement reste à vérifier au terminal (jamais déclaré en échec).
import net from 'node:net';
import { buildTlv, ISO_NUMERIC_REV, parseTlv } from '@meridian/bridges';
import { LinkError, type TerminalDriver, type TerminalResult } from './types.ts';

export interface CaisseApOptions { host: string; port: number; caisse?: string; protocolId?: string; timeoutMs?: number }

export class CaisseApDriver implements TerminalDriver {
  readonly protocol = 'caisse-ap' as const;
  constructor(private readonly o: CaisseApOptions) {}

  private exchange(fields: Record<string, string>): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      let sent = false;
      let buf = '';
      let final: Record<string, string> | undefined;
      const sock = net.connect({ host: this.o.host, port: this.o.port });
      sock.setEncoding('ascii');
      const timer = setTimeout(() => { sock.destroy(); reject(new LinkError('Délai dépassé avec le terminal', !sent)); }, this.o.timeoutMs ?? 180_000);
      sock.on('connect', () => { sock.write(buildTlv(fields)); sent = true; });
      sock.on('data', (chunk: string) => {
        buf += chunk;
        // Plusieurs messages possibles (AE=11 « pris en compte » puis réponse finale) : on garde le dernier complet.
        for (;;) {
          let parsed;
          try { parsed = parseTlv(buf); } catch { break; }
          if (!parsed.complete) break;
          if (parsed.fields.AE && parsed.fields.AE !== '11') final = parsed.fields;
          buf = '';
          break;
        }
      });
      sock.on('end', () => { clearTimeout(timer); final ? resolve(final) : reject(new LinkError('Liaison terminée sans réponse finale', !sent)); });
      sock.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new LinkError(e.message, !sent || e.code === 'ECONNREFUSED')); });
    });
  }

  private base(amount: number, currency: string, cd: '0' | '1' | '2'): Record<string, string> {
    const ce = ISO_NUMERIC_REV[currency];
    if (!ce) throw new Error(`Devise non prise en charge par Caisse-AP : ${currency}`);
    return { CZ: '0320', CJ: this.o.protocolId ?? '012345678901', CA: this.o.caisse ?? '01', CB: String(amount), CD: cd, CE: ce, BA: '1' };
  }

  async pay(p: { reference: string; amount: number; currency: string }): Promise<TerminalResult> {
    let r: Record<string, string>;
    try {
      r = await this.exchange(this.base(p.amount, p.currency, '0'));
    } catch (e) {
      if (e instanceof LinkError && e.beforeSend) throw e;
      return { state: 'unknown', detail: 'terminal_link_lost' };
    }
    if (r.AE === '10') return { state: 'authorized', last4: r.AA?.slice(-4), terminalRef: r.AC };
    if (r.AF === '11') return { state: 'cancelled', detail: 'aborted' };
    if (r.AF === '08') return { state: 'unknown', detail: 'terminal_timeout' };
    return { state: 'declined', detail: r.AF === '04' ? 'card_declined' : `caisse_ap_${r.AF ?? 'error'}` };
  }

  async cancel(): Promise<'sent' | 'unsupported'> {
    // Caisse-AP n'interrompt pas une autorisation en cours depuis la caisse : l'abandon se fait au terminal.
    return 'unsupported';
  }

  async refund(p: { amount: number; currency: string }): Promise<'done' | 'refused'> {
    const r = await this.exchange(this.base(p.amount, p.currency, '1'));
    return r.AE === '10' ? 'done' : 'refused';
  }

  async health(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.connect({ host: this.o.host, port: this.o.port });
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(3000, () => { s.destroy(); resolve(false); });
    });
  }
}
