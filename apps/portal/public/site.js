// Meridian — site public : langues, navigation, couverture pays, démo « Essayez de le casser ».
(() => {
  'use strict';
  const LANGS = ['fr', 'en', 'de', 'es', 'it', 'nl'];
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };
  const $ = (id) => document.getElementById(id);
  let dict = {};
  let lang = 'fr';

  const t = (k, vars = {}) => (dict[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');

  function pickLang() {
    const q = new URLSearchParams(location.search).get('lang');
    if (q && LANGS.includes(q)) return q;
    const saved = store.get('meridian.lang');
    if (saved && LANGS.includes(saved)) return saved;
    for (const l of navigator.languages ?? [navigator.language]) {
      const b = String(l).slice(0, 2).toLowerCase();
      if (LANGS.includes(b)) return b;
    }
    return 'en';
  }

  async function load(l) {
    try {
      const r = await fetch(`i18n/site/${l}.json`);
      if (!r.ok) throw new Error(String(r.status));
      dict = await r.json();
      lang = l;
    } catch {
      if (l !== 'fr') return load('fr');
    }
    document.documentElement.lang = lang;
    $('lang').value = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const k = el.getAttribute('data-i18n');
      if (dict[k] !== undefined) el.textContent = dict[k];
    }
    // Contenu riche : uniquement nos propres fichiers de traduction (balises <br> et <span class="hl">).
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
      const k = el.getAttribute('data-i18n-html');
      if (dict[k] !== undefined) el.innerHTML = dict[k];
    }
    document.title = t('meta.title');
    document.querySelector('meta[name=description]').setAttribute('content', t('meta.desc'));
    renderCoverage();
    renderTicket(lastRun);
    setMode();
  }

  // ---------- Navigation ----------
  const VIEWS = ['home', 'software', 'psp', 'demo'];
  function route() {
    const v = (location.hash.match(/^#\/?(\w+)/) ?? [])[1] ?? 'home';
    if (location.hash && !VIEWS.includes(v)) return; // ancre interne (ex. lien d'évitement) : pas de changement de vue
    const view = VIEWS.includes(v) ? v : 'home';
    for (const s of document.querySelectorAll('.view')) s.hidden = s.dataset.view !== view;
    for (const a of document.querySelectorAll('.nav a')) {
      if (a.getAttribute('href') === `#${view}`) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
    if (location.hash) $('main').focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('scroll', () => document.querySelector('.hd').classList.toggle('scrolled', scrollY > 8), { passive: true });

  // ---------- Couverture par pays ----------
  const COUNTRIES = [
    ['FR', 'EUR', ['CB'], ['Concert', 'nexo']],
    ['BE', 'EUR', ['Bancontact'], ['nexo']],
    ['NL', 'EUR', ['Wero'], ['nexo']],
    ['DE', 'EUR', ['girocard'], ['ZVT', 'nexo']],
    ['ES', 'EUR', ['Bizum'], ['nexo']],
    ['IT', 'EUR', ['PagoBancomat'], ['ECR17', 'nexo']],
    ['AT', 'EUR', [], ['ZVT', 'nexo']],
    ['CH', 'CHF', ['TWINT'], ['ZVT', 'nexo']],
  ];
  function renderCoverage() {
    const box = $('coverage');
    if (!box) return;
    const names = new Intl.DisplayNames([lang], { type: 'region' });
    box.replaceChildren(...COUNTRIES.map(([c, cur, local, proto]) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.append(names.of(c) ?? c);
      const s = document.createElement('span'); s.textContent = cur; b.append(s);
      const p = document.createElement('p');
      p.append('Visa · Mastercard');
      for (const l of local) { p.append(' · '); const e = document.createElement('em'); e.textContent = l; p.append(e); }
      p.append(document.createElement('br'), `${t('cov.proto')} ${proto.join(' · ')}`);
      d.append(b, p);
      return d;
    }));
  }

  // ---------- Démo ----------
  let recorded = null;
  let live = null; // null = inconnu, true = API joignable, false = exécution enregistrée
  let lastRun = null;
  const money = (minor, cur) => new Intl.NumberFormat(lang, { style: 'currency', currency: cur }).format(minor / 100);
  const sec = (ms) => `+${new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ms / 1000)} s`;

  function setMode() {
    const el = $('demoMode');
    if (!el) return;
    el.textContent = live === false ? t('demo.mode.recorded', { date: new Date('2026-11-21').toLocaleDateString(lang) }) : live ? t('demo.mode.live') : '';
  }

  function label(e) {
    const d = e.data ?? {};
    switch (e.type) {
      case 'created': return t('j.created');
      case 'step': return dict[`j.step.${d.step}`] ?? t('j.step', { n: String(d.step ?? '') });
      case 'network_error': return dict[`j.net.${d.where}`] ?? t('j.network');
      case 'recovered': return t('j.recovered');
      case 'fallback': return t('j.fallback');
      case 'final': {
        const card = d.receipt?.last4 ? ` · ${String(d.receipt.brand ?? '').toUpperCase()} •••• ${d.receipt.last4}` : '';
        return `${dict[`j.final.${d.state}`] ?? d.state}${card}`;
      }
      default: return e.type;
    }
  }

  function renderTicket(run) {
    if (!$('ticket')) return;
    const st = $('tState');
    $('tLog').replaceChildren();
    if (!run) {
      st.className = 'pill'; st.textContent = t('demo.idle');
      for (const id of ['tRef', 'tDebits', 'tTime', 'tProof']) $(id).textContent = '—';
      $('tHash').textContent = '';
      $('tAmount').textContent = money(2450, 'EUR');
      return;
    }
    $('tRef').textContent = run.reference;
    $('tAmount').textContent = money(run.amount, run.currency);
    const fin = { authorized: ['ok', 'state.authorized'], declined: ['no', 'state.declined'], cancelled: ['no', 'state.cancelled'], failed: ['no', 'state.failed'] }[run.state] ?? ['run', 'state.pending'];
    st.className = `pill ${fin[0]}`; st.textContent = t(fin[1]);
    $('tLog').replaceChildren(...run.journal.map((e) => {
      const li = document.createElement('li');
      li.className = `in ${e.type === 'network_error' ? 'warn' : e.type === 'final' ? 'fin' : ''}`;
      const a = document.createElement('span'); a.textContent = sec(Math.max(0, e.ms));
      const b = document.createElement('span'); b.textContent = label(e);
      li.append(a, b);
      return li;
    }));
    $('tDebits').textContent = String(run.debits);
    $('tDebits').className = run.debits === 1 ? 'one' : '';
    $('tTime').textContent = sec(run.durationMs).slice(1);
    $('tProof').textContent = run.verified ? t('demo.verified') : t('demo.broken');
    $('tProof').className = run.verified ? 'okv' : 'one';
    const last = run.journal.at(-1);
    $('tHash').textContent = last ? `sha256 ${last.hash.slice(0, 32)}… ← ${last.prev.slice(0, 12)}…` : '';
  }

  async function play(run) {
    // Rejoue le journal réel à son propre rythme (accéléré au besoin), pour voir la panne puis la reprise.
    lastRun = null;
    renderTicket(null);
    $('tRef').textContent = run.reference;
    const st = $('tState');
    st.className = 'pill run'; st.textContent = t('state.pending');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const span = Math.max(1, run.journal.at(-1)?.ms ?? 1);
    const k = span > 3500 ? 3500 / span : 1;
    let prev = 0;
    for (const e of run.journal) {
      if (!reduce) await new Promise((r) => setTimeout(r, Math.max(120, (e.ms - prev) * k)));
      prev = e.ms;
      const li = document.createElement('li');
      li.className = e.type === 'network_error' ? 'warn' : e.type === 'final' ? 'fin' : '';
      const a = document.createElement('span'); a.textContent = sec(Math.max(0, e.ms));
      const b = document.createElement('span'); b.textContent = label(e);
      li.append(a, b);
      $('tLog').append(li);
      requestAnimationFrame(() => li.classList.add('in'));
    }
    lastRun = run;
    renderTicket(run);
  }

  async function runDemo() {
    const btn = $('run');
    const scenario = document.querySelector('input[name=scen]:checked')?.value ?? 'nominal';
    btn.disabled = true;
    const st = $('tState');
    $('tLog').replaceChildren();
    st.className = 'pill run'; st.textContent = t('demo.running');
    try {
      let run;
      if (live !== false) {
        try {
          const r = await fetch('/v1/demo/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario }), signal: AbortSignal.timeout(30000) });
          if (r.status === 429) throw Object.assign(new Error('rate'), { rate: true });
          if (!r.ok) throw new Error(String(r.status));
          run = await r.json();
          live = true;
        } catch (e) {
          if (e.rate) { st.className = 'pill no'; st.textContent = t('demo.rate'); return; }
          live = false;
        }
      }
      if (!run) {
        recorded ??= await fetch('demo-recorded.json').then((r) => r.json());
        run = recorded[scenario];
      }
      setMode();
      await play(run);
    } catch {
      st.className = 'pill no'; st.textContent = t('demo.error');
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('lang').addEventListener('change', (ev) => { store.set('meridian.lang', ev.target.value); void load(ev.target.value); });
    $('run').addEventListener('click', () => void runDemo());
    route();
    void load(pickLang());
  });
})();
