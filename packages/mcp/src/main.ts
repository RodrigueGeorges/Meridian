#!/usr/bin/env -S npx tsx
// Lancement : MERIDIAN_API_KEY=mk_test_… MERIDIAN_URL=https://… npx tsx packages/mcp/src/main.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMeridianMcp } from './server.ts';

const apiKey = process.env.MERIDIAN_API_KEY;
if (!apiKey) {
  process.stderr.write('MERIDIAN_API_KEY manquante (clé mk_test_… conseillée).\n');
  process.exit(1);
}
await createMeridianMcp({ apiKey, baseUrl: process.env.MERIDIAN_URL ?? 'http://localhost:8080' }).connect(new StdioServerTransport());
