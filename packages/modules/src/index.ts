import stripe from '../catalog/stripe-terminal.json' with { type: 'json' };
import secours from '../catalog/psp-secours.json' with { type: 'json' };
import { parseModule, type ModuleDef } from './schema.ts';

export * from './schema.ts';
export * from './template.ts';
export * from './http.ts';
export * from './runtime.ts';

/** Catalogue des modules livrés avec le dépôt (validés au chargement). */
export const BUILTIN_MODULES: Record<string, ModuleDef> = Object.fromEntries(
  [stripe, secours].map((m) => {
    const def = parseModule(m);
    return [def.id, def];
  }),
);
