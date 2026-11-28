// Brouillon de module PSP à partir de sa documentation publique (outil interne, Mistral Medium par défaut).
//   MISTRAL_API_KEY=… pnpm module:draft --id psp-exemple --name "PSP Exemple" --doc doc.md [--countries FR,BE]
// Écrit packages/modules/catalog/drafts/<id>.json, en « preview ». Avant publication : relecture humaine,
// puis les 8 scénarios de panne sur la sandbox du PSP (pnpm sandbox), comme pour tout module.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { draftModule, llmFromEnv } from '@meridian/ai';

const { values } = parseArgs({ options: { id: { type: 'string' }, name: { type: 'string' }, doc: { type: 'string' }, countries: { type: 'string' } } });
if (!values.id || !values.name || !values.doc) {
  console.error('Usage : pnpm module:draft --id <id> --name "<nom>" --doc <fichier de documentation> [--countries FR,BE]');
  process.exit(2);
}
const llm = llmFromEnv(process.env, { onUsage: (u) => console.error(`modèle ${u.model} · ${u.inputTokens} + ${u.outputTokens} jetons · ${u.ms} ms`) });
const r = await draftModule(llm, { id: values.id, name: values.name, doc: readFileSync(values.doc, 'utf8'), countries: values.countries?.split(',') }).catch((e: Error) => {
  console.error(`Échec : ${e.message}`);
  process.exit(1);
});
const dir = new URL('../../packages/modules/catalog/drafts/', import.meta.url);
mkdirSync(dir, { recursive: true });
const out = new URL(`${values.id}.json`, dir);
writeFileSync(out, `${JSON.stringify({ ...r.raw as object, id: values.id, maturity: 'preview' }, null, 2)}\n`);
console.log(`Brouillon valide écrit : ${out.pathname}`);
if (r.todo.length) console.log(`À vérifier :\n- ${r.todo.join('\n- ')}`);
console.log('Étapes suivantes : relecture, scénarios de panne sur la sandbox du PSP, puis ajout dans packages/modules/src/index.ts.');
