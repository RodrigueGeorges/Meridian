// Fiches du catalogue : rôle (acceptation, acquisition), prix publics sourcés et datés, terminaux, ouverture de compte.
// Le connecteur (module) dit si Meridian sait brancher l'offre ; la fiche dit ce que le marchand compare pour choisir.
import { z } from 'zod';
import data from '../catalog/offers.json' with { type: 'json' };

const Line = z.object({
  key: z.string(),
  /** Cartes concernées : toutes, EEE, hors EEE, particuliers, entreprises. */
  segment: z.enum(['all', 'eea', 'other', 'consumer', 'business']).optional(),
  /** Formule tarifaire (ex. sans abonnement / avec abonnement) ; les lignes sans formule s'appliquent à toutes. */
  plan: z.string().optional(),
  rate: z.number().nonnegative().optional(), fixed: z.number().nonnegative().optional(), monthly: z.number().nonnegative().optional(),
  /** Abonnement facturé par terminal actif. */
  perTerminal: z.boolean().optional(),
})
  .refine((l) => l.rate !== undefined || l.fixed !== undefined || l.monthly !== undefined, 'ligne de prix vide');
const Offer = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  module: z.string().nullable(),
  roles: z.array(z.enum(['acceptance', 'acquiring'])).min(1),
  countries: z.array(z.string().length(2)).min(1),
  features: z.array(z.string()),
  terminals: z.array(z.object({ name: z.string(), price: z.number().positive().optional() })),
  pricing: z.discriminatedUnion('model', [
    z.object({ model: z.literal('blended'), country: z.string().length(2).optional(), lines: z.array(Line).min(1), note: z.string().optional(), source: z.string().url(), checkedAt: z.string().date() }),
    z.object({ model: z.literal('icpp'), source: z.string().url(), checkedAt: z.string().date() }),
    z.object({ model: z.literal('grid'), source: z.string().url(), checkedAt: z.string().date() }),
    z.object({ model: z.literal('quote') }),
    z.object({ model: z.literal('none') }),
  ]),
  /** Page du PSP où le marchand ouvre son compte (la vérification d'identité reste chez le PSP). */
  account: z.string().url().nullable(),
});
export type Offer = z.infer<typeof Offer>;
export const OFFERS: Offer[] = z.object({ offers: z.array(Offer) }).parse(data).offers;
