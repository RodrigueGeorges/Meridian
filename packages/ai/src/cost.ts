// Coût mensuel estimé d'une activité chez chaque offre du catalogue, à partir des prix publics sourcés.
// Calcul déterministe : aucun modèle n'intervient ici. Les offres sans prix publics (interchange++, grille, devis)
// sont listées sans montant.
import { z } from 'zod';
import type { Offer } from '@meridian/modules';

export const Profile = z.object({
  country: z.string().length(2),
  /** Volume carte mensuel, en euros. */
  monthlyVolume: z.number().positive(),
  /** Nombre de paiements par mois ; à défaut, déduit du panier moyen. */
  transactions: z.number().positive().optional(),
  avgTicket: z.number().positive().optional(),
  /** Part des cartes d'entreprise (0–1). */
  businessShare: z.number().min(0).max(1).default(0.05),
  /** Part des cartes émises hors EEE (0–1). */
  nonEeaShare: z.number().min(0).max(1).default(0.05),
  terminals: z.number().int().min(1).max(500).default(1),
  /** Besoins : tap_to_pay, keep_bank, offline, local_api, online_too… */
  needs: z.array(z.string()).default([]),
});
export type Profile = z.infer<typeof Profile>;

export const Current = z.object({
  /** Total mensuel des frais actuels, s'il est connu. */
  monthlyCost: z.number().nonnegative().optional(),
  rate: z.number().nonnegative().optional(),
  fixedPerTx: z.number().nonnegative().optional(),
  monthlyFees: z.number().nonnegative().optional(),
});
export type Current = z.infer<typeof Current>;

export interface Estimate {
  id: string;
  name: string;
  roles: string[];
  monthly: number | null;
  plan?: string;
  /** Une partie des cartes est tarifée par approximation (taux absent de la grille publique). */
  approx?: boolean;
  breakdown?: { percent: number; fixed: number; subscription: number };
  reason?: 'icpp' | 'grid' | 'quote' | 'none';
  savings?: number | null;
  missing?: string[];
}

const round = (n: number) => Math.round(n * 100) / 100;
export const txCount = (p: Profile) => Math.max(1, Math.round(p.transactions ?? (p.avgTicket ? p.monthlyVolume / p.avgTicket : p.monthlyVolume / 25)));

export function currentMonthly(c: Current | undefined, p: Profile): number | null {
  if (!c) return null;
  if (c.monthlyCost !== undefined) return round(c.monthlyCost);
  if (c.rate === undefined && c.fixedPerTx === undefined) return null;
  return round(p.monthlyVolume * (c.rate ?? 0) / 100 + txCount(p) * (c.fixedPerTx ?? 0) + (c.monthlyFees ?? 0));
}

type Line = Extract<Offer['pricing'], { model: 'blended' }>['lines'][number];
const BUCKET_ORDER: Record<'consumer' | 'business' | 'other', Line['segment'][]> = {
  consumer: ['consumer', 'eea', 'all'],
  business: ['business', 'eea', 'all'],
  other: ['other', 'all'],
};

export function estimate(offers: Offer[], profile: Profile, current?: Current): { transactions: number; current: number | null; estimates: Estimate[] } {
  const p = Profile.parse(profile);
  const n = txCount(p);
  const cur = currentMonthly(current, p);
  const shares = { consumer: Math.max(0, 1 - p.businessShare - p.nonEeaShare), business: p.businessShare, other: p.nonEeaShare };
  const keepBank = p.needs.includes('keep_bank');
  const fits = (o: Offer) => o.countries.includes(p.country)
    && (keepBank ? o.features.includes('keep_bank') : o.roles.length === 2)
    && p.needs.filter((x) => x !== 'keep_bank').every((x) => o.features.includes(x));
  const out: Estimate[] = [];
  for (const o of offers.filter(fits)) {
    const base: Estimate = { id: o.id, name: o.name, roles: o.roles, monthly: null };
    if (o.pricing.model !== 'blended') { out.push({ ...base, reason: o.pricing.model }); continue; }
    const plans = [...new Set(o.pricing.lines.map((l) => l.plan).filter(Boolean))] as string[];
    let best: Estimate | undefined;
    for (const plan of plans.length ? plans : [undefined]) {
      const lines = o.pricing.lines.filter((l) => !l.plan || l.plan === plan);
      const rated = lines.filter((l) => l.rate !== undefined || l.fixed !== undefined);
      let percent = 0, fixed = 0, approx = false;
      for (const b of ['consumer', 'business', 'other'] as const) {
        if (!shares[b]) continue;
        let line = BUCKET_ORDER[b].map((s) => rated.find((l) => (l.segment ?? 'all') === s)).find(Boolean);
        if (!line) { line = [...rated].sort((x, y) => (y.rate ?? 0) - (x.rate ?? 0))[0]; approx = true; }
        if (!line) continue;
        percent += p.monthlyVolume * shares[b] * (line.rate ?? 0) / 100;
        fixed += n * shares[b] * (line.fixed ?? 0);
      }
      const subscription = lines.filter((l) => l.monthly !== undefined).reduce((s, l) => s + l.monthly! * (l.perTerminal ? p.terminals : 1), 0);
      const monthly = round(percent + fixed + subscription);
      if (!best || monthly < best.monthly!) best = { ...base, monthly, plan, approx: approx || undefined, breakdown: { percent: round(percent), fixed: round(fixed), subscription: round(subscription) } };
    }
    out.push(best!);
  }
  for (const e of out) e.savings = e.monthly !== null && cur !== null ? round(cur - e.monthly) : null;
  out.sort((a, b) => (a.monthly ?? Infinity) - (b.monthly ?? Infinity));
  return { transactions: n, current: cur, estimates: out };
}
