// Gabarits {{chemin}} et règles de correspondance des modules déclaratifs.

export function get(obj: unknown, path: string | undefined): unknown {
  if (obj == null || !path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;
const PART = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Rend une valeur : une chaîne qui n'est qu'un gabarit garde le type de la valeur. */
export function render(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE);
    if (whole) return get(ctx, whole[1]);
    return value.replace(PART, (_, p: string) => {
      const v = get(ctx, p);
      return v == null ? '' : encodeURIComponent(String(v));
    });
  }
  if (Array.isArray(value)) return value.map((v) => render(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, ctx);
    return out;
  }
  return value;
}

export interface Condition { path: string; equals?: unknown; in?: unknown[]; exists?: boolean; equalsVar?: string }

export function matches(conds: Condition[] | undefined, data: unknown, vars: Record<string, unknown> = {}): boolean {
  return (conds ?? []).every((c) => {
    const v = get(data, c.path);
    if ('equals' in c) return v === c.equals;
    if (c.equalsVar !== undefined) return v !== undefined && v === vars[c.equalsVar];
    if (c.in) return c.in.includes(v);
    if (c.exists !== undefined) return (v !== undefined && v !== null) === c.exists;
    return false;
  });
}
