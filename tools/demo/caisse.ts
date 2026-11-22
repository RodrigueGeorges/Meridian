// Émule une caisse française déjà intégrée en Concert / Caisse-AP : elle envoie sa trame habituelle à Meridian.
// Usage : pnpm caisse 24.50 [--panne]   (la démo locale doit tourner : pnpm demo)
import net from 'node:net';
import { buildTlv, parseTlv } from '@meridian/bridges';

const amount = Math.round(Number(process.argv[2] ?? '24.50') * 100);
const panne = process.argv.includes('--panne');
const SIM = 'http://127.0.0.1:12111';
const debits = async () => {
  const [a, b] = await Promise.all([SIM, 'http://127.0.0.1:12112'].map((s) => fetch(`${s}/__state`).then((r) => r.json() as Promise<{ debits: number }>)));
  return a!.debits + b!.debits;
};
const euros = (c: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);

const before = await debits();
const frame = buildTlv({ CZ: '0300', CJ: '012345678901', CA: '01', CE: '978', BA: '0', CD: '0', CC: '00C', CB: String(amount) });
console.log(`\n  Caisse n° 01 → Meridian (Caisse-AP, port 8888) : débit de ${euros(amount)}`);
console.log(`  Trame envoyée, inchangée par rapport à un terminal classique :\n  ${frame}\n`);
if (panne) {
  setTimeout(() => {
    void fetch(`${SIM}/__faults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ netDownUntil: Date.now() + 2500 }) });
    console.log('  ⚡ Réseau vers le PSP coupé pendant 2,5 s, en plein paiement…');
  }, 300);
}
const t0 = Date.now();
const reply = await new Promise<string>((resolve, reject) => {
  let got = '';
  const sock = net.connect(8888, '127.0.0.1', () => sock.write(frame, 'ascii'));
  sock.setEncoding('ascii');
  sock.on('data', (d) => { got += String(d); });
  sock.on('end', () => resolve(got));
  sock.on('error', reject);
});
await new Promise((r) => setTimeout(r, 400));
const f = parseTlv(reply).fields;
const ok = f.AE === '10';
console.log(`  Réponse reçue par la caisse en ${((Date.now() - t0) / 1000).toFixed(2)} s : ${reply}`);
console.log(`  → ${ok ? 'Paiement accepté' : `Paiement refusé (code ${f.AF ?? '?'})`}`);
console.log(`  → Débits constatés chez le PSP : ${(await debits()) - before}\n`);
