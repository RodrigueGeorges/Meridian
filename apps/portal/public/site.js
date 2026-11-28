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
    // Prix publics du catalogue, au format de la langue (taux en %, frais fixes en euros).
    for (const el of document.querySelectorAll('.pr[data-rate], .pr[data-fixed]')) {
      const parts = [];
      if (el.dataset.rate) parts.push(new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 2 }).format(Number(el.dataset.rate) / 100));
      if (el.dataset.fixed) parts.push(new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR' }).format(Number(el.dataset.fixed)));
      el.textContent = parts.join(' + ');
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
    calcUpdate();
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
  const VIEWS = ['home', 'software', 'resellers', 'psp', 'demo'];
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
    ['IT', 'EUR', ['PagoBancomat'], ['nexo']],
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

  // ---------- Simulateur de revenus éditeur ----------
  function initStatus() {
    const box = document.getElementById('psp-status');
    if (!box) return;
    const L = (k) => box.getAttribute('data-l-' + k) || k;
    const pct = (v) => (v === null ? '—' : v.toLocaleString(box.dataset.locale, { maximumFractionDigits: 2 }) + ' %');
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const draw = (data) => {
      box.replaceChildren();
      for (const m of data.modules) {
        const card = el('article', 'st-card');
        const head = el('div', 'st-head');
        head.append(el('h2', '', m.name), el('p', 'st-state st-' + m.state, L(m.state)));
        const kpis = el('dl', 'st-kpis');
        for (const [k, v] of [['24h', pct(m.availability24h)], ['90d', pct(m.availability90d)], ['avg', m.avgSeconds24h === null ? '—' : m.avgSeconds24h.toLocaleString(box.dataset.locale) + ' s']]) {
          const d = el('div'); d.append(el('dt', '', L(k)), el('dd', '', v)); kpis.append(d);
        }
        const bars = el('div', 'st-bars');
        bars.setAttribute('role', 'img');
        const known = m.hours.filter((h) => h !== null);
        bars.setAttribute('aria-label', L('hours') + ' : ' + (known.length ? known.map((h) => h + ' %').join(', ') : L('none')));
        for (const h of m.hours) {
          const b = el('span', 'st-bar ' + (h === null ? 'st-nil' : h >= 99 ? 'st-ok' : h >= 50 ? 'st-mid' : 'st-ko'));
          b.style.height = (h === null ? 12 : Math.max(12, h)) + '%';
          bars.append(b);
        }
        const cap = el('p', 'st-cap', L('hours'));
        card.append(head, kpis, bars, cap);
        box.append(card);
      }
      const t = new Date(data.generatedAt).toLocaleTimeString(box.dataset.locale, { hour: '2-digit', minute: '2-digit' });
      box.append(el('p', 'st-upd', L('upd') + ' ' + t));
    };
    const load = () => fetch(box.dataset.src).then((r) => (r.ok ? r.json() : Promise.reject(r))).then(draw)
      .catch(() => { box.replaceChildren(el('p', 'st-empty', L('error'))); });
    load();
    setInterval(load, 60000);
  }

  function initCalc() {
    const T = $('cT'), V = $('cV'), S = $('cS'); if (!T) return;
    const eur = (n) => new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
    const num = (n) => new Intl.NumberFormat(lang).format(n);
    const update = () => {
      const t = Number(T.value), v = Number(V.value), s = Number(S.value);
      $('cTo').textContent = num(t); $('cVo').textContent = eur(v); $('cSo').textContent = num(s);
      $('cR').textContent = eur(Math.round(t * v * 12 * s / 10000));
    };
    for (const el of [T, V, S]) el.addEventListener('input', update);
    update();
    calcUpdate = update;
  }
  let calcUpdate = () => undefined;

  // ---------- Démo ----------
  // Démo IA : l'exemple fictif de relevé, lu par Mistral AI quand le serveur a une clé ; sinon chiffres enregistrés, présentés comme tels.
  const aiRun = document.getElementById('aiRun');
  if (aiRun) aiRun.addEventListener('click', async () => {
    const eur = (n) => new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
    const mode = document.getElementById('aiMode'), list = document.getElementById('aiOffers');
    aiRun.disabled = true; mode.textContent = t('v14.ai.reading'); list.replaceChildren();
    let d = null;
    try {
      const r = await fetch('/v1/demo/statement', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"country":"FR"}', signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { mode.textContent = t('demo.rate'); aiRun.disabled = false; return; }
      if (r.ok) d = await r.json();
    } catch { /* aperçu statique : résultat enregistré */ }
    d ??= await fetch(page.recordedStatement ?? 'demo-statement-recorded.json').then((r) => r.json()).catch(() => null);
    aiRun.disabled = false;
    if (!d) { mode.textContent = t('v14.ai.err'); return; }
    mode.textContent = d.method === 'ai' ? t('v14.ai.mode.ai', { model: d.model }) : t('v14.ai.mode.manual');
    const days = d.facts.periodDays || 30, k = 30 / days;
    document.getElementById('aiVol').textContent = eur(d.facts.cardVolume * k);
    document.getElementById('aiTx').textContent = new Intl.NumberFormat(lang).format(Math.round(d.facts.transactions * k));
    document.getElementById('aiCur').textContent = eur(d.result.current);
    document.getElementById('aiFacts').hidden = false;
    for (const e of d.result.estimates.slice(0, 4)) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.className = 'nm'; a.textContent = e.name;
      const b = document.createElement('span'); b.textContent = e.monthly == null ? t('v14.ai.quote') : t('v14.ai.month', { v: eur(e.monthly) });
      const c = document.createElement('span'); c.className = 'sv' + (e.savings == null || e.savings <= 0 ? ' neg' : '');
      c.textContent = e.savings == null ? '' : e.savings > 0 ? t('v14.ai.save', { v: eur(e.savings) }) : t('v14.ai.more', { v: eur(-e.savings) });
      li.append(a, b, c); list.append(li);
    }
  });

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


  // ---------- Démo « terminal du magasin » ----------
  let tdRecorded = null;
  let tdLive = null;
  function initTabs() {
    const tabs = [...document.querySelectorAll('.tabs [role=tab]')];
    const show = (tab, focus) => {
      for (const x of tabs) {
        const on = x === tab;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
        $(x.getAttribute('aria-controls')).hidden = !on;
      }
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => show(tab, false));
      tab.addEventListener('keydown', (ev) => {
        const d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (d) { ev.preventDefault(); show(tabs[(i + d + tabs.length) % tabs.length], true); }
      });
    });
  }
  function tdPath(mode, hop, err) {
    for (const li of document.querySelectorAll('#tdPath li')) {
      li.classList.toggle('off', mode === 'local' && li.dataset.hop === 'meridian');
      li.classList.toggle('on', li.dataset.hop === hop && !err);
      li.classList.toggle('err', li.dataset.hop === hop && !!err);
    }
  }
  async function runTerminal() {
    const btn = $('tdRun');
    const mode = document.querySelector('input[name=tdMode]:checked')?.value ?? 'cloud';
    const incident = document.querySelector('input[name=tdInc]:checked')?.value ?? 'none';
    const st = $('tdState'), log = $('tdLog');
    btn.disabled = true;
    log.replaceChildren();
    for (const id of ['tdOrders', 'tdDebits', 'tdTime']) { $(id).textContent = '—'; $(id).className = ''; }
    st.className = 'pill run'; st.textContent = t('demo.running');
    tdPath(mode, null);
    try {
      let run;
      if (tdLive !== false) {
        try {
          const r = await fetch('/v1/demo/terminal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, incident }), signal: AbortSignal.timeout(30000) });
          if (r.status === 429) throw Object.assign(new Error('rate'), { rate: true });
          if (!r.ok) throw new Error(String(r.status));
          run = await r.json();
          tdLive = true;
        } catch (e) {
          if (e.rate) { st.className = 'pill no'; st.textContent = t('demo.rate'); return; }
          tdLive = false;
        }
      }
      if (!run) {
        tdRecorded ??= await fetch(page.recordedTerminal ?? 'demo-terminal-recorded.json').then((r) => r.json());
        run = tdRecorded[`${mode}:${incident}`];
      }
      $('tdMode').textContent = tdLive === false ? t('td.rec') : '';
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      let prev = 0;
      for (const e of run.steps) {
        if (!reduce) await new Promise((r) => setTimeout(r, Math.max(380, Math.min(1400, e.ms - prev))));
        prev = e.ms;
        const bad = e.kind === 'reply_lost' || e.kind === 'tpe_busy' || e.kind === 'other_till' || e.kind === 'status_in_progress';
        tdPath(run.mode, e.hop, bad);
        const li = document.createElement('li');
        li.className = bad ? 'warn' : e.kind.startsWith('final_') ? 'fin' : '';
        const a = document.createElement('span'); a.textContent = sec(Math.max(0, e.ms));
        const b = document.createElement('span'); b.textContent = dict[`td.k.${e.kind}`] ?? e.kind;
        li.append(a, b);
        log.append(li);
        requestAnimationFrame(() => li.classList.add('in'));
      }
      const fin = { authorized: 'ok', declined: 'no', cancelled: 'no' }[run.state] ?? 'run';
      st.className = `pill ${fin}`; st.textContent = dict[`td.s.${run.state}`] ?? run.state;
      $('tdOrders').textContent = String(run.orders); $('tdOrders').className = run.orders === 1 ? 'one' : '';
      $('tdDebits').textContent = String(run.debits); $('tdDebits').className = run.debits === 1 ? 'one' : '';
      $('tdTime').textContent = sec(run.durationMs).slice(1);
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
    $('tdRun')?.addEventListener('click', () => { track('demo_terminal'); void runTerminal(); });
    initTabs();
    initContact();
    initStore();
    initConnect();
    initCalc();
    initStatus();
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
