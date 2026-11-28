// Audit du site généré : liens internes, ancres, fichiers à empreinte, rôles du formulaire de contact. Usage : pnpm site:audit
import { buildSite } from './build.ts';
import { parseHTML } from 'linkedom';
const site = buildSite();
const paths = new Set(site.files.keys());
const problems: string[] = [];
let pages = 0;
for (const [p, f] of site.files) {
  if (!f.type.startsWith('text/html')) continue;
  pages++;
  const html = String(f.body).replaceAll('{{BASE}}', '');
  const { document } = parseHTML(html);
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href')!;
    if (h.startsWith('/') && !h.startsWith('//')) { const u = h.split('#')[0]!.split('?')[0]!; if (!paths.has(u) && !site.redirects.has(u) && !u.startsWith('/portal/') && !u.startsWith('/v1/') && !u.startsWith('/.well-known/')) problems.push(`${p}: lien cassé ${h}`); }
    if (h.startsWith('#') && h.length > 1 && !['#main', '#calc'].includes(h) && !document.getElementById(h.slice(1))) problems.push(`${p}: ancre absente ${h}`);
  }
  for (const i of document.querySelectorAll('img[src], link[href], script[src]')) {
    const s = i.getAttribute('src') ?? i.getAttribute('href')!;
    if (s.startsWith('/assets/') && !paths.has(s)) problems.push(`${p}: asset manquant ${s}`);
    if (!s.startsWith('/') && !s.startsWith('http') && !s.startsWith('data:') && i.tagName !== 'LINK') problems.push(`${p}: chemin relatif ${s}`);
  }
  for (const b of document.querySelectorAll('[data-contact]')) {
    const r = b.getAttribute('data-contact');
    if (r !== 'other' && document.querySelector('dialog#contact') && !document.querySelector(`input[name=role][value=${r}]`)) problems.push(`${p}: rôle de contact absent ${r}`);
  }
  const h = document.documentElement;
  if (h.getAttribute('data-page') !== '404' && !h.getAttribute('data-recorded-terminal')) problems.push(`${p}: data-recorded-terminal absent`);
}
console.log(JSON.stringify({ pages, files: paths.size, problems }, null, 1));
