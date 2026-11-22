// Console Meridian : vue d'ensemble, paiements, rapprochement, points de vente et leur PSP, catalogue, borne de démo.
// Sans dépendance. La clé API reste dans l'onglet (sessionStorage).
{
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };
  const LANGS = ['fr', 'en', 'de', 'es', 'it', 'nl'];
  const FINAL = ['authorized', 'declined', 'cancelled', 'failed'];
  let dict = {};
  let lang = store.get('lang') || (navigator.language || 'fr').slice(0, 2);
  if (!LANGS.includes(lang)) lang = 'en';
  let countries = {};
  let modules = [];
  let posList = [];
  let lastRec;

  const t = (k, vars = {}) => (dict[k] || k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  };
  const digits = (cur) => (['JPY'].includes(cur) ? 0 : 2);
  const money = (minor, cur) => new Intl.NumberFormat(lang, { style: 'currency', currency: cur }).format(minor / 10 ** digits(cur));
  const time = (iso) => new Date(iso).toLocaleString(lang, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const notice = (msg) => { const n = $('notice'); n.textContent = msg || ''; n.hidden = !msg; };
  const badge = (state, label) => el('span', { class: `badge b-${state}` }, label ?? t(`state.${state}`));
  const modName = (id) => modules.find((m) => m.id === id)?.name || id;
  const colon = () => (lang === 'fr' ? ' : ' : ': ');
  const posById = (id) => posList.find((p) => p.id === id);

  async function api(method, path, body) {
    const key = store.get('apiKey');
    const res = await fetch(path, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ? `${json.error.code} : ${json.error.message}` : res.statusText);
    return json;
  }

  async function loadLang() {
    dict = await (await fetch(`i18n/${lang}.json`)).json();
    document.documentElement.lang = lang;
    $('lang').value = lang;
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
    $('ovStatusLink').href = lang === 'fr' ? '/fr/statut/' : '/en/status/';
  }

  const countryName = (c) => countries[c]?.name?.[lang] || countries[c]?.name?.en || c;
  function fillCountries(sel) {
    const v = sel.value;
    sel.replaceChildren(...['FR', 'BE', 'NL', 'DE', 'ES', 'IT', 'AT', 'CH'].map((c) => el('option', { value: c }, `${countryName(c)} (${c})`)));
    if (v) sel.value = v;
  }
  const methodsFor = (m, c) => [...new Set([...(m.capabilities.paymentMethods['*'] || []), ...(m.capabilities.paymentMethods[c] || [])])];

  // ---------- Points de vente (données partagées) ----------
  async function loadPos() {
    const key = store.get('apiKey');
    const env = $('env');
    env.hidden = !key;
    if (key) { const live = key.startsWith('mk_live_'); env.textContent = live ? 'live' : 'test'; env.className = live ? 'env live' : 'env'; }
    if (!key) { notice(t('settings.missing')); return; }
    try {
      posList = await api('GET', '/v1/pos');
      notice('');
    } catch (e) { notice(e.message); return; }
    const opts = () => posList.map((p) => el('option', { value: p.id }, `${p.label} · ${p.country}`));
    for (const sel of document.querySelectorAll('.posSel')) {
      const v = sel.value || store.get('pos');
      sel.replaceChildren(...opts());
      if (v && posById(v)) sel.value = v;
    }
    renderPosList();
  }
  for (const sel of document.querySelectorAll('.posSel')) sel.addEventListener('change', () => {
    store.set('pos', sel.value);
    for (const o of document.querySelectorAll('.posSel')) o.value = sel.value;
    refresh();
  });

  // ---------- Vue d'ensemble ----------
  async function overview() {
    const posId = $('ovPos').value;
    if (posId) {
      try {
        const rows = await api('GET', `/v1/payments?posId=${encodeURIComponent(posId)}`);
        const since = Date.now() - 24 * 3600 * 1000;
        const day = rows.filter((p) => Date.parse(p.createdAt) >= since);
        const done = day.filter((p) => FINAL.includes(p.state));
        const ok = day.filter((p) => p.state === 'authorized');
        const cur = posById(posId)?.currency || 'EUR';
        const rate = done.length ? Math.round((ok.length / done.length) * 1000) / 10 : null;
        const kpi = (k, v, cls) => el('div', { class: `kpi ${cls || ''}` }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));
        $('ovKpis').replaceChildren(
          kpi(t('ov.k.count'), String(day.length)),
          kpi(t('ov.k.amount'), money(ok.reduce((s, p) => s + p.amount - p.refunded, 0), cur)),
          kpi(t('ov.k.rate'), rate === null ? '—' : `${rate.toLocaleString(lang)} %`),
          kpi(t('ov.k.pending'), String(day.filter((p) => !FINAL.includes(p.state)).length), day.some((p) => !FINAL.includes(p.state)) ? 'bad' : ''),
        );
        const recent = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
        $('ovRows').replaceChildren(...(recent.length ? recent.map(payRow) : [el('tr', {}, el('td', { colspan: '5', class: 'empty' }, t('payments.empty')))]));
      } catch (e) { notice(e.message); }
    }
    $('ovHealthRows').replaceChildren(...posList.map((p) => el('tr', { 'data-pos': p.id },
      el('td', {}, p.label),
      el('td', {}, p.primaryModule ? el('span', {}, modName(p.primaryModule)) : badge('none', t('pos.none'))),
      el('td', {}, p.fallbackModule ? el('span', {}, modName(p.fallbackModule)) : badge('none', t('pos.none'))))));
    try {
      const s = await api('GET', '/v1/status');
      $('ovStatus').replaceChildren(...s.modules.map((m) => el('div', { class: 'strow' },
        el('strong', {}, m.name), badge(m.state, t(`st.${m.state}`)),
        el('div', { class: 'bars', role: 'img', 'aria-label': `${t('ov.hours')} : ${m.availability24h === null ? t('st.no_data') : m.availability24h + ' %'}` },
          ...m.hours.map((h) => el('span', { class: h === null ? '' : h >= 99 ? 'ok' : h >= 50 ? 'mid' : 'ko', style: `height:${h === null ? 20 : Math.max(20, h)}%` }))))));
    } catch { $('ovStatus').replaceChildren(el('p', { class: 'empty' }, t('ov.statusErr'))); }
  }
  $('ovHealth').addEventListener('click', async () => {
    $('ovHealth').disabled = true;
    await Promise.all(posList.map(async (p) => {
      const tr = document.querySelector(`#ovHealthRows tr[data-pos="${CSS.escape(p.id)}"]`);
      if (!tr || !p.primaryModule) return;
      const cell = (r) => r ? el('span', {}, modName(r.module), ' ', badge(r.ok ? 'ok' : 'ko', r.ok ? t('ov.reach') : t('ov.unreach'))) : badge('none', t('pos.none'));
      try {
        const h = await api('POST', `/v1/pos/${encodeURIComponent(p.id)}/health`);
        tr.children[1].replaceChildren(cell(h.primary));
        tr.children[2].replaceChildren(cell(h.fallback));
        if (h.primary && !h.primary.ok) tr.children[1].append(el('div', { class: 'small' }, h.primary.error || ''));
      } catch (e) { tr.children[1].replaceChildren(badge('ko', e.message)); }
    }));
    $('ovHealth').disabled = false;
  });

  // ---------- Paiements ----------
  function payRow(p) {
    const open = () => showJournal(p.posId, p.reference);
    return el('tr', { tabindex: '0', onclick: open, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open()), 'data-ref': p.reference },
      el('td', { class: 'mono' }, p.reference), el('td', {}, time(p.createdAt)), el('td', { class: 'num' }, money(p.amount, p.currency), p.refunded ? el('div', { class: 'small' }, `− ${money(p.refunded, p.currency)}`) : null),
      el('td', {}, badge(p.state)), el('td', {}, modName(p.module)));
  }
  async function loadPayments() {
    const posId = $('payPos').value; if (!posId) return;
    try {
      const f = $('payState').value;
      const rows = (await api('GET', `/v1/payments?posId=${encodeURIComponent(posId)}`))
        .filter((p) => !f || (f === 'pending' ? !FINAL.includes(p.state) : p.state === f))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      $('payRows').replaceChildren(...(rows.length ? rows.map(payRow) : [el('tr', {}, el('td', { colspan: '5', class: 'empty' }, t('payments.empty')))]));
    } catch (e) { notice(e.message); }
  }
  async function showJournal(posId, ref) {
    if (location.hash !== '#payments') { location.hash = '#payments'; }
    try {
      const list = await api('GET', `/v1/payments/${encodeURIComponent(ref)}/journal?posId=${encodeURIComponent(posId)}`);
      $('jRef').textContent = ref;
      $('journalList').replaceChildren(...list.map((e) => el('li', { class: `k-${e.type}` },
        el('div', { class: 't' }, t(`j.${e.type}`), ' ', el('span', { class: 'small' }, new Date(e.ts).toLocaleTimeString(lang))),
        el('div', { class: 'd' }, JSON.stringify(e.data)),
        el('div', { class: 'h' }, `#${e.seq} sha256 ${e.hash.slice(0, 16)}… ← ${e.prev.slice(0, 8)}`))));
      $('journal').hidden = false;
      for (const tr of document.querySelectorAll('#payRows tr')) tr.setAttribute('aria-selected', String(tr.dataset.ref === ref));
    } catch (e) { notice(e.message); }
  }
  $('jClose').addEventListener('click', () => { $('journal').hidden = true; });
  $('payState').addEventListener('change', loadPayments);
  $('verifyBtn').addEventListener('click', async () => {
    try { const v = await api('GET', '/v1/journal/verify'); $('verifyOut').textContent = v.ok ? t('payments.intact', { n: v.count }) : t('payments.broken', { n: v.brokenAt }); } catch (e) { notice(e.message); }
  });

  // ---------- Rapprochement ----------
  const isoDay = (d) => d.toISOString().slice(0, 10);
  $('recFrom').value = isoDay(new Date(Date.now() - 6 * 86400000));
  $('recTo').value = isoDay(new Date());
  $('recForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const posId = $('recPos').value; if (!posId) return;
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try {
      const from = $('recFrom').value ? new Date(`${$('recFrom').value}T00:00:00`).toISOString() : undefined;
      const to = $('recTo').value ? new Date(`${$('recTo').value}T23:59:59.999`).toISOString() : undefined;
      const r = await api('POST', '/v1/reconcile', { posId, from, to, limit: 200 });
      lastRec = r;
      const kpi = (k, v, cls) => el('div', { class: `kpi ${cls || ''}` }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));
      $('recKpis').replaceChildren(
        kpi(t('rec.checked'), String(r.count)),
        kpi(t('rec.mismatches'), String(r.mismatches), r.mismatches ? 'bad' : 'good'),
        kpi(t('rec.pending'), String(r.rows.filter((x) => x.psp === 'pending' && !FINAL.includes(x.meridian)).length)),
        kpi(t('rec.at'), new Date(r.checkedAt).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })),
      );
      $('recTotals').replaceChildren(...(r.totals.length ? r.totals.map((x) => el('tr', {}, el('td', {}, modName(x.module)), el('td', { class: 'num' }, String(x.count)),
        el('td', { class: 'num' }, money(x.authorized, x.currency)), el('td', { class: 'num' }, money(x.refunded, x.currency)), el('td', { class: 'num' }, money(x.authorized - x.refunded, x.currency)))) : [el('tr', {}, el('td', { colspan: '5', class: 'empty' }, t('rec.none')))]));
      const rows = [...r.rows].sort((a, b) => Number(a.match) - Number(b.match) || b.createdAt.localeCompare(a.createdAt));
      $('recRows').replaceChildren(...(rows.length ? rows.map((x) => el('tr', { class: x.match ? '' : 'mis' },
        el('td', { class: 'mono' }, x.reference), el('td', {}, time(x.createdAt)), el('td', { class: 'num' }, money(x.amount, x.currency)),
        el('td', {}, badge(x.meridian)), el('td', {}, badge(x.psp === 'unreachable' ? 'ko' : x.psp === 'not_sent' ? 'none' : x.psp, t(`rec.psp.${x.psp}`) === `rec.psp.${x.psp}` ? t(`state.${x.psp}`) : t(`rec.psp.${x.psp}`))),
        el('td', {}, x.match ? badge('ok', t('rec.ok')) : badge('mis', t('rec.mis'))))) : [el('tr', {}, el('td', { colspan: '6', class: 'empty' }, t('rec.none')))]));
      $('recOut').hidden = false;
    } catch (e) { notice(e.message); }
    if (btn) btn.disabled = false;
  });
  $('recCsv').addEventListener('click', () => {
    if (!lastRec) return;
    const esc = (v) => /[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const head = ['reference', 'created_at', 'amount_minor', 'currency', 'module', 'meridian_state', 'psp_state', 'refunded_minor', 'match'];
    const lines = [head, ...lastRec.rows.map((x) => [x.reference, x.createdAt, x.amount, x.currency, x.module, x.meridian, x.psp, x.refunded, x.match ? 'yes' : 'no'])].map((r) => r.map(esc).join(','));
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: `meridian-rapprochement-${lastRec.posId}-${lastRec.checkedAt.slice(0, 10)}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---------- Points de vente et leur PSP ----------
  function renderPosList() {
    $('posList').replaceChildren(...(posList.length ? posList.map((p) => el('div', { class: 'item' },
      el('div', {}, el('strong', {}, p.label),
        el('div', { class: 'meta' }, `${p.id} · ${countryName(p.country)} · ${p.currency}`),
        el('div', { class: 'chips' },
          el('span', { class: 'chip local' }, `${t('pos.primary')}${colon()}${p.primaryModule ? modName(p.primaryModule) : t('pos.none')}`),
          p.fallbackModule ? el('span', { class: 'chip' }, `${t('pos.fallback')}${colon()}${modName(p.fallbackModule)}`) : null)),
      el('div', { class: 'acts' }, el('button', { onclick: () => openPsp(p) }, t('pos.psp'))))) : [el('p', { class: 'empty' }, t('pos.empty'))]));
  }
  let pspPos;
  function fields(container, mod, prefix) {
    container.replaceChildren(...(mod ? [...mod.config.map((c) => el('label', {}, el('span', {}, c.label || c.key), el('input', { name: `${prefix}.${c.key}`, type: c.secret ? 'password' : 'text', required: true, autocomplete: 'off', spellcheck: 'false' }))),
      el('label', {}, el('span', {}, t('pos.baseUrl')), el('input', { name: `${prefix}.__baseUrl`, placeholder: 'http://localhost:12111' }))] : []));
  }
  const availFor = (p) => modules.filter((m) => m.capabilities.countries.includes(p.country) && m.capabilities.currencies.includes(p.currency));
  const modOption = (m) => el('option', { value: m.id }, m.maturity === 'preview' ? `${m.name} · ${t('cat.preview')}` : m.name);
  function openPsp(p) {
    pspPos = p;
    $('pspPosName').textContent = p.label;
    const avail = availFor(p);
    $('primarySel').replaceChildren(...avail.map(modOption));
    $('fallbackSel').replaceChildren(el('option', { value: '' }, t('pos.none')), ...avail.map(modOption));
    if (p.primaryModule) $('primarySel').value = p.primaryModule;
    $('fallbackSel').value = p.fallbackModule || '';
    const sync = () => {
      fields($('primaryFields'), modules.find((m) => m.id === $('primarySel').value), 'p');
      fields($('fallbackFields'), modules.find((m) => m.id === $('fallbackSel').value), 'f');
    };
    $('primarySel').onchange = sync; $('fallbackSel').onchange = sync;
    sync();
    $('pspForm').hidden = false;
    $('pspForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('pspClose').addEventListener('click', () => { $('pspForm').hidden = true; });
  function readBinding(form, prefix, moduleId) {
    if (!moduleId) return undefined;
    const config = {}; let baseUrl;
    for (const i of form.querySelectorAll(`input[name^="${prefix}."]`)) {
      const k = i.name.slice(prefix.length + 1);
      if (k === '__baseUrl') baseUrl = i.value || undefined; else config[k] = i.value;
    }
    return { moduleId, config, ...(baseUrl ? { baseUrl } : {}) };
  }
  $('pspForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const primary = readBinding(f, 'p', $('primarySel').value);
    const fallback = readBinding(f, 'f', $('fallbackSel').value);
    try {
      await api('PUT', `/v1/pos/${encodeURIComponent(pspPos.id)}/psp`, { primary, fallback });
      await loadPos();
      notice(t('pos.plugged'));
      pspPos = posById(pspPos.id) || pspPos;
    } catch (e) { notice(e.message); }
  });
  $('posForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/v1/pos', { label: $('posLabel').value, country: $('posCountry').value }); $('posLabel').value = ''; loadPos(); } catch (e) { notice(e.message); }
  });

  // ---------- Catalogue ----------
  function renderCatalog() {
    const c = $('catCountry').value;
    const local = new Set(countries[c]?.localSchemes || []);
    const list = modules.filter((m) => m.capabilities.countries.includes(c) && !m.id.startsWith('psp-secours'));
    $('catList').replaceChildren(...(list.length ? list.map((m) => el('article', { class: 'card' },
      el('div', { class: 'ph' }, el('h2', {}, m.name), m.maturity === 'preview' ? badge('preview', t('cat.preview')) : badge('ok', t('cat.available'))),
      el('span', { class: 'small' }, t(`kind.${m.kind}`)),
      el('div', { class: 'chips' }, ...methodsFor(m, c).map((x) => el('span', { class: local.has(x) ? 'chip local' : 'chip' }, x))),
      el('span', { class: 'small' }, t('catalog.currencies', { list: m.capabilities.currencies.join(', ') })),
      m.maturity === 'preview' ? el('span', { class: 'small' }, t('cat.previewNote')) : null,
    )) : [el('p', { class: 'empty' }, t('catalog.empty'))]));
  }

  // ---------- Borne de démo ----------
  let current;
  const screen = (cls, big, small = '') => { $('kScreen').className = `screen ${cls}`; $('kState').textContent = big; $('kDetail').textContent = small; };
  $('kPay').addEventListener('click', async () => {
    const posId = $('kPos').value; const pos = posById(posId); if (!pos) return;
    const amount = Math.round(parseFloat($('kAmount').value) * 10 ** digits(pos.currency));
    const reference = `KIOSK-${Date.now().toString(36).toUpperCase()}`;
    current = { posId, reference };
    $('kPay').disabled = true; $('kCancel').disabled = false;
    screen('pending', t('state.pending'), money(amount, pos.currency));
    try {
      await api('POST', '/v1/payments', { posId, reference, amount, currency: pos.currency });
      let p;
      for (let i = 0; i < 20; i++) {
        try { p = await api('GET', `/v1/payments/${encodeURIComponent(reference)}?posId=${encodeURIComponent(posId)}&waitMs=8000`); } catch { screen('pending', t('state.pending'), t('kiosk.network')); continue; }
        if (FINAL.includes(p.state)) break;
      }
      screen(p.state === 'authorized' ? 'ok' : 'bad', t(`state.${p.state}`), p.detail ? t(`detail.${p.detail}`) : (p.state === 'authorized' ? t('kiosk.receipt') : ''));
    } catch (e) { screen('bad', t('state.failed'), e.message); }
    $('kPay').disabled = false; $('kCancel').disabled = true;
  });
  $('kCancel').addEventListener('click', () => current && api('POST', `/v1/payments/${encodeURIComponent(current.reference)}/cancel`, { posId: current.posId }).catch((e) => notice(e.message)));

  // ---------- Clé, langue, navigation ----------
  $('keyForm').addEventListener('submit', async (ev) => { ev.preventDefault(); store.set('apiKey', $('apiKey').value.trim()); notice(t('settings.saved')); await loadPos(); refresh(); });
  $('lang').addEventListener('change', async () => { lang = $('lang').value; store.set('lang', lang); await loadLang(); fillCountries($('catCountry')); fillCountries($('posCountry')); renderCatalog(); await loadPos(); refresh(); });
  $('catCountry').addEventListener('change', renderCatalog);
  const view = () => (location.hash || '#overview').slice(1);
  function refresh() {
    const v = view();
    if (v === 'overview') overview();
    if (v === 'payments') loadPayments();
  }
  function route() {
    const v = view();
    for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== `v-${v}`;
    for (const a of document.querySelectorAll('.snav a')) {
      if (a.getAttribute('href') === `#${v}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    refresh();
  }
  window.addEventListener('hashchange', () => { route(); $('main').focus({ preventScroll: true }); });

  (async () => {
    await loadLang();
    [countries, modules] = await Promise.all([api('GET', '/v1/countries'), api('GET', '/v1/modules')]);
    fillCountries($('catCountry')); fillCountries($('posCountry'));
    renderCatalog();
    $('apiKey').value = store.get('apiKey') || '';
    await loadPos();
    route();
  })();
}
