// Meridian — site public : langues, navigation, couverture pays, démo « Essayez de le casser ».
(() => {
  'use strict';
  const LANGS = ['fr', 'en', 'de', 'es', 'it', 'nl'];
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };
  const $ = (id) => document.getElementById(id);
  // Pages pré-rendues (une URL par page et par langue) : le texte est déjà dans le HTML.
  const page = document.documentElement.dataset;
  const STATIC = page.static === '1';
  let dict = {};
  let lang = 'fr';

  const t = (k, vars = {}) => (dict[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');

  function pickLang() {
    if (STATIC) return document.documentElement.lang;
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
      const r = await fetch(STATIC && l === document.documentElement.lang ? page.dict : `i18n/site/${l}.json`);
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
    for (const el of document.querySelectorAll('[data-i18n-ph]')) {
      const k = el.getAttribute('data-i18n-ph');
      if (dict[k] !== undefined) el.setAttribute('placeholder', dict[k]);
    }
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
      const k = el.getAttribute('data-i18n-html');
      if (dict[k] !== undefined) el.innerHTML = dict[k];
    }
    for (const el of document.querySelectorAll('[data-i18n-aria]')) {
      const k = el.getAttribute('data-i18n-aria');
      if (dict[k] !== undefined) el.setAttribute('aria-label', dict[k]);
    }
    // Pages légales : français pour FR, anglais pour les autres langues.
    const legal = lang === 'fr' ? { notice: 'mentions-legales.html', privacy: 'confidentialite.html' } : { notice: 'legal-notice.html', privacy: 'privacy.html' };
    if (!STATIC) for (const a of document.querySelectorAll('[data-legal]')) a.setAttribute('href', legal[a.getAttribute('data-legal')]);
    if (!STATIC) {
      document.title = t('meta.title');
      document.querySelector('meta[name=description]').setAttribute('content', t('meta.desc'));
    }
    renderCoverage();
    renderTicket(lastRun);
    setMode();
    filterStore();
  }

  // ---------- Mesure d'audience (sans cookie, sans identifiant) ----------
  // Compte des pages et des actions, jamais une personne. Respecte Global Privacy Control et Do Not Track.
  function track(event) {
    try {
      if (navigator.globalPrivacyControl || navigator.doNotTrack === '1') return;
      let ref = '';
      try { const r = new URL(document.referrer); if (r.host !== location.host) ref = r.hostname; } catch { /* pas de provenance */ }
      const body = JSON.stringify({ e: event, p: location.pathname, l: document.documentElement.lang, r: ref });
      if (!navigator.sendBeacon?.('/v1/a', body)) void fetch('/v1/a', { method: 'POST', body, keepalive: true });
    } catch { /* la mesure ne doit jamais gêner la page */ }
  }

  // ---------- Navigation ----------
  const VIEWS = ['home', 'software', 'psp', 'demo'];
  function route() {
    if (STATIC) return;
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
  window.addEventListener('hashchange', () => (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches ? document.startViewTransition(route) : route()));
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
    for (const box of document.querySelectorAll('.cov')) {
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
  }


  // ---------- En-tête transparent sur les scènes de nuit ----------
  function headerTone() {
    const hd = document.querySelector('.hd');
    const dark = document.querySelector('.view[data-view=home]:not([hidden]) .hero-dark');
    hd.classList.toggle('on-dark', !!dark && dark.getBoundingClientRect().bottom > 72);
  }


  // ---------- Contact ----------
  function initContact() {
    const dlg = $('contact');
    const form = $('ctForm'), status = $('ctStatus'), send = $('ctSend');
    if (!form) return;
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-contact]'); if (!b) return;
      if (b.dataset.contact !== 'other') track(`cta_${b.dataset.contact}`);
      const r = form.querySelector(`input[name=role][value=${b.dataset.contact}]`); if (r) r.checked = true;
      status.textContent = ''; status.className = 'ct-status';
      if (dlg) dlg.showModal();
      form.querySelector('input[name=name]').focus();
    });
    send.addEventListener('click', async () => {
      const fd = new FormData(form);
      let bad = null;
      for (const n of ['name', 'company', 'email']) {
        const el = form.elements[n];
        const ok = el.checkValidity() && el.value.trim().length >= 2;
        el.setAttribute('aria-invalid', String(!ok)); if (!ok && !bad) bad = el;
      }
      if (bad) { status.className = 'ct-status err'; status.textContent = t('ct.invalid'); bad.focus(); return; }
      send.disabled = true; status.className = 'ct-status'; status.textContent = t('ct.sending');
      const body = Object.fromEntries(fd); body.lang = lang; if (!body.website) delete body.website;
      for (const k of ['country', 'message']) if (!body[k]) delete body[k];
      try {
        const r = await fetch('/v1/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 201) { status.className = 'ct-status ok'; status.textContent = t('ct.sent'); form.reset(); track('contact'); }
        else if (r.status === 429) { status.className = 'ct-status err'; status.textContent = t('ct.rate'); }
        else throw new Error(String(r.status));
      } catch { status.className = 'ct-status err'; status.textContent = t('ct.fail'); }
      finally { send.disabled = false; }
    });
  }


  // ---------- Catalogue interactif ----------
  let stCc = '';
  function filterStore() {
    const q = ($('stSearch')?.value ?? '').trim().toLowerCase();
    let live = 0, soon = 0;
    for (const li of document.querySelectorAll('.st-apps li')) {
      const d = li.querySelector('[data-cc]'); if (!d) continue;
      const any = d.dataset.cc === '*';
      const okCc = any || !stCc || d.dataset.cc.split(' ').includes(stCc);
      const okQ = any || !q || li.textContent.toLowerCase().includes(q);
      li.hidden = !(okCc && okQ);
      if (!li.hidden && !any) (li.querySelector('.st-badge.ok, .st-connect') ? live++ : soon++);
    }
    const c = $('stCount'); if (c) c.textContent = t('v7.count', { live: String(live), soon: String(soon) });
  }
  function initStore() {
    for (const b of document.querySelectorAll('.st-filters [data-cc]')) b.addEventListener('click', () => {
      stCc = b.dataset.cc;
      document.querySelectorAll('.st-filters [data-cc]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      filterStore();
    });
    $('stSearch')?.addEventListener('input', filterStore);
  }


  // ---------- Démo d'accueil : connecter un PSP ----------
  function initConnect() {
    const box = $('hstore'); if (!box) return;
    let t0 = 0, tick = 0;
    const timer = $('stTimer');
    const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    const startClock = () => { if (t0) return; t0 = performance.now(); tick = setInterval(() => { timer.textContent = fmt(performance.now() - t0); }, 250); };
    const go = (pane) => {
      box.dataset.pane = pane;
      if (pane === 'catalog') { clearInterval(tick); t0 = 0; timer.textContent = ''; }
      else startClock();
      const focus = box.querySelector(`.pane-${pane} button, .pane-${pane} input`); focus?.focus({ preventScroll: true });
    };
    box.addEventListener('click', (ev) => { const b = ev.target.closest('[data-pane-go]'); if (b) go(b.dataset.paneGo); });
    $('stConnect').addEventListener('click', async () => {
      track('store_connect');
      const btn = $('stConnect'); btn.disabled = true; btn.textContent = t('v9.testing');
      let run;
      try {
        const r = await fetch('/v1/demo/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 'nominal' }), signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(String(r.status));
        run = await r.json();
      } catch {
        recorded ??= await fetch(page.recorded ?? 'demo-recorded.json').then((r) => r.json()).catch(() => null);
        run = recorded?.nominal;
      }
      const elapsed = performance.now() - t0;
      clearInterval(tick); timer.textContent = fmt(elapsed);
      $('stDoneTime').textContent = t('v9.done.time', { s: String(Math.max(1, Math.round(elapsed / 1000))) });
      const steps = [t('v9.s1'), t('v9.s2'), t('v9.s3')];
      $('stSteps').replaceChildren(...steps.map((x) => { const li = document.createElement('li'); li.textContent = x; return li; }));
      const fin = run?.journal?.at(-1)?.data?.receipt;
      $('stPay').textContent = run ? `${money(run.amount, run.currency)} · ${t(`state.${run.state}`)}${fin?.last4 ? ` · ${String(fin.brand).toUpperCase()} •••• ${fin.last4}` : ''} · ${sec(run.durationMs).slice(1)}` : '—';
      btn.disabled = false; btn.textContent = t('v9.connect');
      box.dataset.pane = 'done';
      $('stAgain').focus({ preventScroll: true });
    });
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
        recorded ??= await fetch(page.recorded ?? 'demo-recorded.json').then((r) => r.json());
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
    $('lang').addEventListener('change', (ev) => {
      const l = ev.target.value;
      store.set('meridian.lang', l);
      if (!STATIC) { void load(l); return; }
      const alt = document.querySelector(`link[rel=alternate][hreflang="${l}"]`);
      location.href = alt ? new URL(alt.getAttribute('href'), location.href).pathname : `/${l}/`;
    });
    $('run')?.addEventListener('click', () => { track('demo'); void runDemo(); });
    initContact();
    initStore();
    initConnect();
    const hdH = () => document.documentElement.style.setProperty('--hd-h', `${document.querySelector('.hd').offsetHeight}px`);
    hdH(); addEventListener('resize', hdH);
    addEventListener('scroll', headerTone, { passive: true });
    addEventListener('hashchange', () => setTimeout(headerTone, 50));
    setTimeout(headerTone, 100);
    route();
    void load(pickLang());
    if (STATIC) track('view');
  });
})();
