/*
 * WhatsApp Group Contacts Exporter — main content script.
 * Runs in the page's MAIN world on https://web.whatsapp.com so it can read
 * WhatsApp Web's own in-memory data (chats, group metadata, contacts).
 *
 * Nothing leaves your browser: the Excel file is generated locally and downloaded.
 */
(function () {
  'use strict';

  if (window.__WAGX_LOADED__) return;
  window.__WAGX_LOADED__ = true;

  const TAG = '[WA Group Exporter]';
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const HEADERS = [
    'Country Code',
    'Country',
    'Phone Number',
    'Public Display Name',
    'Saved Name',
    'Group Name',
    'Is My Contact',
    'Is Business',
  ];
  const WIDTHS = [14, 24, 20, 30, 26, 34, 14, 12];

  // ------------------------------------------------------------------
  // 1. Access to WhatsApp Web internal modules
  // ------------------------------------------------------------------
  function metaRequire(name) {
    try {
      if (typeof window.require === 'function') return window.require(name);
    } catch (_) { /* module not found */ }
    return null;
  }

  // Legacy webpack fallback (older WhatsApp Web builds)
  let webpackReq = null;
  function legacyFind(predicate) {
    try {
      const chunkName = Object.keys(window).find((k) => k.startsWith('webpackChunk'));
      if (!chunkName) return null;
      if (!webpackReq) {
        window[chunkName].push([[Symbol('wagx')], {}, (r) => { webpackReq = r; }]);
      }
      if (!webpackReq) return null;
      for (const id of Object.keys(webpackReq.m)) {
        try {
          const mod = webpackReq(id);
          if (!mod) continue;
          if (predicate(mod)) return mod;
          if (mod.default && predicate(mod.default)) return mod.default;
        } catch (_) { /* ignore */ }
      }
    } catch (e) { warn('legacy lookup failed', e); }
    return null;
  }

  let STORE = null;
  function getStore() {
    if (STORE) return STORE;
    const col = metaRequire('WAWebCollections');
    if (col && col.Chat && col.Contact && col.GroupMetadata) {
      STORE = {
        Chat: col.Chat,
        Contact: col.Contact,
        GroupMetadata: col.GroupMetadata,
        ApiContact: metaRequire('WAWebApiContact'),
        WidFactory: metaRequire('WAWebWidFactory'),
        MeUser: metaRequire('WAWebUserPrefsMeUser'),
        GroupQuery: metaRequire('WAWebGroupQueryJob'),
      };
      return STORE;
    }
    const legacy = legacyFind((m) => m && m.Chat && m.Contact && m.GroupMetadata);
    if (legacy) {
      STORE = { Chat: legacy.Chat, Contact: legacy.Contact, GroupMetadata: legacy.GroupMetadata, Conn: legacy.Conn };
      return STORE;
    }
    return null;
  }

  function modelsOf(collection) {
    if (!collection) return [];
    if (typeof collection.getModelsArray === 'function') return collection.getModelsArray();
    if (Array.isArray(collection._models)) return collection._models;
    if (Array.isArray(collection.models)) return collection.models;
    if (Array.isArray(collection)) return collection;
    if (typeof collection.toArray === 'function') return collection.toArray();
    return [];
  }

  function widStr(wid) {
    if (!wid) return '';
    if (typeof wid === 'string') return wid;
    return wid._serialized || (typeof wid.toString === 'function' ? wid.toString() : '');
  }
  function widServer(wid) {
    if (!wid) return '';
    if (typeof wid === 'string') return wid.split('@')[1] || '';
    return wid.server || widStr(wid).split('@')[1] || '';
  }
  function widUser(wid) {
    if (!wid) return '';
    if (typeof wid === 'string') return wid.split('@')[0].split(':')[0];
    return String(wid.user || widStr(wid).split('@')[0]).split(':')[0];
  }

  function isGroupChat(chat) {
    try {
      return !!(chat && (chat.isGroup || widServer(chat.id) === 'g.us'));
    } catch (_) { return false; }
  }

  function chatTitle(chat) {
    return (
      chat.formattedTitle ||
      chat.name ||
      (chat.groupMetadata && chat.groupMetadata.subject) ||
      (chat.contact && (chat.contact.name || chat.contact.formattedName)) ||
      widUser(chat.id)
    );
  }

  function getMyNumber(S) {
    try {
      if (S.MeUser) {
        const me = (S.MeUser.getMaybeMePnUser && S.MeUser.getMaybeMePnUser()) ||
                   (S.MeUser.getMaybeMeUser && S.MeUser.getMaybeMeUser());
        if (me) return widUser(me);
      }
      if (S.Conn && S.Conn.wid) return widUser(S.Conn.wid);
    } catch (_) { /* ignore */ }
    return '';
  }

  async function waitForStore(timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const S = getStore();
      if (S && modelsOf(S.Chat).length > 0) return S;
      await sleep(1000);
    }
    return getStore();
  }

  // ------------------------------------------------------------------
  // 2. Data extraction
  // ------------------------------------------------------------------
  async function loadMetadata(S, chat) {
    const id = chat.id;
    let md = null;
    try { md = S.GroupMetadata.get(id); } catch (_) { /* ignore */ }
    if (md && modelsOf(md.participants).length) return md;

    // Ask WhatsApp to fetch metadata from the server
    try {
      if (typeof S.GroupMetadata.find === 'function') md = await S.GroupMetadata.find(id);
    } catch (e) { warn('GroupMetadata.find failed', e); }
    if (md && modelsOf(md.participants).length) return md;

    try {
      if (S.GroupQuery && typeof S.GroupQuery.queryAndUpdateGroupMetadataById === 'function') {
        await S.GroupQuery.queryAndUpdateGroupMetadataById({ id });
        md = S.GroupMetadata.get(id);
      }
    } catch (e) { warn('queryAndUpdateGroupMetadataById failed', e); }

    if (!md && chat.groupMetadata) md = chat.groupMetadata;
    return md;
  }

  function getContact(S, wid) {
    if (!wid) return null;
    try { return S.Contact.get(wid) || S.Contact.get(widStr(wid)) || null; } catch (_) { return null; }
  }

  // WhatsApp now addresses many group members by a private "LID" instead of the phone
  // number. Try every known way to map it back to a phone number.
  function resolvePhoneWid(S, participant, contact) {
    const id = participant.id;
    if (widServer(id) === 'c.us' || widServer(id) === 's.whatsapp.net') return id;

    const candidates = [
      participant.phoneNumber,
      contact && contact.phoneNumber,
    ];
    for (const c of candidates) {
      if (c && widServer(c) !== 'lid' && /^\d{6,}$/.test(widUser(c))) return c;
    }
    try {
      if (S.ApiContact && typeof S.ApiContact.getPhoneNumber === 'function') {
        const pn = S.ApiContact.getPhoneNumber(id);
        if (pn && /^\d{6,}$/.test(widUser(pn))) return pn;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function bool(v) { return v ? 'True' : 'False'; }

  function participantRow(S, participant, groupName) {
    const lidContact = getContact(S, participant.id);
    const pnWid = resolvePhoneWid(S, participant, lidContact);
    const pnContact = pnWid ? getContact(S, pnWid) : null;

    // Merge information from both the LID contact and the phone-number contact
    const pick = (key) => (pnContact && pnContact[key]) || (lidContact && lidContact[key]) || '';

    const digits = pnWid ? widUser(pnWid) : '';
    const { code, country } = digits ? WAGX_COUNTRIES.lookup(digits) : { code: '', country: 'Hidden' };

    const saved = pick('name');
    const publicName = pick('pushname') || pick('verifiedName') || pick('notifyName') || '';
    const isMyContact = !!((pnContact && pnContact.isMyContact) || (lidContact && lidContact.isMyContact));
    const isBusiness = !!(
      (pnContact && (pnContact.isBusiness || pnContact.isEnterprise)) ||
      (lidContact && (lidContact.isBusiness || lidContact.isEnterprise))
    );

    return {
      digits,
      row: [
        code ? Number(code) : '',
        country,
        digits ? '+' + digits : 'Hidden (privacy)',
        publicName,
        saved,
        groupName,
        bool(isMyContact),
        bool(isBusiness),
      ],
      isMyContact,
      sortName: (saved || publicName || digits).toLowerCase(),
    };
  }

  function sortEntries(entries) {
    return entries.sort((a, b) => {
      if (a.isMyContact !== b.isMyContact) return a.isMyContact ? -1 : 1;
      return a.sortName.localeCompare(b.sortName);
    });
  }

  async function extractGroups(S, chats, opts, onProgress) {
    const me = opts.excludeMe ? getMyNumber(S) : '';
    const perGroup = [];

    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i];
      const title = chatTitle(chat);
      onProgress(i, chats.length, title);
      const md = await loadMetadata(S, chat);
      const participants = md ? modelsOf(md.participants) : [];
      const groupName = (md && md.subject) || title;

      const entries = [];
      for (const p of participants) {
        try {
          const e = participantRow(S, p, groupName);
          if (me && e.digits === me) continue;
          entries.push(e);
        } catch (err) { warn('participant failed', err); }
      }
      perGroup.push({ name: groupName, entries: sortEntries(entries), ok: !!md });
      await sleep(150); // be gentle with WhatsApp servers
    }
    onProgress(chats.length, chats.length, '');
    return perGroup;
  }

  function dedupe(allEntries) {
    const map = new Map();
    const out = [];
    for (const e of allEntries) {
      const key = e.digits || null;
      if (key && map.has(key)) {
        const existing = map.get(key);
        const groups = existing.row[5].split(' | ');
        if (!groups.includes(e.row[5])) existing.row[5] += ' | ' + e.row[5];
        continue;
      }
      const copy = { ...e, row: e.row.slice() };
      if (key) map.set(key, copy);
      out.push(copy);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 3. File output
  // ------------------------------------------------------------------
  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function buildOutput(perGroup, opts) {
    const stamp = timestamp();
    if (opts.format === 'csv') {
      let entries = perGroup.flatMap((g) => g.entries);
      if (opts.dedupe) entries = dedupe(entries);
      const csvCell = (v) => {
        const s = String(v ?? '');
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [HEADERS, ...entries.map((e) => e.row)].map((r) => r.map(csvCell).join(','));
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      return { blob, filename: `WhatsApp_Group_Contacts_${stamp}.csv`, count: entries.length };
    }

    let sheets;
    let count = 0;
    if (opts.layout === 'per-group') {
      sheets = perGroup.map((g) => {
        count += g.entries.length;
        return { name: g.name, rows: [HEADERS, ...g.entries.map((e) => e.row)], widths: WIDTHS };
      });
    } else {
      let entries = perGroup.flatMap((g) => g.entries);
      if (opts.dedupe) entries = dedupe(entries);
      count = entries.length;
      sheets = [{ name: 'Contacts', rows: [HEADERS, ...entries.map((e) => e.row)], widths: WIDTHS }];
    }
    const summary = [['Group Name', 'Members Exported'], ...perGroup.map((g) => [g.name, g.entries.length])];
    sheets.push({ name: 'Summary', rows: summary, widths: [40, 18] });

    return { blob: WAGX_XLSX.build(sheets), filename: `WhatsApp_Group_Contacts_${stamp}.xlsx`, count };
  }

  // ------------------------------------------------------------------
  // 4. User interface (built with DOM APIs only — safe under Trusted Types)
  // ------------------------------------------------------------------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else if (v !== false && v != null) el.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  let overlay = null;

  function closeModal() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  async function openModal() {
    if (overlay) return;
    overlay = h('div', { class: 'wagx-overlay', onclick: (e) => { if (e.target === overlay && !busy) closeModal(); } });
    const panel = h('div', { class: 'wagx-panel' });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    panel.appendChild(h('div', { class: 'wagx-loading' }, 'Loading your WhatsApp groups…'));
    const S = await waitForStore(60000);
    panel.textContent = '';

    if (!S) {
      panel.append(
        h('h2', null, 'Could not read WhatsApp data'),
        h('p', null, 'Make sure WhatsApp Web is fully loaded (your chat list is visible), then reload the page and try again. ' +
          'If the problem continues, WhatsApp may have changed its internals — please open an issue on GitHub.'),
        h('div', { class: 'wagx-actions' }, h('button', { class: 'wagx-btn', onclick: closeModal }, 'Close'))
      );
      return;
    }

    const groups = modelsOf(S.Chat)
      .filter(isGroupChat)
      .map((chat) => ({ chat, title: chatTitle(chat), selected: false, row: null }))
      .sort((a, b) => a.title.localeCompare(b.title));

    renderPicker(S, panel, groups);
  }

  let busy = false;

  function renderPicker(S, panel, groups) {
    const countLabel = h('span', { class: 'wagx-count' });
    const updateCount = () => {
      const n = groups.filter((g) => g.selected).length;
      countLabel.textContent = `${n} of ${groups.length} groups selected`;
      exportBtn.disabled = n === 0 || busy;
    };

    const search = h('input', {
      class: 'wagx-search', type: 'search', placeholder: 'Search groups…',
      oninput: () => {
        const q = search.value.trim().toLowerCase();
        groups.forEach((g) => { g.row.style.display = !q || g.title.toLowerCase().includes(q) ? '' : 'none'; });
      },
    });

    const list = h('div', { class: 'wagx-list' });
    groups.forEach((g) => {
      const cb = h('input', { type: 'checkbox', onchange: () => { g.selected = cb.checked; updateCount(); } });
      g.cb = cb;
      let n = '';
      try {
        const md = S.GroupMetadata.get(g.chat.id);
        const c = md ? modelsOf(md.participants).length : 0;
        if (c) n = `${c} members`;
      } catch (_) { /* ignore */ }
      g.row = h('label', { class: 'wagx-item' }, cb, h('span', { class: 'wagx-title', dir: 'auto' }, g.title), h('span', { class: 'wagx-meta' }, n));
      list.appendChild(g.row);
    });
    if (!groups.length) list.appendChild(h('div', { class: 'wagx-empty' }, 'No groups found in this account.'));

    const setVisible = (val) => {
      groups.forEach((g) => { if (g.row.style.display !== 'none') { g.selected = val; g.cb.checked = val; } });
      updateCount();
    };

    const layoutSel = h('select', { class: 'wagx-select' },
      h('option', { value: 'single' }, 'One sheet — all groups together'),
      h('option', { value: 'per-group' }, 'One sheet per group'));
    const formatSel = h('select', { class: 'wagx-select' },
      h('option', { value: 'xlsx' }, 'Excel (.xlsx)'),
      h('option', { value: 'csv' }, 'CSV (.csv)'));
    const dedupeCb = h('input', { type: 'checkbox' });
    const excludeMeCb = h('input', { type: 'checkbox', checked: true });

    const progressBar = h('div', { class: 'wagx-progress-bar' });
    const progress = h('div', { class: 'wagx-progress', style: 'display:none' }, progressBar);
    const status = h('div', { class: 'wagx-status', dir: 'auto' });

    const exportBtn = h('button', {
      class: 'wagx-btn wagx-primary',
      onclick: async () => {
        const chosen = groups.filter((g) => g.selected).map((g) => g.chat);
        if (!chosen.length) return;
        busy = true; updateCount(); closeBtn.disabled = true;
        progress.style.display = '';
        try {
          const perGroup = await extractGroups(S, chosen, { excludeMe: excludeMeCb.checked }, (i, total, name) => {
            progressBar.style.width = `${Math.round((i / total) * 100)}%`;
            status.textContent = name ? `Reading ${i + 1}/${total}: ${name}` : 'Building file…';
          });
          const out = buildOutput(perGroup, {
            layout: layoutSel.value, format: formatSel.value, dedupe: dedupeCb.checked,
          });
          download(out.blob, out.filename);
          const failed = perGroup.filter((g) => !g.ok).map((g) => g.name);
          const hidden = perGroup.flatMap((g) => g.entries).filter((e) => !e.digits).length;
          status.textContent = `Done — exported ${out.count} rows from ${perGroup.length} group(s) to ${out.filename}.` +
            (hidden ? ` ${hidden} member(s) have hidden numbers.` : '') +
            (failed.length ? ` Could not load: ${failed.join(', ')}.` : '');
          log('export finished', out.filename, out.count);
        } catch (e) {
          warn(e);
          status.textContent = 'Export failed: ' + (e && e.message ? e.message : e);
        } finally {
          busy = false; closeBtn.disabled = false; updateCount();
        }
      },
    }, 'Export');
    const closeBtn = h('button', { class: 'wagx-btn', onclick: () => { if (!busy) closeModal(); } }, 'Close');

    panel.append(
      h('div', { class: 'wagx-header' },
        h('h2', null, 'Export Group Contacts'),
        h('button', { class: 'wagx-x', title: 'Close', onclick: () => { if (!busy) closeModal(); } }, '×')),
      h('div', { class: 'wagx-toolbar' },
        search,
        h('button', { class: 'wagx-link', onclick: () => setVisible(true) }, 'Select all'),
        h('button', { class: 'wagx-link', onclick: () => setVisible(false) }, 'Clear')),
      list,
      h('div', { class: 'wagx-options' },
        h('label', null, 'Layout ', layoutSel),
        h('label', null, 'Format ', formatSel),
        h('label', { class: 'wagx-check' }, dedupeCb, ' Remove duplicate numbers (merge group names)'),
        h('label', { class: 'wagx-check' }, excludeMeCb, ' Exclude my own number')),
      progress,
      status,
      h('div', { class: 'wagx-actions' }, countLabel, closeBtn, exportBtn)
    );
    updateCount();
    search.focus();
  }

  function injectLauncher() {
    if (document.getElementById('wagx-launcher')) return;
    const btn = h('button', { id: 'wagx-launcher', title: 'Export WhatsApp group contacts to Excel', onclick: openModal },
      h('span', { class: 'wagx-icon' }, '⬇'), ' Export Groups');
    document.body.appendChild(btn);
  }

  // Wait for body, then add the launcher button
  const boot = () => { if (document.body) injectLauncher(); else setTimeout(boot, 500); };
  boot();
  // WhatsApp re-renders a lot; make sure the button survives
  setInterval(injectLauncher, 5000);

  // Expose a small API for power users / debugging in DevTools
  window.WAGX = {
    open: openModal,
    diagnose() {
      const S = getStore();
      const info = {
        hasRequire: typeof window.require === 'function',
        storeFound: !!S,
        chats: S ? modelsOf(S.Chat).length : 0,
        groups: S ? modelsOf(S.Chat).filter(isGroupChat).length : 0,
        contacts: S ? modelsOf(S.Contact).length : 0,
        apiContact: !!(S && S.ApiContact),
      };
      console.table(info);
      return info;
    },
  };
  log('loaded — click "Export Groups" (bottom-right) or run WAGX.open()');
})();
