// Statut public par PSP, mesuré sur les paiements réels passés par Meridian.
// « Répond » = le PSP a rendu une issue (autorisé, refusé, annulé). « Ne répond pas » = échec technique,
// ou bascule vers le secours. Jamais de volume publié : seulement des taux, et rien sous MIN_SAMPLE.
import type pg from 'pg';

export const MIN_SAMPLE = 20;
const HOUR = 3_600_000;
const floorHour = (t: number) => Math.floor(t / HOUR) * HOUR;

export interface ModuleStatus {
  module: string;
  name: string;
  state: 'operational' | 'degraded' | 'down' | 'no_data';
  availability24h: number | null;
  availability90d: number | null;
  avgSeconds24h: number | null;
  /** 24 cases horaires, de la plus ancienne à la plus récente : taux de réponse, ou null si trop peu de paiements. */
  hours: (number | null)[];
}

type Row = { module: string; hour: number; ok: number; ko: number; ms: number };

export class StatusBoard {
  private mem = new Map<string, Row>();
  private cache?: { at: number; value: ModuleStatus[] };
  constructor(private readonly pool?: pg.Pool) {}

  async record(module: string, ok: boolean, ms: number, at = Date.now()): Promise<void> {
    const hour = floorHour(at);
    this.cache = undefined;
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO psp_status_hourly (module_id, hour, ok, ko, ms_sum) VALUES ($1, to_timestamp($2/1000.0), $3, $4, $5)
         ON CONFLICT (module_id, hour) DO UPDATE SET ok = psp_status_hourly.ok + EXCLUDED.ok, ko = psp_status_hourly.ko + EXCLUDED.ko, ms_sum = psp_status_hourly.ms_sum + EXCLUDED.ms_sum`,
        [module, hour, ok ? 1 : 0, ok ? 0 : 1, ok ? Math.round(ms) : 0],
      );
      return;
    }
    const k = `${module}|${hour}`;
    const r = this.mem.get(k) ?? { module, hour, ok: 0, ko: 0, ms: 0 };
    if (ok) { r.ok++; r.ms += ms; } else r.ko++;
    this.mem.set(k, r);
  }

  private async rows(since: number): Promise<Row[]> {
    if (this.pool) {
      const r = await this.pool.query('SELECT module_id, extract(epoch FROM hour)*1000 AS h, ok, ko, ms_sum FROM psp_status_hourly WHERE hour >= to_timestamp($1/1000.0)', [since]);
      return r.rows.map((x) => ({ module: x.module_id, hour: Number(x.h), ok: Number(x.ok), ko: Number(x.ko), ms: Number(x.ms_sum) }));
    }
    return [...this.mem.values()].filter((x) => x.hour >= since);
  }

  async purge(days = 90): Promise<void> {
    const limit = Date.now() - days * 24 * HOUR;
    if (this.pool) await this.pool.query('DELETE FROM psp_status_hourly WHERE hour < to_timestamp($1/1000.0)', [limit]);
    else for (const [k, v] of this.mem) if (v.hour < limit) this.mem.delete(k);
  }

  async snapshot(modules: { id: string; name: string }[], now = Date.now()): Promise<ModuleStatus[]> {
    if (this.cache && now - this.cache.at < 30_000) return this.cache.value;
    const start24 = floorHour(now) - 23 * HOUR;
    const all = await this.rows(floorHour(now) - 90 * 24 * HOUR);
    const rate = (rs: Row[]) => {
      const ok = rs.reduce((s, r) => s + r.ok, 0), ko = rs.reduce((s, r) => s + r.ko, 0);
      return ok + ko >= MIN_SAMPLE ? Math.round((ok / (ok + ko)) * 10000) / 100 : null;
    };
    const value = modules.map(({ id, name }) => {
      const mine = all.filter((r) => r.module === id);
      const last = mine.filter((r) => r.hour >= start24);
      const a24 = rate(last);
      const ok24 = last.reduce((s, r) => s + r.ok, 0);
      const hours = Array.from({ length: 24 }, (_, i) => {
        const r = last.find((x) => x.hour === start24 + i * HOUR);
        return r && r.ok + r.ko >= 5 ? Math.round((r.ok / (r.ok + r.ko)) * 1000) / 10 : null;
      });
      const lastHour = hours[23];
      const state: ModuleStatus['state'] = a24 === null ? 'no_data'
        : lastHour !== null && lastHour !== undefined && lastHour < 50 ? 'down'
        : a24 < 99 ? 'degraded' : 'operational';
      return {
        module: id, name, state, availability24h: a24, availability90d: rate(mine),
        avgSeconds24h: a24 === null || !ok24 ? null : Math.round(last.reduce((s, r) => s + r.ms, 0) / ok24 / 100) / 10,
        hours,
      };
    });
    this.cache = { at: now, value };
    return value;
  }
}
