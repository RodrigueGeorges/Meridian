// Rechiffre tous les secrets de points de vente avec la version de clé courante (MASTER_KEY_VERSION),
// dans une seule transaction. Les anciennes versions sont lues via MASTER_KEYS_PREVIOUS (« 1=key,2=key »).
import { pg, SecretBox } from './index.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}
const previous = Object.fromEntries((process.env.MASTER_KEYS_PREVIOUS ?? '').split(',').filter(Boolean).map((x) => {
  const i = x.indexOf('=');
  return [Number(x.slice(0, i)), x.slice(i + 1)] as [number, string];
}));
const box = new SecretBox(process.env.MASTER_KEY ?? '', { version: Number(process.env.MASTER_KEY_VERSION ?? 1), previous });

const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const r = await client.query('SELECT pos_id, module_id, config_encrypted, key_version FROM pos_module_config FOR UPDATE');
  let migrated = 0;
  for (const row of r.rows) {
    if (row.key_version === box.version) continue;
    const sealed = box.seal(box.open(row.config_encrypted, row.key_version));
    await client.query('UPDATE pos_module_config SET config_encrypted=$3, key_version=$4 WHERE pos_id=$1 AND module_id=$2',
      [row.pos_id, row.module_id, sealed.data, sealed.version]);
    migrated++;
  }
  await client.query('COMMIT');
  console.log(`Secrets rechiffrés en version ${box.version} : ${migrated} ligne(s) migrée(s) sur ${r.rows.length}.`);
} catch (e) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw e;
} finally {
  client.release();
  await pool.end();
}
