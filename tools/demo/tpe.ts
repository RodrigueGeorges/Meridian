// Encaisse sur le TPE du magasin, par l'API locale de l'agent ou par l'API cloud. Mêmes 5 appels dans les deux cas.
// Usage : pnpm tpe 24.50 [--local | --cloud]   (la démo doit tourner : pnpm demo). Montant en ,13 = refus.
const amount = Math.round(Number(process.argv[2] ?? '24.50') * 100);
const cloud = process.argv.includes('--cloud');
if (cloud && process.argv.includes('--local')) { console.error('--local et --cloud sont exclusifs'); process.exit(1); }
const base = cloud ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:8787';
const posId = cloud ? 'pos_demo_TPE' : 'caisse-1';
const headers = { 'content-type': 'application/json', authorization: 'Bearer mk_test_demo0123456789abcdef' };
const euros = (c: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);
const reference = `TPE-${Date.now().toString(36).toUpperCase()}`;

console.log(`\n  ${cloud ? 'Caisse SaaS → API Meridian (cloud) → agent du magasin' : 'Caisse installée → API locale de l\'agent'} → TPE Caisse-AP`);
console.log(`  POST ${base}/v1/payments  ${reference}  ${euros(amount)}\n`);
const t0 = Date.now();
await fetch(`${base}/v1/payments`, { method: 'POST', headers, body: JSON.stringify({ posId, reference, amount, currency: 'EUR' }) });
console.log('  Carte présentée au terminal…');
const v = await (await fetch(`${base}/v1/payments/${reference}?posId=${posId}&waitMs=15000`, { headers })).json() as { state: string; detail?: string; module: string };
const mark = v.state === 'authorized' ? '✓' : '✕';
console.log(`  ${mark} ${v.state}${v.detail ? ` (${v.detail})` : ''} en ${((Date.now() - t0) / 1000).toFixed(1)} s · connecteur ${v.module}`);
const j = await (await fetch(`${base}/v1/payments/${reference}/journal?posId=${posId}`, { headers })).json().catch(() => null) as { type: string }[] | null;
if (Array.isArray(j)) console.log(`  Journal signé : ${j.map((e) => e.type).join(' → ')}`);
console.log('');
