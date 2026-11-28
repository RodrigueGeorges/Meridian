// Passerelles : de vraies caisses simulées parlent Concert, ZVT et nexo à Meridian, qui paie via le simulateur Stripe.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { harness } from '../../../conformance/harness.ts';
import { buildTlv, createConcertServer, parseTlv } from './concert.ts';
import { handleNexo, nexoFromXml, nexoToXml } from './nexo.ts';
import { engineTarget } from './target.ts';
import { ACK, apdu, createZvtServer, fromBcd, readApdu, toBcd } from './zvt.ts';

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
let srv: net.Server | undefined;
afterEach(async () => {
  srv?.close();
  await h?.close();
  h = undefined;
});
const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

/** Caisse Concert : envoie une requête, lit jusqu'à la fermeture. */
function concertCall(port: number, fields: Record<string, string>): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(buildTlv(fields)));
    let data = '';
    sock.setEncoding('ascii');
    sock.on('data', (d) => (data += d));
    sock.on('end', () => resolve(parseTlv(data).fields));
    sock.on('error', reject);
  });
}

/** Caisse ZVT : envoie une APDU, collecte les trames jusqu'à Completion ou Abort, acquitte comme une vraie caisse. */
function zvtCall(port: number, frame: Buffer): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const frames: Buffer[] = [];
    let buf = Buffer.alloc(0);
    const sock = net.connect(port, '127.0.0.1', () => sock.write(frame));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (let m = readApdu(buf); m; m = readApdu(buf)) {
        frames.push(buf.subarray(0, m.size));
        buf = buf.subarray(m.size);
        if (m.cls === 0x04 && m.ins === 0x0f) sock.write(ACK);
        if ((m.cls === 0x06 && m.ins === 0x0f) || (m.cls === 0x06 && m.ins === 0x1e)) {
          sock.end();
          resolve(frames);
        }
      }
    });
    sock.on('error', reject);
  });
}

const BASE = { CZ: '0300', CJ: '012345678901', CA: '01', CE: '978', BA: '0' };

describe('Passerelle Concert / Caisse-AP', () => {
  it('débit accepté, puis remboursement du dernier paiement', async () => {
    h = await harness();
    srv = createConcertServer(engineTarget(h.engine), { posFor: (ca) => (ca === '01' ? h!.posId : undefined) });
    const port = await listen(srv);
    const r = await concertCall(port, { ...BASE, CB: '2450', CD: '0' });
    expect(r.AE).toBe('10');
    expect(r.AA).toMatch(/4242$/);
    expect(h.sims.debits()).toBe(1);
    const rf = await concertCall(port, { ...BASE, CB: '1000', CD: '1' });
    expect(rf.AE).toBe('10');
    expect(h.sims.stripe.state.refunds.size).toBe(1);
  });
  it('annulation (CD 2) de la dernière opération de ce montant ; rien à annuler → AF 05', async () => {
    h = await harness();
    srv = createConcertServer(engineTarget(h.engine), { posFor: (ca) => (ca === '01' ? h!.posId : undefined) });
    const port = await listen(srv);
    expect((await concertCall(port, { ...BASE, CB: '1890', CD: '0' })).AE).toBe('10');
    expect((await concertCall(port, { ...BASE, CB: '1890', CD: '2' })).AE).toBe('10');
    expect(h.sims.stripe.state.refunds.size).toBe(1);
    expect(await concertCall(port, { ...BASE, CB: '1890', CD: '2' })).toMatchObject({ AE: '01', AF: '05' });
    expect(h.sims.debits()).toBe(1);
  });
  it('carte refusée → AE 01 AF 04 ; requête incomplète → AF 09 ; caisse inconnue → AF 05', async () => {
    h = await harness();
    srv = createConcertServer(engineTarget(h.engine), { posFor: (ca) => (ca === '01' ? h!.posId : undefined) });
    const port = await listen(srv);
    h.sims.stripe.faults.declineNext = true;
    expect(await concertCall(port, { ...BASE, CB: '500', CD: '0' })).toMatchObject({ AE: '01', AF: '04' });
    expect(await concertCall(port, { CZ: '0300', CB: '500' })).toMatchObject({ AE: '01', AF: '09' });
    expect(await concertCall(port, { ...BASE, CA: '07', CB: '500', CD: '0' })).toMatchObject({ AE: '01', AF: '05' });
  });
  it('trame brute d’une caisse Caisse-AP IP existante (ordre CZ, CJ, CA, CE, BA, CD, CC, CB) : réponse en un seul paquet', async () => {
    h = await harness();
    srv = createConcertServer(engineTarget(h.engine), { posFor: (ca) => (ca === '01' ? h!.posId : undefined) });
    const port = await listen(srv);
    // 112,45 € avec impression chèque, telle qu'émise par les clients Caisse-AP IP du marché (un seul send, un seul recv).
    const raw = 'CZ0040300CJ012012345678901CA00201CE003978BA0010CD0010CC00300CCB00511245';
    const chunks = await new Promise<string[]>((resolve, reject) => {
      const got: string[] = [];
      const sock = net.connect(port, '127.0.0.1', () => sock.write(raw, 'ascii'));
      sock.setEncoding('ascii');
      sock.on('data', (d) => got.push(String(d)));
      sock.on('end', () => resolve(got));
      sock.on('error', reject);
    });
    expect(chunks).toHaveLength(1);
    const f = parseTlv(chunks[0]!).fields;
    expect(f).toMatchObject({ AE: '10', CA: '01', CB: '11245', CE: '978' });
    expect(h.sims.debits()).toBe(1);
  });
});

describe('Passerelle ZVT', () => {
  it('Registration puis Authorization : ACK, Status-Information (27 00), Completion ; Reversal du reçu', async () => {
    h = await harness({ country: 'DE' });
    srv = createZvtServer(engineTarget(h.engine), { posId: h.posId });
    const port = await listen(srv);
    const reg = await zvtCall(port, apdu(0x06, 0x00, [0x00, 0x00, 0x00, 0x08, 0x09, 0x78]));
    expect(reg.map((f) => f.toString('hex'))).toEqual(['800000', '060f00']);
    const auth = await zvtCall(port, apdu(0x06, 0x01, [0x04, ...toBcd(2450, 6), 0x49, 0x09, 0x78]));
    expect(auth[0]!.toString('hex')).toBe('800000');
    const status = auth.find((f) => f[0] === 0x04 && f[1] === 0x0f)!;
    expect(status.subarray(3, 5).toString('hex')).toBe('2700');
    expect(auth.at(-1)!.toString('hex')).toBe('060f00');
    expect(h.sims.debits()).toBe(1);
    const receipt = status.subarray(status.length - 2);
    const rev = await zvtCall(port, apdu(0x06, 0x30, [0x87, ...receipt]));
    expect(rev.at(-1)!.toString('hex')).toBe('060f00');
    expect(h.sims.stripe.state.refunds.size).toBe(1);
  });
  it('Refund (06 31), End-of-Day (06 50) avec total net, Log-Off, Status Enquiry et Diagnosis', async () => {
    h = await harness({ country: 'DE' });
    srv = createZvtServer(engineTarget(h.engine), { posId: h.posId });
    const port = await listen(srv);
    for (const amount of [2450, 1000]) {
      const f = await zvtCall(port, apdu(0x06, 0x01, [0x04, ...toBcd(amount, 6), 0x49, 0x09, 0x78]));
      expect(f.at(-1)!.toString('hex')).toBe('060f00');
    }
    const rf = await zvtCall(port, apdu(0x06, 0x31, [0x04, ...toBcd(500, 6)]));
    expect(rf.at(-1)!.toString('hex')).toBe('060f00');
    expect(h.sims.stripe.state.refunds.size).toBe(1);
    const eod = await zvtCall(port, apdu(0x06, 0x50, [0x00, 0x00, 0x00]));
    const st = eod.find((f) => f[0] === 0x04 && f[1] === 0x0f)!;
    expect(st.subarray(3, 5).toString('hex')).toBe('2700');
    expect(fromBcd(st.subarray(6, 12))).toBe(2450 + 1000 - 500);
    const eod2 = await zvtCall(port, apdu(0x06, 0x50, [0x00, 0x00, 0x00]));
    expect(fromBcd(eod2.find((f) => f[0] === 0x04)!.subarray(6, 12))).toBe(0); // remis à zéro après clôture
    for (const [c, i] of [[0x06, 0x02], [0x05, 0x01], [0x06, 0x70]] as const) {
      expect((await zvtCall(port, apdu(c, i))).map((f) => f.toString('hex'))).toEqual(['800000', '060f00']);
    }
  });
  it('refus → Abort 06 1E', async () => {
    h = await harness({ country: 'DE' });
    srv = createZvtServer(engineTarget(h.engine), { posId: h.posId });
    const port = await listen(srv);
    h.sims.stripe.faults.declineNext = true;
    const f = await zvtCall(port, apdu(0x06, 0x01, [0x04, ...toBcd(900, 6)]));
    expect(f.at(-1)!.subarray(0, 2).toString('hex')).toBe('061e');
    expect(h.sims.debits()).toBe(0);
  });
});

describe('Passerelles TCP bornées', () => {
  /** Envoie 100 Ko sans trame complète ; résolu quand le serveur a fermé la connexion (vu côté serveur). */
  const flood = async (s: net.Server, port: number, data: string | Buffer) => {
    const closed = new Promise<void>((res) => s.once('connection', (c) => c.on('close', () => res())));
    const sock = net.connect(port, '127.0.0.1', () => sock.write(data));
    sock.on('error', () => undefined);
    await closed;
    sock.destroy();
  };
  it('Concert : 100 Ko sans trame complète → connexion détruite, le serveur reste vivant', async () => {
    h = await harness();
    srv = createConcertServer(engineTarget(h.engine), { posFor: (ca) => (ca === '01' ? h!.posId : undefined) });
    const port = await listen(srv);
    // Trame TLV valide en tête mais annoncée à 999 octets : jamais complète, le cap 64 Ko la détruit.
    await flood(srv, port, 'CZ999' + 'X'.repeat(100 * 1024));
    expect(srv.listening).toBe(true);
    expect((await concertCall(port, { ...BASE, CB: '500', CD: '0' })).AE).toBe('10');
  });
  it('ZVT : 100 Ko de données sans trame complète → connexion détruite, le serveur reste vivant', async () => {
    h = await harness({ country: 'DE' });
    srv = createZvtServer(engineTarget(h.engine), { posId: h.posId });
    const port = await listen(srv);
    // APDU annonçant 65 535 octets de données : jamais complète, le cap 64 Ko la détruit.
    await flood(srv, port, Buffer.concat([Buffer.from([0x06, 0x01, 0xff, 0xff, 0xff]), Buffer.alloc(100 * 1024, 0x58)]));
    expect(srv.listening).toBe(true);
    const reg = await zvtCall(port, apdu(0x06, 0x00, [0x00, 0x00, 0x00, 0x08, 0x09, 0x78]));
    expect(reg.map((f) => f.toString('hex'))).toEqual(['800000', '060f00']);
  });
});

describe('Passerelle nexo Retailer', () => {
  const hdr = (posId: string, cat: string) => ({ ProtocolVersion: '3.1', MessageClass: 'Service', MessageCategory: cat, MessageType: 'Request', ServiceID: 'S1', SaleID: 'CAISSE-1', POIID: posId });
  it('Payment (idempotent par TransactionID), TransactionStatus, Reversal', async () => {
    h = await harness();
    const t = engineTarget(h.engine);
    const pay = { SaleToPOIRequest: { MessageHeader: hdr(h.posId, 'Payment'), PaymentRequest: { SaleData: { SaleTransactionID: { TransactionID: 'NEXO-1', TimeStamp: new Date().toISOString() } }, PaymentTransaction: { AmountsReq: { Currency: 'EUR', RequestedAmount: 24.5 } } } } };
    const r = await handleNexo(pay, t);
    expect(r.SaleToPOIResponse.PaymentResponse.Response.Result).toBe('Success');
    expect(r.SaleToPOIResponse.PaymentResponse.PaymentResult.AmountsResp.AuthorizedAmount).toBe(24.5);
    const again = await handleNexo(pay, t);
    expect(again.SaleToPOIResponse.PaymentResponse.Response.Result).toBe('Success');
    expect(h.sims.debits()).toBe(1);
    const st = await handleNexo({ SaleToPOIRequest: { MessageHeader: hdr(h.posId, 'TransactionStatus'), TransactionStatusRequest: { MessageReference: { SaleID: 'NEXO-1' } } } }, t);
    expect(st.SaleToPOIResponse.TransactionStatusResponse.RepeatedMessageResponse.RepeatedResponseMessageBody.PaymentResponse.Response.Result).toBe('Success');
    const rev = await handleNexo({ SaleToPOIRequest: { MessageHeader: hdr(h.posId, 'Reversal'), ReversalRequest: { OriginalPOITransaction: { POITransactionID: { TransactionID: 'NEXO-1' } } } } }, t);
    expect(rev.SaleToPOIResponse.ReversalResponse.Response.Result).toBe('Success');
    expect(rev.SaleToPOIResponse.ReversalResponse.ReversedAmount).toBe(24.5);
  });
  it('Login, Reconciliation (totaux depuis le dernier rapprochement), Logout', async () => {
    h = await harness();
    const t = engineTarget(h.engine);
    const login = await handleNexo({ SaleToPOIRequest: { MessageHeader: hdr(h.posId, 'Login'), LoginRequest: { DateTime: new Date().toISOString() } } }, t);
    expect(login.SaleToPOIResponse.LoginResponse.Response.Result).toBe('Success');
    for (const [id, amt] of [['R-1', 10], ['R-2', 15.5]] as const) {
      await handleNexo({ SaleToPOIRequest: { MessageHeader: hdr(h.posId, 'Payment'), PaymentRequest: { SaleData: { SaleTransactionID: { TransactionID: id } }, PaymentTransaction: { AmountsReq: { Currency: 'EUR', RequestedAmount: amt } } } } }, t);
    }
    const rec = () => handleNexo({ SaleToPOIRequest: { MessageHeader: hdr(h!.posId, 'Reconciliation'), ReconciliationRequest: { ReconciliationType: 'SaleReconciliation' } } }, t);
    const r1 = await rec();
    expect(r1.SaleToPOIResponse.ReconciliationResponse.TransactionTotals[0].PaymentTotals[0]).toMatchObject({ TransactionCount: 2, TransactionAmount: 25.5 });
    expect((await rec()).SaleToPOIResponse.ReconciliationResponse.TransactionTotals).toEqual([]);
    const out = await handleNexo({ SaleToPOIRequest: { MessageHeader: hdr(h.posId, 'Logout'), LogoutRequest: {} } }, t);
    expect(out.SaleToPOIResponse.LogoutResponse.Response.Result).toBe('Success');
  });
  it('forme XML : la requête nexo XML donne la même réponse, rendue en XML', async () => {
    h = await harness();
    const xml = `<?xml version="1.0"?><SaleToPOIRequest><MessageHeader ProtocolVersion="3.1" MessageClass="Service" MessageCategory="Payment" MessageType="Request" ServiceID="S9" SaleID="CAISSE-1" POIID="${h.posId}"/><PaymentRequest><SaleData><SaleTransactionID TransactionID="0042" TimeStamp="2026-11-22T10:00:00Z"/></SaleData><PaymentTransaction><AmountsReq Currency="EUR" RequestedAmount="12.30"/></PaymentTransaction></PaymentRequest></SaleToPOIRequest>`;
    const res = await handleNexo(nexoFromXml(xml), engineTarget(h.engine));
    expect(res.SaleToPOIResponse.PaymentResponse.Response.Result).toBe('Success');
    expect(res.SaleToPOIResponse.PaymentResponse.POIData.POITransactionID.TransactionID).toBe('0042'); // reste une chaîne
    const out = nexoToXml(res);
    expect(out).toMatch(/^<\?xml/);
    expect(out).toContain('<Response Result="Success"');
    expect(out).toContain('AuthorizedAmount="12.3"');
    expect(h.sims.debits()).toBe(1);
  });
  it('entité interne déclarée : refus propre, ni expansion ni crash', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY boom "expansion">]><SaleToPOIRequest><MessageHeader POIID="x" MessageCategory="Login" MessageType="Request"/></SaleToPOIRequest>`;
    expect(() => nexoFromXml(xml)).toThrow(/DOCTYPE/);
    const clean = nexoFromXml(`<SaleToPOIRequest><MessageHeader POIID="x" MessageCategory="Login"/></SaleToPOIRequest>`);
    expect(clean.SaleToPOIRequest.MessageHeader.POIID).toBe('x');
  });
  it('refus → Result Failure, ErrorCondition Refusal', async () => {
    h = await harness();
    h.sims.stripe.faults.declineNext = true;
    const r = await handleNexo({ SaleToPOIRequest: { MessageHeader: hdr(h.posId, 'Payment'), PaymentRequest: { SaleData: { SaleTransactionID: { TransactionID: 'NEXO-2' } }, PaymentTransaction: { AmountsReq: { Currency: 'EUR', RequestedAmount: 5 } } } } }, engineTarget(h.engine));
    expect(r.SaleToPOIResponse.PaymentResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'Refusal' });
  });
});
