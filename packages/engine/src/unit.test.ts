import { describe, expect, it } from 'vitest';
import { assertAmount, formatAmount, COUNTRIES, LAUNCH_COUNTRIES, MeridianError } from '@meridian/core';
import { BUILTIN_MODULES, matches, parseModule, render } from '@meridian/modules';
import { canonical, Journal, MemoryStore } from './journal.ts';

describe('core', () => {
  it('montants : entiers en unités mineures uniquement, devises européennes', () => {
    expect(() => assertAmount(2450, 'EUR')).not.toThrow();
    expect(() => assertAmount(24.5, 'EUR')).toThrow();
    expect(() => assertAmount(0, 'EUR')).toThrow();
    try { assertAmount(100_000_000, 'EUR'); expect.unreachable(); } catch (e) { expect((e as MeridianError).code).toBe('invalid_amount'); }
    expect(() => assertAmount(99_999_999, 'EUR')).not.toThrow();
    expect(() => assertAmount(100, 'USD')).toThrow();
    expect(formatAmount(129000, 'CHF', 'de-CH')).toMatch(/1.290\.00/);
  });
  it('les 6 pays de lancement ont devise, langue, fuseau et protocole de compatibilité', () => {
    for (const c of LAUNCH_COUNTRIES) {
      const p = COUNTRIES[c]!;
      expect(p.currency).toBe('EUR');
      expect(p.locales.length).toBeGreaterThan(0);
      expect(p.compatProtocols).toContain('nexo');
    }
  });
});

describe('modules', () => {
  it('gabarits : type conservé pour un gabarit entier, interpolation sinon', () => {
    const ctx = { tx: { amount: 2450, reference: 'A B' }, vars: { id: 'pi_1' } };
    expect(render('{{tx.amount}}', ctx)).toBe(2450);
    expect(render('/x/{{vars.id}}/{{tx.reference}}', ctx)).toBe('/x/pi_1/A%20B');
    expect(render({ a: ['{{vars.id}}'] }, ctx)).toEqual({ a: ['pi_1'] });
  });
  it('règles : equals, in, exists, equalsVar', () => {
    const d = { r: { s: 'failed', c: 'card_declined' }, id: 'x' };
    expect(matches([{ path: 'r.s', equals: 'failed' }], d)).toBe(true);
    expect(matches([{ path: 'r.c', in: ['a', 'card_declined'] }], d)).toBe(true);
    expect(matches([{ path: 'r.z', exists: false }], d)).toBe(true);
    expect(matches([{ path: 'id', equalsVar: 'v' }], d, { v: 'x' })).toBe(true);
  });
  it('catalogue livré valide ; un module sans idempotence ni lookup est refusé', () => {
    expect(Object.keys(BUILTIN_MODULES)).toEqual(['stripe-terminal', 'psp-secours', 'adyen-terminal', 'stripe-tap-to-pay', 'edge-terminal', 'mollie-pos', 'square-terminal', 'sumup-solo']);
    expect(Object.values(BUILTIN_MODULES).filter((m) => m.maturity === 'available').map((m) => m.id)).toEqual(['stripe-terminal', 'psp-secours']);
    const bad = structuredClone(BUILTIN_MODULES['psp-secours']!) as Record<string, unknown>;
    delete bad.idempotency;
    expect(() => parseModule(bad)).toThrow(/idempotency ou lookup/);
  });
});

describe('journal', () => {
  it('JSON canonique indépendant de l’ordre des clés', () => {
    expect(canonical({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonical({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
  it('chaîne et signature : toute altération est détectée, ainsi qu’une mauvaise clé', async () => {
    const store = new MemoryStore();
    const j = new Journal(store, 'unit-test-key-0123456789');
    await Promise.all([1, 2, 3].map((i) => j.append({ posId: 'p', reference: `r${i}`, type: 'created', data: { i } })));
    expect(await j.verify()).toEqual({ ok: true, count: 3 });
    expect(store.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await new Journal(store, 'autre-cle-0123456789abcdef').verify()).ok).toBe(false);
    store.entries[1]!.data = { i: 99 };
    expect((await j.verify()).brokenAt).toBe(2);
  });
});

