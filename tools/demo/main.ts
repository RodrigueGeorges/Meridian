// Démo locale en une commande : simulateurs PSP + API + site + passerelles Concert et ZVT, en mémoire.
// Usage : pnpm demo   (puis ouvrir http://localhost:8080/fr/)
import { startSims } from '@meridian/sim';
import { buildServer } from '../../apps/api/src/server.ts';

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
console.log(`
  Meridian — démo locale prête

  Site (FR)            ${u}/fr/
  Démo de panne        ${u}/fr/demo/
  Éditeurs / PSP       ${u}/fr/editeurs/   ${u}/fr/psp/
  Console              ${u}/portal/console.html   clé : mk_test_demo0123456789abcdef
  Caisse Concert       pnpm caisse 24.50            (passerelle Caisse-AP sur le port 8888)
  Caisse Concert + panne  pnpm caisse 24.50 --panne

  Ctrl+C pour arrêter.
`);
const stop = async () => { await app.close(); await sims.close(); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
