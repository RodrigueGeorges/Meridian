import { runTerminalDemo, TERMINAL_DEMO_INCIDENTS } from '@meridian/terminals';
const out: Record<string, unknown> = {};
for (const mode of ['local', 'cloud'] as const) for (const incident of TERMINAL_DEMO_INCIDENTS) {
  const r = await runTerminalDemo({ mode, incident });
  out[`${mode}:${incident}`] = r;
  console.error(mode, incident, r.state, r.detail, 'orders', r.orders, 'debits', r.debits, r.durationMs, r.steps.map((s) => s.kind).join(' > '));
}
process.stdout.write(JSON.stringify(out));
