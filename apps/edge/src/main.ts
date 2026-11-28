// Lancement de l'agent du magasin.
//   TERMINAL=caisse-ap|zvt|nexo  TERMINAL_HOST=192.168.1.50  TERMINAL_PORT=8888   (nexo : TERMINAL_URL, TERMINAL_POIID, TERMINAL_SESSION=1 si le terminal exige un Login)
//   COUNTRY=FR  DATA_DIR=./meridian-edge  LOCAL_PORT=8787  LOCAL_TOKEN=…            (API locale, 127.0.0.1 seulement)
//   MERIDIAN_URL=https://…  MERIDIAN_API_KEY=mk_…  MERIDIAN_AGENT_ID=magasin-paris-1  (relais cloud, facultatif)
import { driverFromEnv, startAgent } from './agent.ts';

const env = process.env;
const cloud = env.MERIDIAN_URL && env.MERIDIAN_API_KEY && env.MERIDIAN_AGENT_ID
  ? { url: env.MERIDIAN_URL, apiKey: env.MERIDIAN_API_KEY, agentId: env.MERIDIAN_AGENT_ID }
  : undefined;
const agent = await startAgent({
  driver: driverFromEnv(env),
  dataDir: env.DATA_DIR ?? './meridian-edge',
  country: env.COUNTRY ?? 'FR',
  local: { port: Number(env.LOCAL_PORT ?? 8787), token: env.LOCAL_TOKEN || undefined },
  cloud,
});
console.log(`[meridian-edge] terminal ${agent.service.protocol} · API locale ${agent.localUrl} · cloud ${cloud ? `${cloud.url} (agent ${cloud.agentId})` : 'désactivé'}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void agent.close().then(() => process.exit(0)));
