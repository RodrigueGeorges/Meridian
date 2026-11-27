// Passerelle Concert / Caisse-AP sur IP (France) : Meridian se présente comme un TPE sur le port 8888.
// Format : messages ASCII TLV « TT LLL valeur », CZ en premier. Tags utilisés :
//   requête  CZ version · CJ identifiant protocole · CA n° de caisse · CB montant (unités mineures)
//            CD 0 = débit, 1 = remboursement, 2 = annulation de la dernière opération de ce montant · CE devise ISO numérique · BA 1 = réponse immédiate
//   réponse  AE 10 = fait, 01 = non fait, 11 = pris en compte · AF motif (04 refus, 08 délai, 11 abandon, 05 interdit, 09 format)
//            AC n° d'autorisation · AA numéro masqué · CC mode de paiement
// Limite du protocole : aucune référence de transaction ni idempotence côté caisse.
import net from 'node:net';
import { bridgeRef, ISO_NUMERIC, ISO_NUMERIC_REV, type BridgeTarget } from './target.ts';

export function parseTlv(s: string): { fields: Record<string, string>; complete: boolean } {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    if (i + 5 > s.length) return { fields, complete: false };
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 5));
    if (!/^[A-Z0-9]{2}$/.test(tag) || Number.isNaN(len)) throw new Error('format');
    if (i + 5 + len > s.length) return { fields, complete: false };
    fields[tag] = s.slice(i + 5, i + 5 + len);
    i += 5 + len;
  }
  return { fields, complete: true };
}

export function buildTlv(fields: Record<string, string>): string {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined && v !== '');
  const cz = entries.filter(([k]) => k === 'CZ');
  const rest = entries.filter(([k]) => k !== 'CZ');
  return [...cz, ...rest].map(([k, v]) => `${k}${String(v.length).padStart(3, '0')}${v}`).join('');
}

const MANDATORY = ['CZ', 'CJ', 'CA', 'CB', 'CD', 'CE'];

export interface ConcertOptions {
  /** N° de caisse (CA) → point de vente Meridian. */
  posFor: (caisse: string) => string | undefined;
  timeoutMs?: number;
}

export async function handleConcert(req: Record<string, string>, target: BridgeTarget, o: ConcertOptions): Promise<Record<string, string>> {
  const answer: Record<string, string> = { ...req };
  delete answer.BA;
  const fail = (af: string) => ({ ...answer, AE: '01', AF: af });
  if (MANDATORY.some((t) => !req[t])) return fail('09');
  const posId = o.posFor(req.CA!);
  const currency = ISO_NUMERIC[req.CE!];
  const amount = Number(req.CB);
  if (!posId || !currency || !Number.isInteger(amount) || amount <= 0) return fail('05');
  try {
    if (req.CD === '1') {
      const original = target.lastRefundable(posId, amount);
      if (!original) return fail('05');
      await target.refund(posId, original.reference, amount);
      return { ...answer, AE: '10' };
    }
    if (req.CD === '2') {
      // Annulation : la dernière opération autorisée de ce montant sur cette caisse, en cours ou terminée.
      const original = target.lastCancellable(posId, amount);
      if (!original) return fail('05');
      if (original.state === 'pending' || original.state === 'created') await target.cancel(posId, original.reference);
      else await target.refund(posId, original.reference, original.amount - original.refunded);
      return { ...answer, AE: '10' };
    }
    if (req.CD !== '0') return fail('05');
    const reference = bridgeRef('CONCERT', req.CA!);
    await target.pay(posId, reference, amount, currency);
    const v = await target.waitFinal(posId, reference, o.timeoutMs ?? 120_000);
    if (v.state === 'authorized') {
      const r = target.receipt(posId, reference);
      return { ...answer, AE: '10', AC: String(r?.proof.seq ?? 0).padStart(6, '0'), AA: `############${r?.last4 ?? '0000'}`, CC: '001', CI: '2' };
    }
    return fail(v.state === 'cancelled' ? '11' : v.state === 'pending' ? '08' : '04');
  } catch {
    return fail('05');
  }
}

/** Serveur TCP Concert. Une requête par connexion, comme un TPE Caisse-AP IP.
 *  Bornes : 64 Ko de trame maximum, 200 connexions simultanées, inactivité 2 min. */
export function createConcertServer(target: BridgeTarget, o: ConcertOptions): net.Server {
  const srv = net.createServer((sock) => {
    let buf = '';
    let busy = false;
    sock.setEncoding('ascii');
    sock.setTimeout(120_000, () => sock.end());
    sock.on('data', async (chunk: string) => {
      if (busy) return;
      buf += chunk;
      if (buf.length > 64 * 1024) { sock.destroy(); return; } // au-delà de la trame maximale : connexion détruite
      let parsed;
      try {
        parsed = parseTlv(buf);
      } catch {
        sock.end(buildTlv({ AE: '01', AF: '09' }));
        return;
      }
      if (!parsed.complete || !parsed.fields.CZ) return;
      busy = true;
      const req = parsed.fields;
      if (req.BA === '1') sock.write(buildTlv({ CZ: req.CZ!, CA: req.CA ?? '', AE: '11' }));
      const ans = await handleConcert(req, target, o);
      if (!sock.destroyed) sock.end(buildTlv(ans));
    });
    sock.on('error', () => undefined);
  });
  srv.maxConnections = 200; // au-delà : la connexion est refusée (événement 'drop'), le serveur reste vivant
  return srv;
}

export { ISO_NUMERIC_REV };
