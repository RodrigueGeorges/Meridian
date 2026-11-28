// Générateur du site public : pages pré-rendues par langue (texte dans le HTML, indexable sans JavaScript),
// URL localisées, hreflang, canonical, Open Graph, JSON-LD, fichiers à empreinte (cache d'un an).
// Source : public/index.html (gabarit unique, aussi utilisé tel quel en aperçu), i18n/site/*.json, content/*.
// Le jeton {{BASE}} (URL absolue du site) est remplacé au moment de servir la page.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

export const LANGS = ['fr', 'en', 'de', 'es', 'it', 'nl'] as const;
export type Lang = (typeof LANGS)[number];
const MAIN = ['home', 'software', 'resellers', 'psp', 'demo'] as const;
type MainId = (typeof MAIN)[number];
const SLUG: Record<Exclude<MainId, 'home'>, Record<Lang, string>> = {
  software: { fr: 'editeurs', en: 'pos-software', de: 'kassensoftware', es: 'software-tpv', it: 'software-cassa', nl: 'kassasoftware' },
  resellers: { fr: 'distributeurs', en: 'resellers', de: 'haendler', es: 'distribuidores', it: 'distributori', nl: 'resellers' },
  psp: { fr: 'psp', en: 'psp', de: 'psp', es: 'psp', it: 'psp', nl: 'psp' },
  demo: { fr: 'demo', en: 'demo', de: 'demo', es: 'demo', it: 'demo', nl: 'demo' },
};
const OG_LOCALE: Record<Lang, string> = { fr: 'fr_FR', en: 'en_GB', de: 'de_DE', es: 'es_ES', it: 'it_IT', nl: 'nl_NL' };
const TITLE_KEY: Record<Exclude<MainId, 'home'>, [string, string]> = {
  software: ['sw.title', 'sw.lede'], resellers: ['v11.res.title', 'v11.res.lede'], psp: ['v11.psp.title', 'psp.lede'], demo: ['v11.demo.title', 'v11.demo.lede'],
};

interface SecPage { id: string; slug: { fr: string; en: string }; title: { fr: string; en: string }; desc: { fr: string; en: string }; todo?: boolean }
export interface SiteFile { body: string | Buffer; type: string; cache: string }
export interface SitePage { path: string; alternates: Record<string, string> }
export interface Site { files: Map<string, SiteFile>; pages: SitePage[]; redirects: Map<string, string>; notFound: (lang: Lang) => string }

const root = dirname(fileURLToPath(import.meta.url));
const pub = join(root, 'public');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const HTML_CACHE = 'no-cache';
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 10);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildSite(): Site {
  const files = new Map<string, SiteFile>();
  const redirects = new Map<string, string>();
  const pages: SitePage[] = [];
  const asset = (name: string, body: string | Buffer, type: string) => {
    const dot = name.lastIndexOf('.');
    const p = `/assets/${name.slice(0, dot)}.${hash(body)}${name.slice(dot)}`;
    files.set(p, { body, type, cache: IMMUTABLE });
    return p;
  };

  // ---------- Fichiers statiques ----------
  const logos: Record<string, string> = {};
  for (const f of readdirSync(join(pub, 'logos'))) logos[`logos/${f}`] = asset(`logos/${f}`, readFileSync(join(pub, 'logos', f), 'utf8'), 'image/svg+xml');
  for (const f of readdirSync(join(pub, 'fonts'))) {
    files.set(`/assets/fonts/${f}`, { body: readFileSync(join(pub, 'fonts', f)), type: 'font/woff2', cache: IMMUTABLE });
  }
  const css = asset('site.css', readFileSync(join(pub, 'site.css'), 'utf8'), 'text/css; charset=utf-8');
  const fonts = asset('fonts.css', readFileSync(join(pub, 'fonts.css'), 'utf8'), 'text/css; charset=utf-8');
  const js = asset('site.js', readFileSync(join(pub, 'site.js'), 'utf8'), 'text/javascript; charset=utf-8');
  const recorded = asset('demo-recorded.json', readFileSync(join(pub, 'demo-recorded.json'), 'utf8'), 'application/json; charset=utf-8');
  const recordedTerminal = asset('demo-terminal-recorded.json', readFileSync(join(pub, 'demo-terminal-recorded.json'), 'utf8'), 'application/json; charset=utf-8');
  const recordedStatement = asset('demo-statement-recorded.json', readFileSync(join(pub, 'demo-statement-recorded.json'), 'utf8'), 'application/json; charset=utf-8');
  const samples: Record<string, string> = {};
  for (const f of readdirSync(join(pub, 'exemples'))) samples[`exemples/${f}`] = asset(`exemples/${f}`, readFileSync(join(pub, 'exemples', f), 'utf8'), 'text/plain; charset=utf-8');
  files.set('/apple-touch-icon.png', { body: readFileSync(join(pub, 'apple-touch-icon.png')), type: 'image/png', cache: 'public, max-age=86400' });
  const og: Record<string, string> = {};
  for (const l of LANGS) og[l] = asset(`og-${l}.png`, readFileSync(join(pub, `og-${l}.png`)), 'image/png');

  const dicts = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readFileSync(join(pub, 'i18n', 'site', `${l}.json`), 'utf8')) as Record<string, string>])) as Record<Lang, Record<string, string>>;
  const sec: SecPage[] = JSON.parse(readFileSync(join(root, 'content', 'pages.json'), 'utf8'));
  const secById = Object.fromEntries(sec.map((p) => [p.id, p]));

  // ---------- URL ----------
  const mainUrl = (l: Lang, id: MainId) => (id === 'home' ? `/${l}/` : `/${l}/${SLUG[id][l]}/`);
  const secLang = (l: Lang): 'fr' | 'en' => (l === 'fr' ? 'fr' : 'en');
  const secUrl = (l: Lang, id: string) => { const p = secById[id]!; const s = secLang(l); return `/${s}/${p.slug[s]}/`; };
  const url = (l: Lang, id: string) => ((MAIN as readonly string[]).includes(id) ? mainUrl(l, id as MainId) : secUrl(l, id));

  // Dictionnaires servis au navigateur : liens internes rendus absolus.
  const dictUrl: Record<string, string> = {};
  for (const l of LANGS) {
    const d = { ...dicts[l], 'ct.legal': dicts[l]['ct.legal']!.replace(/href="[^"]*"/, `href="${url(l, 'privacy')}"`) };
    dicts[l] = d;
    dictUrl[l] = asset(`i18n-${l}.json`, JSON.stringify(d), 'application/json; charset=utf-8');
  }

  const template = readFileSync(join(pub, 'index.html'), 'utf8');

  // ---------- Enveloppe commune (en-tête, pied, contact, métadonnées) ----------
  function shell(l: Lang, page: string, alternates: Record<string, string>, meta: { title: string; desc: string }) {
    const { document } = parseHTML(template);
    const d = dicts[l];
    const h = document.documentElement;
    h.setAttribute('lang', l);
    h.setAttribute('data-static', '1');
    h.setAttribute('data-page', page);
    h.setAttribute('data-dict', dictUrl[l]!);
    h.setAttribute('data-recorded', recorded);
    h.setAttribute('data-recorded-terminal', recordedTerminal);
    h.setAttribute('data-recorded-statement', recordedStatement);
    // i18n
    for (const el of document.querySelectorAll('[data-i18n]')) { const v = d[el.getAttribute('data-i18n')!]; if (v !== undefined) el.textContent = v; }
    for (const el of document.querySelectorAll('[data-i18n-html]')) { const v = d[el.getAttribute('data-i18n-html')!]; if (v !== undefined) el.innerHTML = v; }
    for (const el of document.querySelectorAll('[data-i18n-ph]')) { const v = d[el.getAttribute('data-i18n-ph')!]; if (v !== undefined) el.setAttribute('placeholder', v); }
    for (const el of document.querySelectorAll('[data-i18n-aria]')) { const v = d[el.getAttribute('data-i18n-aria')!]; if (v !== undefined) el.setAttribute('aria-label', v); }
    (document.querySelector(`#lang option[value="${l}"]`) as Element | null)?.setAttribute('selected', '');
    // liens internes
    for (const a of document.querySelectorAll('a[href^="#"]')) {
      const id = a.getAttribute('href')!.slice(1);
      if ((MAIN as readonly string[]).includes(id)) a.setAttribute('href', mainUrl(l, id as MainId));
    }
    for (const a of document.querySelectorAll('a[href*="github.com"]')) a.setAttribute('href', url(l, 'developers'));
    for (const img of document.querySelectorAll('img[src^="logos/"]')) img.setAttribute('src', logos[img.getAttribute('src')!]!);
    for (const a of document.querySelectorAll('a[href="console.html"]')) a.setAttribute('href', '/portal/console.html');
    for (const a of document.querySelectorAll('a[href^="exemples/"]')) a.setAttribute('href', samples[a.getAttribute('href')!]!);
    for (const a of document.querySelectorAll('.nav a')) {
      if (a.getAttribute('href') === alternates[l]) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    // pied de page
    const en = (id: string) => (l !== 'fr' && l !== 'en' && !(MAIN as readonly string[]).includes(id) ? ' hreflang="en"' : '');
    const link = (id: string, label: string) => `<a href="${url(l, id)}"${en(id)}>${esc(label)}</a>`;
    const cols = document.createElement('div');
    cols.className = 'ft-cols';
    cols.innerHTML = `<nav aria-label="${esc(d['ft.h.product']!)}"><p class="ft-h">${esc(d['ft.h.product']!)}</p>${link('software', d['nav.software']!)}${link('resellers', d['v11.nav.res']!)}${link('psp', d['nav.psp']!)}${link('demo', d['nav.demo']!)}${link('developers', d['nav.docs']!)}${link('security', d['ft.l.security']!)}${link('stripe', d['ft.l.stripe']!)}${link('status', d['ft.l.status']!)}</nav>`
      + `<nav aria-label="${esc(d['ft.h.protocols']!)}"><p class="ft-h">${esc(d['ft.h.protocols']!)}</p>${link('concert', 'Concert (Caisse-AP)')}${link('zvt', 'ZVT')}${link('nexo', 'nexo Retailer')}</nav>`
      + `<nav aria-label="${esc(d['ft.l.nav']!)}"><p class="ft-h">${esc(d['ft.l.nav']!)}</p>${link('legal', d['ft.l.notice']!)}${link('privacy', d['ft.l.privacy']!)}${link('accessibility', d['ft.l.a11y']!)}${link('contact', d['ft.l.contact']!)}</nav>`
      + (d['ft.en'] ? `<p class="ft-small ft-note">${esc(d['ft.l.security']!)}, ${esc(d['nav.docs']!)}, ${esc(d['ft.h.protocols']!)} : ${esc(d['ft.en']!)}</p>` : '');
    document.querySelector('.ft-links')!.replaceWith(cols);
    // en-tête HTML
    const head = document.head;
    for (const el of head.querySelectorAll('link[rel=canonical], link[rel=alternate], meta[property^="og:"], meta[name^="twitter:"], link[rel=apple-touch-icon], script[type="application/ld+json"]')) el.remove();
    head.querySelector('title')!.textContent = meta.title;
    head.querySelector('meta[name=description]')!.setAttribute('content', meta.desc);
    head.querySelector('link[href="fonts.css"]')!.setAttribute('href', fonts);
    head.querySelector('link[href="site.css"]')!.setAttribute('href', css);
    const pre = head.querySelector('link[rel=preload]');
    pre?.setAttribute('href', `/assets/${pre.getAttribute('href')}`);
    document.querySelector('script[src="site.js"]')!.setAttribute('src', js);
    const self = alternates[l]!;
    let extra = `<link rel="canonical" href="{{BASE}}${self}">\n`;
    for (const [hl, p] of Object.entries(alternates)) extra += `<link rel="alternate" hreflang="${hl}" href="{{BASE}}${p}">\n`;
    extra += `<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n`
      + `<meta property="og:type" content="website">\n<meta property="og:site_name" content="Meridian">\n`
      + `<meta property="og:title" content="${esc(meta.title)}">\n<meta property="og:description" content="${esc(meta.desc)}">\n`
      + `<meta property="og:url" content="{{BASE}}${self}">\n<meta property="og:image" content="{{BASE}}${og[l]}">\n`
      + `<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n`
      + `<meta property="og:image:alt" content="${esc(d['meta.title']!)}">\n<meta property="og:locale" content="${OG_LOCALE[l]}">\n`
      + `<meta name="twitter:card" content="summary_large_image">\n`;
    const ld: unknown[] = [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Meridian', url: '{{BASE}}/', logo: '{{BASE}}/apple-touch-icon.png' }];
    head.insertAdjacentHTML('beforeend', extra);
    return { document, ld };
  }
  const finish = (document: Document, ld: unknown[]) => {
    const s = document.createElement('script');
    s.setAttribute('type', 'application/ld+json');
    s.textContent = JSON.stringify(ld.length === 1 ? ld[0] : ld).replace(/</g, '\\u003c');
    document.head.append(s);
    document.head.innerHTML = document.head.innerHTML.replace(/\n(\s*\n)+/g, '\n');
    return `<!doctype html>\n${document.documentElement.outerHTML}\n`;
  };
  const page = (path: string, html: string, alternates: Record<string, string>) => {
    files.set(path, { body: html, type: 'text/html; charset=utf-8', cache: HTML_CACHE });
    pages.push({ path, alternates });
  };

  // ---------- 5 pages × 6 langues ----------
  for (const id of MAIN) {
    const alternates: Record<string, string> = Object.fromEntries(LANGS.map((l) => [l, mainUrl(l, id)]));
    alternates['x-default'] = id === 'home' ? '/' : mainUrl('en', id);
    for (const l of LANGS) {
      const d = dicts[l];
      const meta = id === 'home' ? { title: d['meta.title']!, desc: d['meta.desc']! }
        : { title: `${d[TITLE_KEY[id][0]]!.replace(/[.。]$/, '')} | Meridian`, desc: d[TITLE_KEY[id][1]]! };
      const { document, ld } = shell(l, id, alternates, meta);
      for (const v of document.querySelectorAll('.view')) {
        if (v.getAttribute('data-view') === id) v.removeAttribute('hidden'); else v.remove();
      }
      if (id === 'home') {
        ld.push({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Meridian', url: '{{BASE}}/', inLanguage: l });
        const qa = [...document.querySelectorAll('.faq details')].map((x) => ({
          '@type': 'Question', name: x.querySelector('summary')!.textContent!.trim(),
          acceptedAnswer: { '@type': 'Answer', text: x.querySelector('p')!.textContent!.trim() },
        }));
        if (qa.length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa });
      }
      page(mainUrl(l, id), finish(document, ld), alternates);
    }
  }

  // ---------- Pages complémentaires (FR, EN) ----------
  for (const p of sec) {
    const alternates = { fr: `/fr/${p.slug.fr}/`, en: `/en/${p.slug.en}/`, 'x-default': `/en/${p.slug.en}/` };
    for (const l of ['fr', 'en'] as const) {
      const d = dicts[l];
      const { document, ld } = shell(l, p.id, alternates, { title: `${p.title[l]} | Meridian`, desc: p.desc[l] });
      let body = readFileSync(join(root, 'content', `${p.id}.${l}.html`), 'utf8')
        .replace(/\{\{url:(\w+)\}\}/g, (_, id: string) => url(l, id))
        .replace(/\[\[(.+?)\]\]/g, '<mark class="todo">$1</mark>');
      const dlg = document.querySelector('dialog#contact')!;
      if (body.includes('{{form}}')) {
        const form = dlg.querySelector('form')!;
        form.removeAttribute('method');
        form.querySelector('.ct-x')?.remove();
        form.querySelector('h2')?.remove();
        form.querySelector('.ct-sub')?.remove();
        form.classList.add('ct-inline');
        body = body.replace('{{form}}', `<section class="ct-page">${form.outerHTML}</section>`);
        dlg.remove();
      }
      for (const v of document.querySelectorAll('.view')) v.remove();
      const todo = p.todo ? `<p class="legal-draft" role="note">${esc(d['legal.draft']!)}</p>` : '';
      document.querySelector('main')!.insertAdjacentHTML('beforeend',
        `<div class="wrap legal"><h1>${esc(p.title[l])}</h1><p class="legal-upd">${esc(d['legal.upd']!)}</p>${todo}${body}</div>`);
      page(alternates[l], finish(document, ld), alternates);
    }
  }

  // ---------- 404 par langue ----------
  const nf: Partial<Record<Lang, string>> = {};
  for (const l of LANGS) {
    const d = dicts[l];
    const { document, ld } = shell(l, '404', { [l]: `/${l}/` }, { title: `${d['nf.h']} | Meridian`, desc: d['nf.p']! });
    for (const v of document.querySelectorAll('.view')) v.remove();
    document.head.querySelector('link[rel=canonical]')?.remove();
    for (const el of document.head.querySelectorAll('link[rel=alternate]')) el.remove();
    document.head.insertAdjacentHTML('beforeend', '<meta name="robots" content="noindex">');
    document.querySelector('main')!.insertAdjacentHTML('beforeend',
      `<div class="wrap legal nf"><h1>${esc(d['nf.h']!)}</h1><p class="legal-lede">${esc(d['nf.p']!)}</p><p><a class="btn" href="/${l}/">${esc(d['nf.home']!)}</a></p></div>`);
    nf[l] = finish(document, ld);
  }

  // ---------- Redirections des anciennes adresses ----------
  redirects.set('/portal/', '/');
  redirects.set('/portal/index.html', '/');
  for (const p of sec) {
    redirects.set(`/portal/${p.slug.fr}.html`, `/fr/${p.slug.fr}/`);
    redirects.set(`/portal/${p.slug.en}.html`, `/en/${p.slug.en}/`);
  }
  for (const pg of pages) redirects.set(pg.path.replace(/\/$/, ''), pg.path);

  return { files, pages, redirects, notFound: (l) => nf[l] ?? nf.en! };
}

/** Langue préférée d'après Accept-Language, parmi les six du site ; anglais par défaut. */
export function pickLang(accept: string | undefined): Lang {
  for (const part of (accept ?? '').split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if ((LANGS as readonly string[]).includes(code)) return code as Lang;
  }
  return 'en';
}
