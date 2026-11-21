import { migrate, pg } from './index.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
const applied = await migrate(pool);
console.log(applied.length ? `Migrations appliquées : ${applied.join(', ')}` : 'Base à jour');
await pool.end();
