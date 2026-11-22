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
    startFeed();
    renderLands();
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


  // ---------- Vue produit animée (accueil) ----------
  const FEED = [
    ['Paris', 'Caisse 2', 'FR', 'CB', 'Stripe', 2450, 'EUR', 'authorized'],
    ['Berlin', 'Kiosk 1', 'DE', 'girocard', 'Stripe', 1290, 'EUR', 'authorized'],
    ['Bruxelles', 'Borne 4', 'BE', 'Bancontact', 'Secours', 840, 'EUR', 'authorized'],
    ['Zürich', 'Kasse 3', 'CH', 'TWINT', 'Secours', 1900, 'CHF', 'authorized'],
    ['Milano', 'Cassa 1', 'IT', 'PagoBancomat', 'Stripe', 520, 'EUR', 'declined'],
    ['Madrid', 'TPV 6', 'ES', 'Bizum', 'Stripe', 3100, 'EUR', 'authorized'],
    ['Lyon', 'Borne 1', 'FR', 'CB', 'Stripe', 1150, 'EUR', 'authorized'],
    ['Utrecht', 'Kassa 2', 'NL', 'Wero', 'Secours', 675, 'EUR', 'authorized'],
  ];
  const pill = (st) => { const p = document.createElement('span'); const m = { authorized: 'ok', declined: 'no', pending: 'run' }[st]; p.className = `pill ${m}`; p.textContent = t(`state.${st}`); return p; };
  function row(f, state) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.append(f[0]); const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = f[1]; a.append(sub);
    const b = document.createElement('td'); b.textContent = f[3];
    const c = document.createElement('td'); c.textContent = f[4];
    const d = document.createElement('td'); d.className = 'r'; d.textContent = money(f[5], f[6]);
    const e = document.createElement('td'); e.append(pill(state));
    tr.append(a, b, c, d, e);
    return tr;
  }
  let feedTimer = 0; let sideTimers = [];
  function startFeed() {
    const body = $('appRows');
    if (!body) return;
    clearInterval(feedTimer); sideTimers.forEach(clearTimeout); sideTimers = [];
    body.replaceChildren(...FEED.slice(0, 6).map((f) => row(f, f[7])));
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const log = $('sideLog');
    const steps = [[0, 'j.created', ''], [10, 'j.step.process', ''], [510, 'j.net.status', 'warn'], [2920, 'j.final.authorized', 'ok']];
    const line = (ms, k, cls) => { const li = document.createElement('li'); li.className = cls; const x = document.createElement('span'); x.textContent = sec(ms); const y = document.createElement('span'); y.textContent = t(k); li.append(x, y); return li; };
    if (reduce) {
      log.replaceChildren(...steps.map((s) => line(...s)));
      $('sideDebits').textContent = '1'; $('sideProof').textContent = `✓ ${t('mt.ok')}`;
      return;
    }
    let i = 6;
    const cycle = () => {
      log.replaceChildren(); $('sideDebits').textContent = '0'; $('sideProof').innerHTML = '&nbsp;';
      steps.forEach(([ms, k, cls], n) => sideTimers.push(setTimeout(() => {
        log.append(line(ms, k, cls));
        if (n === steps.length - 1) { $('sideDebits').textContent = '1'; $('sideProof').textContent = `✓ ${t('mt.ok')}`; }
      }, 400 + n * 1100)));
    };
    cycle();
    feedTimer = setInterval(() => {
      const f = FEED[i++ % FEED.length];
      const tr = row(f, 'pending'); tr.classList.add('new');
      body.prepend(tr);
      while (body.children.length > 6) body.lastElementChild.remove();
      sideTimers.push(setTimeout(() => { tr.lastElementChild.replaceChildren(pill(f[7])); }, 1300));
      if (i % 4 === 0) { sideTimers.forEach(clearTimeout); sideTimers = []; cycle(); }
    }, 2200);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearInterval(feedTimer); else startFeed(); }, { once: true });
  }

  // ---------- Onglets de code ----------
  function initCode() {
    const tabs = document.querySelectorAll('.code-tabs [data-code]');
    tabs.forEach((b) => b.addEventListener('click', () => {
      tabs.forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      for (const k of ['sdk', 'rest', 'nexo']) $(`code-${k}`).hidden = k !== b.dataset.code;
    }));
    $('copyCode')?.addEventListener('click', async (ev) => {
      const vis = [...document.querySelectorAll('.codebox pre')].find((p) => !p.hidden);
      try { await navigator.clipboard.writeText(vis.innerText); ev.target.textContent = t('code.copied'); }
      catch { ev.target.textContent = '—'; }
      setTimeout(() => { ev.target.textContent = t('code.copy'); }, 1600);
    });
  }


  // ---------- Scène 1 : la ligne de paiement ----------
  function initWire() {
    const cv = $('wire'); if (!cv) return;
    const ctx = cv.getContext('2d');
    const state = $('wireState');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, dpr = 1;
    const size = () => { dpr = Math.min(2, devicePixelRatio || 1); W = cv.clientWidth; H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    new ResizeObserver(size).observe(cv); size();
    const SIG = '#6272FF', WAIT = '#FFC861', PAID = '#3FD99A';
    const CYCLE = 7200; // ms : départ, coupure, attente, reprise, arrivée, pause
    const draw = (now) => {
      const y = H / 2, x0 = 8, x1 = W - 8, cutA = 0.46, cutB = 0.56;
      const p = (now % CYCLE) / CYCLE;
      // phases
      const travel1 = Math.min(1, p / 0.22);                 // vers la coupure
      const cut = p > 0.2 && p < 0.55;                        // réseau tombé
      const travel2 = p < 0.55 ? 0 : Math.min(1, (p - 0.55) / 0.2); // reprise
      const done = p >= 0.75;
      ctx.clearRect(0, 0, W, H);
      // ligne de base
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      const seg = (a, b, col, alpha) => { ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(x0 + (x1 - x0) * a, y); ctx.lineTo(x0 + (x1 - x0) * b, y); ctx.stroke(); ctx.globalAlpha = 1; };
      seg(0, cutA, 'rgba(255,255,255,.22)', 1); seg(cutB, 1, 'rgba(255,255,255,.22)', 1);
      if (!cut) seg(cutA, cutB, 'rgba(255,255,255,.22)', 1);
      else { // brèche qui clignote
        const blink = 0.25 + 0.25 * Math.sin(now / 120);
        ctx.setLineDash([4, 6]); seg(cutA, cutB, WAIT, blink); ctx.setLineDash([]);
      }
      // trace lumineuse parcourue
      const head = done ? 1 : (p < 0.55 ? cutA * travel1 : cutA + (1 - cutA) * travel2);
      const col = done ? PAID : cut ? WAIT : SIG;
      seg(0, head, col, 0.95);
      // tête
      const hx = x0 + (x1 - x0) * head;
      const glow = ctx.createRadialGradient(hx, y, 0, hx, y, 26);
      glow.addColorStop(0, col); glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow; ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.arc(hx, y, 26, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, y, 4.5, 0, 7); ctx.fill();
      // extrémités
      for (const [x, c] of [[x0, SIG], [x1, done ? PAID : 'rgba(255,255,255,.5)']]) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); }
      const label = done ? ['ok', t('x.done')] : cut ? ['wait', t('x.wait')] : ['', ''];
      if (state.dataset.k !== label[1]) { state.dataset.k = label[1]; state.className = `w-state ${label[0]}`; state.textContent = label[1]; }
    };
    if (reduce) { draw(CYCLE * 0.9); return; }
    let start = performance.now(), raf = 0, visible = true;
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) loop(); }).observe(cv);
    function loop() { cancelAnimationFrame(raf); if (!visible || document.hidden) return; draw(performance.now() - start); raf = requestAnimationFrame(loop); }
    document.addEventListener('visibilitychange', loop);
    loop();
  }

  // ---------- Scène 2 : histoire pilotée par le défilement ----------
  function initStory() {
    const story = $('story'); if (!story) return;
    const stage = story.querySelector('.story-stage');
    const count = $('ledgerCount');
    let last = -1;
    const update = () => {
      const r = story.getBoundingClientRect();
      const total = r.height - innerHeight;
      const prog = Math.min(1, Math.max(0, -r.top / Math.max(1, total)));
      const act = Math.min(3, Math.floor(prog * 4));
      if (act !== last) { last = act; stage.dataset.act = String(act); count.textContent = act === 3 ? '1' : '0'; }
    };
    addEventListener('scroll', update, { passive: true }); addEventListener('resize', update); update();
  }

  // ---------- Scène 5 : pays ----------
  function renderLands() {
    const ul = $('lands'); if (!ul) return;
    const names = new Intl.DisplayNames([lang], { type: 'region' });
    const L = [['FR', 'CB'], ['BE', 'Bancontact'], ['NL', 'Wero'], ['DE', 'girocard'], ['ES', 'Bizum'], ['IT', 'PagoBancomat'], ['AT', ''], ['CH', 'TWINT']];
    ul.replaceChildren(...L.map(([c, local]) => {
      const li = document.createElement('li'); const b = document.createElement('b'); b.textContent = names.of(c) ?? c;
      const sp = document.createElement('span'); sp.append('Visa, Mastercard');
      if (local) { sp.append(', '); const em = document.createElement('em'); em.textContent = local; sp.append(em); }
      li.append(b, sp); return li;
    }));
  }

  // ---------- En-tête transparent sur les scènes de nuit ----------
  function headerTone() {
    const hd = document.querySelector('.hd');
    const home = !document.querySelector('.view[data-view=home]').hidden;
    let night = false;
    if (home) {
      const el = document.elementsFromPoint(innerWidth / 2, 36).find((e) => !e.closest('.hd'));
      night = !!el?.closest('.night, .story');
    }
    hd.classList.toggle('on-night', night);
    const dark = document.querySelector('.view[data-view=home]:not([hidden]) .hero-dark');
    hd.classList.toggle('on-dark', !!dark && dark.getBoundingClientRect().bottom > 72);
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
    initCode();
    initWire();
    initStory();
    addEventListener('scroll', headerTone, { passive: true });
    addEventListener('hashchange', () => setTimeout(headerTone, 50));
    setTimeout(headerTone, 100);
    route();
    void load(pickLang());
  });
})();
