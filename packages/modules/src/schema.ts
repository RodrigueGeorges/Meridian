import { z } from 'zod';
import { PAYMENT_METHODS } from '@meridian/core';

const Call = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/'),
  body: z.record(z.string(), z.unknown()).optional(),
  /** Réponse 2xx non JSON acceptée (ex. « ok » d'un point d'entrée asynchrone), exposée sous `_text`. */
  acceptText: z.boolean().optional(),
});
const Condition = z.object({
  path: z.string(),
  equals: z.unknown().optional(),
  in: z.array(z.unknown()).optional(),
  exists: z.boolean().optional(),
  equalsVar: z.string().optional(),
});
const Step = Call.extend({
  id: z.string().regex(/^[a-z0-9_]+$/),
  save: z.record(z.string(), z.string()).optional(),
  retryErrors: z.array(z.string()).optional(),
});

export const ModuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    kind: z.enum(['acceptance', 'acceptance_and_acquiring']).default('acceptance_and_acquiring'),
    baseUrl: z.string().url(),
    config: z.array(z.object({ key: z.string(), type: z.enum(['string', 'number', 'boolean']), secret: z.boolean().default(false), label: z.string().optional() })),
    auth: z.object({ header: z.string(), value: z.string() }).optional(),
    encoding: z.enum(['json', 'form']).default('json'),
    errorCodePath: z.string().default('error.code'),
    idempotency: z.object({ header: z.string() }).optional(),
    /** Recherche avant tout renvoi d'une étape incertaine, pour les PSP sans clé d'idempotence. */
    lookup: Call.extend({ pick: z.record(z.string(), z.string()), notFound: z.array(Condition).optional() }).optional(),
    /** Variables remises à la caisse (ex. secret client pour un paiement encaissé sur l'appareil). */
    exposeVars: z.array(z.string()).optional(),
    /** Jeton de connexion pour un SDK sur l'appareil (Tap to Pay). */
    deviceToken: Call.extend({ pick: z.string() }).optional(),
    /** preview : module écrit, non validé sur la sandbox du PSP ; utilisable en mode test seulement. */
    maturity: z.enum(['available', 'preview']).default('available'),
    pay: z.object({ steps: z.array(Step).min(1) }),
    status: z.object({
      sources: z.record(z.string(), Call),
      rules: z.array(z.object({ when: z.array(Condition).min(1), state: z.enum(['authorized', 'declined', 'cancelled', 'failed']), detailPath: z.string().optional() })),
    }),
    cancel: Call.extend({ busyCodes: z.array(z.string()).default([]) }),
    cleanup: Call.optional(),
    refund: Call,
    health: Call.optional(),
    receipt: z.record(z.string(), z.string()).optional(),
    capabilities: z.object({
      countries: z.array(z.string().length(2)).min(1),
      currencies: z.array(z.string().length(3)).min(1),
      paymentMethods: z.record(z.string(), z.array(z.enum(PAYMENT_METHODS))),
      partialRefund: z.boolean().default(true),
      cancelDuringAuth: z.boolean().default(false),
      languages: z.array(z.string()).default([]),
      compatProtocols: z.array(z.string()).default([]),
    }),
  })
  .refine((m) => Boolean(m.idempotency || m.lookup), {
    message: 'Un module doit déclarer idempotency ou lookup : sans cela, aucune garantie contre le double débit.',
  });

export type ModuleDef = z.infer<typeof ModuleSchema>;
export type StepDef = ModuleDef['pay']['steps'][number];
export type CallDef = z.infer<typeof Call>;

export function parseModule(input: unknown): ModuleDef {
  return ModuleSchema.parse(input);
}
