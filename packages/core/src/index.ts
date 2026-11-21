// Types et référentiels partagés : pays, devises, moyens de paiement, états.

export const FINAL_STATES = ['authorized', 'declined', 'cancelled', 'failed'] as const;
export type FinalState = (typeof FINAL_STATES)[number];
export type PaymentState = 'created' | 'pending' | FinalState;
export const isFinal = (s: string): s is FinalState => (FINAL_STATES as readonly string[]).includes(s);

// ---------- Devises (ISO 4217) : montants toujours en unités mineures entières ----------
export const CURRENCIES = {
  EUR: 2, CHF: 2, GBP: 2, SEK: 2, DKK: 2, NOK: 2, PLN: 2, CZK: 2,
} as const;
export type Currency = keyof typeof CURRENCIES;
export const isCurrency = (c: string): c is Currency => c in CURRENCIES;

export function assertAmount(amount: unknown, currency: string): asserts amount is number {
  if (!isCurrency(currency)) throw new MeridianError('unsupported_currency', `Devise non prise en charge : ${currency}`, 400);
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    throw new MeridianError('invalid_amount', 'Le montant doit être un entier strictement positif en unités mineures', 400);
  }
}

export function formatAmount(amount: number, currency: Currency, locale = 'fr-FR'): string {
  const d = CURRENCIES[currency];
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 10 ** d);
}

// ---------- Moyens de paiement ----------
export const PAYMENT_METHODS = [
  'visa', 'mastercard', 'amex', 'maestro',
  'cb', 'bancontact', 'girocard', 'pagobancomat', 'twint', 'bizum', 'wero',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// ---------- Pays de lancement ----------
export interface CountryProfile {
  code: string;
  name: Record<string, string>;
  currency: Currency;
  locales: string[];
  localSchemes: PaymentMethod[];
  compatProtocols: string[];
  fiscalRegime: string;
  timezone: string;
}

export const COUNTRIES: Record<string, CountryProfile> = {
  FR: { code: 'FR', name: { fr: 'France', en: 'France', de: 'Frankreich', es: 'Francia', it: 'Francia', nl: 'Frankrijk' }, currency: 'EUR', locales: ['fr-FR'], localSchemes: ['cb'], compatProtocols: ['concert', 'nexo'], fiscalRegime: 'NF525 / LNE', timezone: 'Europe/Paris' },
  BE: { code: 'BE', name: { fr: 'Belgique', en: 'Belgium', de: 'Belgien', es: 'Bélgica', it: 'Belgio', nl: 'België' }, currency: 'EUR', locales: ['fr-BE', 'nl-BE'], localSchemes: ['bancontact'], compatProtocols: ['nexo'], fiscalRegime: 'SCU (horeca)', timezone: 'Europe/Brussels' },
  NL: { code: 'NL', name: { fr: 'Pays-Bas', en: 'Netherlands', de: 'Niederlande', es: 'Países Bajos', it: 'Paesi Bassi', nl: 'Nederland' }, currency: 'EUR', locales: ['nl-NL'], localSchemes: ['wero'], compatProtocols: ['nexo'], fiscalRegime: 'à vérifier', timezone: 'Europe/Amsterdam' },
  DE: { code: 'DE', name: { fr: 'Allemagne', en: 'Germany', de: 'Deutschland', es: 'Alemania', it: 'Germania', nl: 'Duitsland' }, currency: 'EUR', locales: ['de-DE'], localSchemes: ['girocard'], compatProtocols: ['zvt', 'nexo'], fiscalRegime: 'KassenSichV (TSE)', timezone: 'Europe/Berlin' },
  ES: { code: 'ES', name: { fr: 'Espagne', en: 'Spain', de: 'Spanien', es: 'España', it: 'Spagna', nl: 'Spanje' }, currency: 'EUR', locales: ['es-ES'], localSchemes: ['bizum'], compatProtocols: ['nexo'], fiscalRegime: 'VeriFactu / TicketBAI', timezone: 'Europe/Madrid' },
  IT: { code: 'IT', name: { fr: 'Italie', en: 'Italy', de: 'Italien', es: 'Italia', it: 'Italia', nl: 'Italië' }, currency: 'EUR', locales: ['it-IT'], localSchemes: ['pagobancomat'], compatProtocols: ['ecr17', 'nexo'], fiscalRegime: 'Registratore telematico', timezone: 'Europe/Rome' },
  AT: { code: 'AT', name: { fr: 'Autriche', en: 'Austria', de: 'Österreich', es: 'Austria', it: 'Austria', nl: 'Oostenrijk' }, currency: 'EUR', locales: ['de-AT'], localSchemes: [], compatProtocols: ['zvt', 'nexo'], fiscalRegime: 'RKSV', timezone: 'Europe/Vienna' },
  CH: { code: 'CH', name: { fr: 'Suisse', en: 'Switzerland', de: 'Schweiz', es: 'Suiza', it: 'Svizzera', nl: 'Zwitserland' }, currency: 'CHF', locales: ['de-CH', 'fr-CH', 'it-CH'], localSchemes: ['twint'], compatProtocols: ['zvt', 'nexo'], fiscalRegime: '—', timezone: 'Europe/Zurich' },
};
export const LAUNCH_COUNTRIES = ['FR', 'BE', 'NL', 'DE', 'ES', 'IT'] as const;

// ---------- Erreurs ----------
export class MeridianError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

// ---------- Journal ----------
export type JournalType =
  | 'created' | 'step' | 'network_error' | 'fallback' | 'cancel_requested' | 'cancel_sent'
  | 'cancel_refused' | 'recovered' | 'final' | 'refund' | 'activate';

export interface JournalEntryInput {
  posId: string;
  reference: string;
  type: JournalType;
  data: Record<string, unknown>;
}
export interface JournalEntry extends JournalEntryInput {
  seq: number;
  ts: string;
  prev: string;
  hash: string;
  sig: string;
}

export interface Receipt {
  reference: string;
  posId: string;
  amount: number;
  currency: Currency;
  module: string;
  state: PaymentState;
  brand?: string;
  last4?: string;
  proof: { seq: number; hash: string; signature: string; at: string };
}
