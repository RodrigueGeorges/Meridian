import { buildServer } from './server.ts';

const env = process.env;
const required = (k: string) => {
  const v = env[k];
  if (!v) {
    console.error(`Variable d'environnement manquante : ${k}`);
    process.exit(1);
  }
  return v;
};

const { app } = await buildServer({
  databaseUrl: env.DATABASE_URL,
  journalFile: env.JOURNAL_FILE,
  journalKey: required('JOURNAL_KEY'),
  masterKey: required('MASTER_KEY'),
  bootstrapKey: env.BOOTSTRAP_API_KEY,
  allowTestBaseUrl: env.ALLOW_TEST_BASE_URL === 'true',
  webhookUrl: env.WEBHOOK_URL,
  webhookSecret: env.WEBHOOK_SECRET,
  demoSeed: env.DEMO_SEED === 'true' ? { stripeUrl: required('SIM_STRIPE_URL'), secoursUrl: required('SIM_SECOURS_URL') } : undefined,
  logger: true,
  trustProxy: env.TRUST_PROXY === 'true',
  publicUrl: env.PUBLIC_URL,
  contactRetentionDays: env.CONTACT_RETENTION_DAYS ? Number(env.CONTACT_RETENTION_DAYS) : undefined,
  engine: env.SCAN_MS ? { scanMs: Number(env.SCAN_MS) } : undefined,
  bridges: {
    host: env.BRIDGE_HOST,
    concertPort: env.CONCERT_PORT ? Number(env.CONCERT_PORT) : undefined,
    concertMap: Object.fromEntries((env.CONCERT_POS_MAP ?? '').split(',').filter(Boolean).map((x) => x.split('=') as [string, string])),
    zvtPort: env.ZVT_PORT ? Number(env.ZVT_PORT) : undefined,
    zvtPosId: env.ZVT_POS,
  },
});
await app.listen({ port: Number(env.PORT ?? 8080), host: '0.0.0.0' });
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
