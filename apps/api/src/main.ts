import { API_VERSION, buildServer } from './server.ts';

const env = process.env;
const required = (k: string) => {
  const v = env[k];
  if (!v) {
    console.error(`Variable d'environnement manquante : ${k}`);
    process.exit(1);
  }
  return v;
};

/** « kid=valeur,kid=valeur » → table d'anciennes clés (rotation du journal et des secrets). */
const keyMap = <T extends string | number>(cast: (s: string) => T, v?: string): Record<T, string> | undefined => {
  if (!v) return undefined;
  return Object.fromEntries(v.split(',').filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    return [cast(x.slice(0, i)), x.slice(i + 1)] as [T, string];
  })) as Record<T, string>;
};

// ---------- Garde-fous de démarrage (refus plutôt qu'un déploiement silencieusement faux) ----------
const die = (msg: string): never => { console.error(`Démarrage refusé : ${msg}`); process.exit(1); };

// Sans base, le journal est volatile : interdit en production sauf contournements explicites et bornés
// (démo éphémère, journal sur fichier, tests, ou ALLOW_EPHEMERAL=true assumé).
if (!env.DATABASE_URL && env.DEMO_SEED !== 'true' && !env.JOURNAL_FILE && env.NODE_ENV !== 'test' && env.ALLOW_EPHEMERAL !== 'true') {
  die('DATABASE_URL absent. Le mode éphémère (journal en mémoire) exige DEMO_SEED=true, JOURNAL_FILE, NODE_ENV=test ou ALLOW_EPHEMERAL=true.');
}
// Une organisation live ne cohabite jamais avec les données et simulateurs de démonstration.
if (env.DEMO_SEED === 'true' && (env.BOOTSTRAP_API_KEY ?? '').startsWith('mk_live_')) {
  die('DEMO_SEED=true avec une clé live (mk_live_…) : la démo est réservée aux clés de test.');
}

const { app } = await buildServer({
  databaseUrl: env.DATABASE_URL,
  allowPooledDatabase: env.DATABASE_POOLED_OK === 'true',
  journalFile: env.JOURNAL_FILE,
  journalKey: required('JOURNAL_KEY'),
  journalKeyId: env.JOURNAL_KEY_ID,
  journalKeysPrevious: keyMap((x) => x, env.JOURNAL_KEYS_PREVIOUS),
  masterKey: required('MASTER_KEY'),
  masterKeyVersion: env.MASTER_KEY_VERSION ? Number(env.MASTER_KEY_VERSION) : undefined,
  masterKeysPrevious: keyMap(Number, env.MASTER_KEYS_PREVIOUS),
  bootstrapKey: env.BOOTSTRAP_API_KEY,
  allowTestBaseUrl: env.ALLOW_TEST_BASE_URL === 'true',
  webhookUrl: env.WEBHOOK_URL,
  webhookSecret: env.WEBHOOK_SECRET,
  demoSeed: env.DEMO_SEED === 'true' ? { stripeUrl: required('SIM_STRIPE_URL'), secoursUrl: required('SIM_SECOURS_URL') } : undefined,
  logger: true,
  trustProxy: env.TRUST_PROXY === 'true',
  publicUrl: env.PUBLIC_URL,
  securityContact: env.SECURITY_CONTACT,
  metricsToken: env.METRICS_TOKEN,
  contactRetentionDays: env.CONTACT_RETENTION_DAYS ? Number(env.CONTACT_RETENTION_DAYS) : undefined,
  drainMs: env.DRAIN_MS ? Number(env.DRAIN_MS) : undefined,
  dbPoolMax: env.DATABASE_POOL_MAX ? Number(env.DATABASE_POOL_MAX) : undefined,
  engine: (env.SCAN_MS || env.STUCK_AFTER_MS) ? { scanMs: env.SCAN_MS ? Number(env.SCAN_MS) : undefined, stuckAfterMs: env.STUCK_AFTER_MS ? Number(env.STUCK_AFTER_MS) : undefined } : undefined,
  bridges: {
    host: env.BRIDGE_HOST,
    concertPort: env.CONCERT_PORT ? Number(env.CONCERT_PORT) : undefined,
    concertMap: Object.fromEntries((env.CONCERT_POS_MAP ?? '').split(',').filter(Boolean).map((x) => x.split('=') as [string, string])),
    zvtPort: env.ZVT_PORT ? Number(env.ZVT_PORT) : undefined,
    zvtPosId: env.ZVT_POS,
  },
});
await app.listen({ port: Number(env.PORT ?? 8080), host: '0.0.0.0' });
console.log(JSON.stringify({ event: 'boot', persistent: Boolean(env.DATABASE_URL || env.JOURNAL_FILE), demoSeed: env.DEMO_SEED === 'true', bridges: Boolean(env.CONCERT_PORT || env.ZVT_PORT), version: API_VERSION }));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => {
  // Dernier recours : un drain qui pendrait (socket oubliée) ne doit pas empêcher de mourir.
  setTimeout(() => process.exit(1), 27_000).unref();
  void app.close().then(() => process.exit(0));
});
