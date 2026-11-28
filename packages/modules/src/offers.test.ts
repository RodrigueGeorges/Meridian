import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, OFFERS } from './index.ts';

describe('fiches du catalogue', () => {
  it('chaque fiche pointe vers un connecteur existant et porte une source datée pour ses prix publics', () => {
    for (const o of OFFERS) {
      if (o.module) expect(BUILTIN_MODULES[o.module], o.id).toBeDefined();
      if (o.pricing.model === 'blended') expect(o.pricing.checkedAt, o.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('les prix affichés sur le site sont ceux des fiches', () => {
    const html = readFileSync(new URL('../../../apps/portal/public/index.html', import.meta.url), 'utf8');
    const rows = [...html.matchAll(/<b>([^<]+)<\/b><small>.*?<span class="pr" data-rate="([\d.]+)"(?: data-fixed="([\d.]+)")?/g)];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const [, name, rate, fixed] of rows) {
      const o = OFFERS.find((x) => name!.startsWith(x.name))!;
      expect(o, name).toBeDefined();
      const line = o.pricing.model === 'blended' ? o.pricing.lines[0]! : undefined;
      expect(line?.rate, name).toBe(Number(rate));
      if (fixed) expect(line?.fixed, name).toBe(Number(fixed));
    }
  });
});
