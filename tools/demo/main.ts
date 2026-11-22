// Démo locale en une commande : simulateurs PSP + API + site + passerelles Concert et ZVT, en mémoire.
// Usage : pnpm demo   (puis ouvrir http://localhost:8080/fr/)
import { startSims } from '@meridian/sim';
import { buildServer } from '../../apps/api/src/server.ts';
import { startAgent } from '../../apps/edge/src/agent.ts';
import { CaisseApDriver, startTerminalSims } from '@meridian/terminals';

const PORT = Number(process.env.PORT ?? 8080);
const sims = await startSims({ stripePort: 12111, secoursPort: 12112 });
const { app } = await buildServer({
  journalKey: 'demo-journal-key-0123456789',
  masterKey: 'demo-master-key-0123456789abcdef0123456789',
  bootstrapKey: 'mk_test_demo0123456789abcdef',
  allowTestBaseUrl: true,
  demoSeed: { stripeUrl: sims.stripeUrl, secoursUrl: sims.secoursUrl },
  metricsToken: 'demo',
  bridges: { host: '127.0.0.1', concertPort: 8888, concertMap: { '01': 'pos_demo_FR' }, zvtPort: 20007, zvtPosId: 'pos_demo_DE' },
});
await app.listen({ port: PORT, host: '127.0.0.1' });
const u = `http://localhost:${PORT}`;

// TPE du magasin simulé (Caisse-AP sur IP) et agent Meridian : API locale sur 8787, relais vers l'API cloud.
const KEY = 'mk_test_demo0123456789abcdef';
const tpe = await startTerminalSims({ delayMs: 1200 });
const agent = await startAgent({
  driver: new CaisseApDriver({ host: '127.0.0.1', port: tpe.caisseAp.port }),
  local: { port: 8787 }, cloud: { url: `http://127.0.0.1:${PORT}`, apiKey: KEY, agentId: 'magasin-demo' },
});
await agent.ready;
const h = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
if ((await fetch(`${u}/v1/pos/pos_demo_TPE`, { headers: h })).status === 404) {
  await fetch(`${u}/v1/pos`, { method: 'POST', headers: h, body: JSON.stringify({ id: 'pos_demo_TPE', label: 'Magasin démo · TPE via agent', country: 'FR' }) });
}
await fetch(`${u}/v1/pos/pos_demo_TPE/psp`, { method: 'PUT', headers: h, body: JSON.stringify({ primary: { moduleId: 'edge-terminal', config: { agentId: 'magasin-demo' } } }) });
console.log(`
  Meridian — démo locale prête

  Site (FR)            ${u}/fr/
  Démo de panne        ${u}/fr/demo/
  Éditeurs / PSP       ${u}/fr/editeurs/   ${u}/fr/psp/
  Console              ${u}/portal/console.html   clé : mk_test_demo0123456789abcdef
  Caisse Concert       pnpm caisse 24.50            (passerelle Caisse-AP sur le port 8888)
  Caisse Concert + panne  pnpm caisse 24.50 --panne
  TPE local (caisse installée)   pnpm tpe 24.50 --local   (API locale de l'agent, 127.0.0.1:8787)
  TPE via le cloud (caisse SaaS) pnpm tpe 24.50 --cloud   (API Meridian → agent → TPE)

  Ctrl+C pour arrêter.
`);
const stop = async () => { await agent.close(); await app.close(); await sims.close(); await tpe.close(); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
