// Portail Meridian : catalogue, points de vente, paiements, borne de démo. Sans dépendance.
{
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };
  let dict = {};
  let lang = store.get('lang') || (navigator.language || 'fr').slice(0, 2);
  if (!['fr', 'en', 'de', 'es', 'it', 'nl'].includes(lang)) lang = 'en';
  let countries = {};
  let modules = [];
  let posList = [];

  const t = (k, vars = {}) => (dict[k] || k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k === 'class' ? (e.className = v) : k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
    for (const c of kids) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  };
  const money = (cents, cur) => new Intl.NumberFormat(lang, { style: 'currency', currency: cur }).format(cents / 100);
  const notice = (msg) => { const n = $('notice'); n.textContent = msg; n.hidden = !msg; };

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
  }

  const countryName = (c) => countries[c]?.name?.[lang] || countries[c]?.name?.en || c;
  function fillCountries(sel) {
    sel.replaceChildren(...['FR', 'BE', 'NL', 'DE', 'ES', 'IT', 'AT', 'CH'].map((c) => el('option', { value: c }, `${countryName(c)} (${c})`)));
  }
  const methodsFor = (m, c) => [...(m.capabilities.paymentMethods['*'] || []), ...(m.capabilities.paymentMethods[c] || [])];

  // ---------- Catalogue ----------
  function renderCatalog() {
    const c = $('catCountry').value;
    const local = new Set(countries[c]?.localSchemes || []);
    const list = modules.filter((m) => m.capabilities.countries.includes(c));
    $('catList').replaceChildren(...(list.length ? list.map((m) => el('article', { class: 'card' },
      el('h3', {}, m.name),
      el('span', { class: 'small' }, t(`kind.${m.kind}`)),
      el('div', { class: 'tags' }, ...methodsFor(m, c).map((x) => el('span', { class: local.has(x) ? 'tag local' : 'tag' }, x))),
      el('span', { class: 'small' }, t('catalog.currencies', { list: m.capabilities.currencies.join(', ') })),
    )) : [el('p', { class: 'small' }, t('catalog.empty'))]));
  }

  // ---------- Points de vente ----------
  async function loadPos() {
    if (!store.get('apiKey')) { notice(t('settings.missing')); return; }
    try {
      posList = await api('GET', '/v1/pos');
      notice('');
    } catch (e) { notice(e.message); return; }
    $('posList').replaceChildren(...posList.map((p) => el('div', { class: 'item' },
      el('div', {}, el('strong', {}, p.label), el('div', { class: 'meta' }, `${p.id} · ${countryName(p.country)} · ${p.currency} · ${p.primaryModule || t('pos.none')}${p.fallbackModule ? ' / ' + p.fallbackModule : ''}`)),
      el('div', { class: 'row', style: 'margin:0' },
        el('button', { onclick: () => openRouting(p) }, t('action.plug')),
        el('button', { onclick: async () => { try { const h = await api('POST', `/v1/pos/${p.id}/health`); notice(`${t('pos.health')} : ${h.primary.module} ${h.primary.ok ? 'OK' : '✕ ' + (h.primary.error || '')}`); } catch (e) { notice(e.message); } } }, t('pos.health'))),
    )));
    for (const sel of [$('payPos'), $('kPos')]) sel.replaceChildren(...posList.map((p) => el('option', { value: p.id }, `${p.label} (${p.country})`)));
  }
  let routingPos;
  function fields(container, mod, prefix) {
    container.replaceChildren(...(mod ? [...mod.config.map((c) => el('label', {}, el('span', {}, c.label || c.key), el('input', { name: `${prefix}.${c.key}`, type: c.secret ? 'password' : 'text', required: '', autocomplete: 'off' }))),
      el('label', {}, el('span', {}, t('pos.baseUrl')), el('input', { name: `${prefix}.__baseUrl`, placeholder: 'http://localhost:12111' }))] : []));
  }
  function openRouting(p) {
    routingPos = p;
    $('routePos').textContent = p.label;
    const avail = modules.filter((m) => m.capabilities.countries.includes(p.country) && m.capabilities.currencies.includes(p.currency));
    $('primarySel').replaceChildren(...avail.map((m) => el('option', { value: m.id }, m.name)));
    $('fallbackSel').replaceChildren(el('option', { value: '' }, t('pos.none')), ...avail.map((m) => el('option', { value: m.id }, m.name)));
    const sync = () => { fields($('primaryFields'), modules.find((m) => m.id === $('primarySel').value), 'p'); fields($('fallbackFields'), modules.find((m) => m.id === $('fallbackSel').value), 'f'); };
    $('primarySel').onchange = sync; $('fallbackSel').onchange = sync; sync();
    $('routeForm').hidden = false;
    $('routeForm').scrollIntoView({ behavior: 'smooth' });
  }
  function readBinding(form, prefix, moduleId) {
    if (!moduleId) return undefined;
    const config = {}; let baseUrl;
    for (const i of form.querySelectorAll(`input[name^="${prefix}."]`)) {
      const k = i.name.slice(prefix.length + 1);
      if (k === '__baseUrl') baseUrl = i.value || undefined; else config[k] = i.value;
    }
    return { moduleId, config, ...(baseUrl ? { baseUrl } : {}) };
  }
  $('routeForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('PUT', `/v1/pos/${routingPos.id}/routing`, { primary: readBinding(ev.target, 'p', $('primarySel').value), fallback: readBinding(ev.target, 'f', $('fallbackSel').value) });
      $('routeForm').hidden = true; notice(t('pos.plugged')); loadPos();
    } catch (e) { notice(e.message); }
  });
  $('posForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/v1/pos', { label: $('posLabel').value, country: $('posCountry').value }); $('posLabel').value = ''; loadPos(); } catch (e) { notice(e.message); }
  });

  // ---------- Paiements ----------
  async function loadPayments() {
    const posId = $('payPos').value; if (!posId) return;
    try {
      const rows = await api('GET', `/v1/payments?posId=${encodeURIComponent(posId)}`);
      $('payRows').replaceChildren(...(rows.length ? rows.map((p) => el('tr', { onclick: () => showJournal(posId, p.reference), tabindex: '0', onkeydown: (e) => e.key === 'Enter' && showJournal(posId, p.reference) },
        el('td', { class: 'mono' }, p.reference), el('td', { class: 'num' }, money(p.amount, p.currency)),
        el('td', {}, el('span', { class: `st st-${p.state}` }, t(`state.${p.state}`))), el('td', {}, p.module))) : [el('tr', {}, el('td', { colspan: '4', class: 'small' }, t('payments.empty')))]));
    } catch (e) { notice(e.message); }
  }
  async function showJournal(posId, ref) {
    const list = await api('GET', `/v1/payments/${encodeURIComponent(ref)}/journal?posId=${encodeURIComponent(posId)}`);
    $('journalList').replaceChildren(...list.map((e) => el('li', {}, `#${e.seq} ${e.type} · ${new Date(e.ts).toLocaleTimeString(lang)} · ${JSON.stringify(e.data)}`, el('br'), el('span', { class: 'h' }, `sha256 ${e.hash.slice(0, 16)}… ← ${e.prev.slice(0, 8)}`))));
    $('journal').hidden = false;
  }
  $('payPos').addEventListener('change', loadPayments);
  $('verifyBtn').addEventListener('click', async () => {
    try { const v = await api('GET', '/v1/journal/verify'); $('verifyOut').textContent = v.ok ? t('payments.intact', { n: v.count }) : t('payments.broken', { n: v.brokenAt }); } catch (e) { notice(e.message); }
  });

  // ---------- Borne de démo ----------
  let current;
  const screen = (cls, big, small = '') => { $('kScreen').className = `screen ${cls}`; $('kState').textContent = big; $('kDetail').textContent = small; };
  $('kPay').addEventListener('click', async () => {
    const posId = $('kPos').value; const pos = posList.find((p) => p.id === posId); if (!pos) return;
    const amount = Math.round(parseFloat($('kAmount').value) * 100);
    const reference = `KIOSK-${Date.now().toString(36).toUpperCase()}`;
    current = { posId, reference };
    $('kPay').disabled = true; $('kCancel').disabled = false;
    screen('pending', t('state.pending'), money(amount, pos.currency));
    try {
      await api('POST', '/v1/payments', { posId, reference, amount, currency: pos.currency });
      let p;
      for (let i = 0; i < 20; i++) {
        try { p = await api('GET', `/v1/payments/${reference}?posId=${posId}&waitMs=8000`); } catch { screen('pending', t('state.pending'), t('kiosk.network')); continue; }
        if (['authorized', 'declined', 'cancelled', 'failed'].includes(p.state)) break;
      }
      screen(p.state === 'authorized' ? 'ok' : 'bad', t(`state.${p.state}`), p.detail ? t(`detail.${p.detail}`) : (p.state === 'authorized' ? t('kiosk.receipt') : ''));
    } catch (e) { screen('bad', t('state.failed'), e.message); }
    $('kPay').disabled = false; $('kCancel').disabled = true;
  });
  $('kCancel').addEventListener('click', () => current && api('POST', `/v1/payments/${current.reference}/cancel`, { posId: current.posId }).catch((e) => notice(e.message)));

  // ---------- Clé, langue, navigation ----------
  $('keyForm').addEventListener('submit', (ev) => { ev.preventDefault(); store.set('apiKey', $('apiKey').value.trim()); notice(t('settings.saved')); loadPos(); });
  $('lang').addEventListener('change', async () => { lang = $('lang').value; store.set('lang', lang); await loadLang(); fillCountries($('catCountry')); fillCountries($('posCountry')); renderCatalog(); loadPos(); });
  $('catCountry').addEventListener('change', renderCatalog);
  function route() {
    const v = (location.hash || '#catalog').slice(1);
    for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== `v-${v}`;
    for (const a of document.querySelectorAll('nav a')) a.toggleAttribute('aria-current', a.getAttribute('href') === `#${v}`) && a.setAttribute('aria-current', 'page');
    if (v === 'payments') loadPayments();
  }
  window.addEventListener('hashchange', route);

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
