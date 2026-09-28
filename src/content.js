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
  // Every lookup attempt is recorded here so failures can be diagnosed from the UI.
  const DIAG = [];
  const DIAG_SEEN = new Set();
  function note(msg) { if (!DIAG_SEEN.has(msg) && DIAG.length < 200) { DIAG_SEEN.add(msg); DIAG.push(msg); } }

  // WhatsApp Web ships Meta's module system. Depending on the build, modules are
  // reachable through window.require, importNamespace or importDefault.
  function loaders() {
    const out = [];
    for (const key of ['require', 'importNamespace', 'importDefault']) {
      if (typeof window[key] === 'function') out.push([key, window[key]]);
    }
    return out;
  }

  const MISSING = new Set();
  function metaRequire(name) {
    for (const [key, fn] of loaders()) {
      try {
        const m = fn(name);
        if (m) return m;
      } catch (e) {
        if (!MISSING.has(key + ':' + name)) {
          MISSING.add(key + ':' + name);
          note(`${key}('${name}') -> ${String(e && e.message || e).slice(0, 120)}`);
        }
      }
    }
    return null;
  }

  function isCollection(c) {
    return !!(c && typeof c === 'object' && (typeof c.getModelsArray === 'function' || Array.isArray(c._models)) && typeof c.get === 'function');
  }

  // Pick a collection out of a module's exports, trying the usual export names.
  function pickCollection(mod, names) {
    if (!mod) return null;
    for (const n of names) if (isCollection(mod[n])) return mod[n];
    if (isCollection(mod.default)) return mod.default;
    if (isCollection(mod)) return mod;
    return null;
  }

  // List all registered module names (Meta module system debug registry).
  function allModuleNames() {
    const dbg = metaRequire('__debug');
    const map = dbg && (dbg.modulesMap || dbg.modules);
    if (map && typeof map === 'object') return Object.keys(map);
    return [];
  }

  // Legacy webpack fallback (older WhatsApp Web builds)
  let webpackReq = null;
  function legacyFind(predicate) {
    try {
      const chunkName = Object.keys(window).find((k) => k.startsWith('webpackChunk'));
      if (!chunkName) return null;
      note('webpack chunk found: ' + chunkName);
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
    } catch (e) { note('legacy webpack lookup failed: ' + (e && e.message)); }
    return null;
  }

  function finishStore(S) {
    S.ApiContact = S.ApiContact || metaRequire('WAWebApiContact');
    S.MeUser = S.MeUser || metaRequire('WAWebUserPrefsMeUser');
    S.GroupQuery = S.GroupQuery || metaRequire('WAWebGroupQueryJob');
    return S;
  }

  let STORE = null;
  let lastScan = 0;
  function getStore() {
    if (STORE) return STORE;

    // Strategy 1: the combined collections module
    const col = metaRequire('WAWebCollections');
    let Chat = col && pickCollection(col, ['Chat', 'ChatCollection']);
    let Contact = col && pickCollection(col, ['Contact', 'ContactCollection']);
    let GroupMetadata = col && pickCollection(col, ['GroupMetadata', 'GroupMetadataCollection']);

    // Strategy 2: individual collection modules
    if (!Chat) Chat = pickCollection(metaRequire('WAWebChatCollection'), ['ChatCollection', 'Chat']);
    if (!Contact) Contact = pickCollection(metaRequire('WAWebContactCollection'), ['ContactCollection', 'Contact']);
    if (!GroupMetadata) GroupMetadata = pickCollection(metaRequire('WAWebGroupMetadataCollection'), ['GroupMetadataCollection', 'GroupMetadata']);

    // Strategy 3: scan the module registry for anything exporting these collections
    if ((!Chat || !Contact || !GroupMetadata) && Date.now() - lastScan > 10000) {
      lastScan = Date.now();
      const names = allModuleNames();
      if (names.length) {
        note(`module registry: ${names.length} modules`);
        const candidates = names.filter((n) => /Collection|Store/i.test(n));
        for (const n of candidates) {
          let m;
          m = metaRequire(n);
          if (!m || typeof m !== 'object') continue;
          if (!Chat && (isCollection(m.Chat) || isCollection(m.ChatCollection))) Chat = isCollection(m.Chat) ? m.Chat : m.ChatCollection;
          if (!Contact && (isCollection(m.Contact) || isCollection(m.ContactCollection))) Contact = isCollection(m.Contact) ? m.Contact : m.ContactCollection;
          if (!GroupMetadata && (isCollection(m.GroupMetadata) || isCollection(m.GroupMetadataCollection))) GroupMetadata = isCollection(m.GroupMetadata) ? m.GroupMetadata : m.GroupMetadataCollection;
          if (Chat && Contact && GroupMetadata) { note('found collections via registry module ' + n); break; }
        }
      }
    }

    if (Chat && Contact && GroupMetadata) {
      STORE = finishStore({ Chat, Contact, GroupMetadata });
      return STORE;
    }

    // Strategy 4: legacy webpack builds
    const legacy = legacyFind((m) => m && m.Chat && m.Contact && m.GroupMetadata);
    if (legacy) {
      STORE = finishStore({ Chat: legacy.Chat, Contact: legacy.Contact, GroupMetadata: legacy.GroupMetadata, Conn: legacy.Conn });
      return STORE;
    }
    note(`partial: Chat=${!!Chat} Contact=${!!Contact} GroupMetadata=${!!GroupMetadata}`);
    return null;
  }

  function diagnostics() {
    const names = (() => { try { return allModuleNames(); } catch (_) { return []; } })();
    const interesting = names.filter((n) => /^WAWeb.*(Collection|Contact|GroupMetadata|Chat)$/i.test(n)).slice(0, 60);
    const lines = [
      'WA Group Exporter diagnostics',
      'URL: ' + location.href,
      'UA: ' + navigator.userAgent,
      'WA version: ' + ((window.Debug && window.Debug.VERSION) || 'unknown'),
      'typeof require: ' + typeof window.require + ', importNamespace: ' + typeof window.importNamespace +
        ', importDefault: ' + typeof window.importDefault + ', __d: ' + typeof window.__d,
      'webpack chunks: ' + (Object.keys(window).filter((k) => k.startsWith('webpackChunk')).join(',') || 'none'),
      'registry modules: ' + names.length,
      'store found: ' + !!STORE,
      'matching modules: ' + (interesting.join(', ') || 'none'),
      '--- attempts ---',
      ...DIAG.slice(-40),
    ];
    return lines.join('\n');
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
  // 2b. Individual chats & saved contacts
  // ------------------------------------------------------------------
  const CONTACT_HEADERS = [
    'Country Code', 'Country', 'Phone Number', 'Public Display Name', 'Saved Name',
    'Source', 'Is My Contact', 'Is Business', 'Last Chat',
  ];
  const CONTACT_WIDTHS = [14, 24, 20, 30, 26, 24, 14, 12, 18];
  const PERSON_SERVERS = new Set(['c.us', 's.whatsapp.net', 'lid']);

  function isPersonChat(chat) {
    try {
      return !!chat && !isGroupChat(chat) && PERSON_SERVERS.has(widServer(chat.id)) && !chat.isNewsletter && !chat.isBroadcast;
    } catch (_) { return false; }
  }

  function isSavedPerson(ct) {
    try {
      return !!ct && ct.isMyContact && !ct.isGroup && PERSON_SERVERS.has(widServer(ct.id));
    } catch (_) { return false; }
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function listPersonChats(S) { return modelsOf(S.Chat).filter(isPersonChat); }
  function listSavedContacts(S) { return modelsOf(S.Contact).filter(isSavedPerson); }

  async function extractContacts(S, opts, onProgress) {
    const me = opts.excludeMe ? getMyNumber(S) : '';
    const byKey = new Map();

    const add = (wid, source, ts, skipIfHidden) => {
      const base = participantRow(S, { id: wid }, source);
      if (me && base.digits === me) return;
      if (!base.digits && skipIfHidden) return;
      const key = base.digits || widStr(wid);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        existing.ts = Math.max(existing.ts, ts || 0);
        return;
      }
      byKey.set(key, { ...base, sources: [source], ts: ts || 0 });
    };

    const chats = opts.chats ? listPersonChats(S) : [];
    const saved = opts.saved ? listSavedContacts(S) : [];
    const total = chats.length + saved.length;
    let i = 0;

    for (const chat of chats) {
      try { add(chat.id, 'Chat', Number(chat.t) || 0, false); } catch (e) { warn('chat failed', e); }
      if (++i % 200 === 0) { onProgress(i, total, 'chats'); await sleep(0); }
    }
    for (const ct of saved) {
      // Saved contacts can appear twice (phone-number entry + private LID entry);
      // unresolved LID entries are skipped to avoid "Hidden" duplicates.
      try { add(ct.id, 'Saved contact', 0, widServer(ct.id) === 'lid'); } catch (e) { warn('contact failed', e); }
      if (++i % 200 === 0) { onProgress(i, total, 'contacts'); await sleep(0); }
    }
    onProgress(total, total, '');

    const entries = [...byKey.values()].map((e) => {
      const row = e.row.slice(0, 5).concat([e.sources.join(', '), e.row[6], e.row[7], fmtDate(e.ts)]);
      return { ...e, row };
    });
    // Most recent conversations first, then saved-only contacts alphabetically
    entries.sort((a, b) => (b.ts - a.ts) || a.sortName.localeCompare(b.sortName));
    return { entries, chatCount: chats.length, savedCount: saved.length };
  }

  function buildContactsOutput(result, format) {
    const stamp = timestamp();
    const rows = [CONTACT_HEADERS, ...result.entries.map((e) => e.row)];
    if (format === 'csv') {
      const csvCell = (v) => {
        const s = String(v ?? '');
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
      return { blob, filename: `WhatsApp_Contacts_${stamp}.csv`, count: result.entries.length };
    }
    const e = result.entries;
    const summary = [
      ['Metric', 'Count'],
      ['Total exported', e.length],
      ['From individual chats', e.filter((x) => x.sources.includes('Chat')).length],
      ['Saved contacts', e.filter((x) => x.isMyContact).length],
      ['Not in my contacts', e.filter((x) => !x.isMyContact).length],
      ['Business accounts', e.filter((x) => x.row[7] === 'True').length],
      ['Hidden numbers', e.filter((x) => !x.digits).length],
    ];
    const byCountry = new Map();
    e.forEach((x) => byCountry.set(x.row[1], (byCountry.get(x.row[1]) || 0) + 1));
    summary.push([], ['Country', 'Count'], ...[...byCountry.entries()].sort((a, b) => b[1] - a[1]));
    const blob = WAGX_XLSX.build([
      { name: 'Contacts', rows, widths: CONTACT_WIDTHS },
      { name: 'Summary', rows: summary, widths: [28, 12] },
    ]);
    return { blob, filename: `WhatsApp_Contacts_${stamp}.xlsx`, count: e.length };
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
      const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
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
    (document.body || document.documentElement).appendChild(overlay);

    panel.appendChild(h('div', { class: 'wagx-loading' }, 'Loading your WhatsApp data…'));
    const S = await waitForStore(20000);
    panel.textContent = '';

    if (!S) {
      const diag = diagnostics();
      console.warn(TAG, diag);
      const box = h('textarea', { class: 'wagx-diag', readonly: true, dir: 'ltr' });
      box.value = diag;
      const copyBtn = h('button', {
        class: 'wagx-btn wagx-primary',
        onclick: async () => {
          try { await navigator.clipboard.writeText(diag); copyBtn.textContent = 'Copied ✔'; }
          catch (_) { box.select(); document.execCommand('copy'); copyBtn.textContent = 'Copied ✔'; }
        },
      }, 'Copy diagnostics');
      panel.append(
        h('h2', null, 'Could not read WhatsApp data'),
        h('p', null, 'Make sure WhatsApp Web is fully loaded (your chat list is visible), then try again. ' +
          'If it keeps failing, WhatsApp changed its internals — copy the diagnostics below and send them to the developer.'),
        box,
        h('div', { class: 'wagx-actions' },
          h('button', { class: 'wagx-btn', onclick: closeModal }, 'Close'),
          h('button', { class: 'wagx-btn', onclick: () => { closeModal(); openModal(); } }, 'Retry'),
          copyBtn)
      );
      return;
    }

    renderMode(S, panel, 'groups');
  }

  function renderMode(S, panel, mode) {
    if (busy) return;
    panel.textContent = '';
    const tab = (id, label) => h('button', {
      class: 'wagx-tab' + (mode === id ? ' wagx-tab-active' : ''),
      onclick: () => { if (mode !== id) renderMode(S, panel, id); },
    }, label);
    panel.append(
      h('div', { class: 'wagx-header' },
        h('h2', null, 'WhatsApp Exporter'),
        h('button', { class: 'wagx-x', title: 'Close', onclick: () => { if (!busy) closeModal(); } }, '×')),
      h('div', { class: 'wagx-tabs' }, tab('groups', 'Group members'), tab('contacts', 'Chats & contacts'))
    );
    if (mode === 'contacts') {
      renderContacts(S, panel);
    } else {
      const groups = modelsOf(S.Chat)
        .filter(isGroupChat)
        .map((chat) => ({ chat, title: chatTitle(chat), selected: false, row: null }))
        .sort((a, b) => a.title.localeCompare(b.title));
      renderPicker(S, panel, groups);
    }
  }

  function renderContacts(S, panel) {
    const nChats = listPersonChats(S).length;
    const nSaved = listSavedContacts(S).length;

    const chatsCb = h('input', { type: 'checkbox', checked: true, onchange: () => update() });
    const savedCb = h('input', { type: 'checkbox', onchange: () => update() });
    const excludeMeCb = h('input', { type: 'checkbox', checked: true });
    const formatSel = h('select', { class: 'wagx-select' },
      h('option', { value: 'xlsx' }, 'Excel (.xlsx)'),
      h('option', { value: 'csv' }, 'CSV (.csv)'));

    const progressBar = h('div', { class: 'wagx-progress-bar' });
    const progress = h('div', { class: 'wagx-progress', style: 'display:none' }, progressBar);
    const status = h('div', { class: 'wagx-status', dir: 'auto' });
    const countLabel = h('span', { class: 'wagx-count' });

    const exportBtn = h('button', {
      class: 'wagx-btn wagx-primary',
      onclick: async () => {
        busy = true; update(); closeBtn.disabled = true;
        progress.style.display = '';
        try {
          const result = await extractContacts(S, {
            chats: chatsCb.checked, saved: savedCb.checked, excludeMe: excludeMeCb.checked,
          }, (i, total, what) => {
            progressBar.style.width = `${total ? Math.round((i / total) * 100) : 100}%`;
            status.textContent = what ? `Reading ${what}… ${i}/${total}` : 'Building file…';
          });
          const out = buildContactsOutput(result, formatSel.value);
          download(out.blob, out.filename);
          const hidden = result.entries.filter((e) => !e.digits).length;
          status.textContent = `Done — exported ${out.count} people to ${out.filename}.` +
            (hidden ? ` ${hidden} have hidden numbers.` : '');
        } catch (e) {
          warn(e);
          status.textContent = 'Export failed: ' + (e && e.message ? e.message : e);
        } finally {
          busy = false; closeBtn.disabled = false; update();
        }
      },
    }, 'Export');
    const closeBtn = h('button', { class: 'wagx-btn', onclick: () => { if (!busy) closeModal(); } }, 'Close');

    function update() {
      const n = (chatsCb.checked ? nChats : 0) + (savedCb.checked ? nSaved : 0);
      countLabel.textContent = n ? `up to ${n.toLocaleString()} people` : 'Choose at least one source';
      exportBtn.disabled = busy || n === 0;
    }

    const source = (cb, title, desc, count) => h('label', { class: 'wagx-source' }, cb,
      h('span', { class: 'wagx-source-text' },
        h('span', { class: 'wagx-source-title' }, title),
        h('span', { class: 'wagx-meta' }, desc)),
      h('span', { class: 'wagx-source-count' }, count.toLocaleString()));

    panel.append(
      h('p', null, 'Export everyone you have a one-to-one chat with, and optionally every saved contact that uses WhatsApp.'),
      h('div', { class: 'wagx-sources' },
        source(chatsCb, 'People I have chatted with', 'Every individual chat in WhatsApp Web, including archived chats', nChats),
        source(savedCb, 'All saved contacts on WhatsApp', 'Your phone book contacts who use WhatsApp, even with no chat', nSaved)),
      h('div', { class: 'wagx-options' },
        h('label', null, 'Format ', formatSel),
        h('label', { class: 'wagx-check' }, excludeMeCb, ' Exclude my own number')),
      h('p', { class: 'wagx-hint' }, 'Note: only chats synced to WhatsApp Web are included. Very old chats you deleted from your phone won\'t appear.'),
      progress,
      status,
      h('div', { class: 'wagx-actions' }, countLabel, closeBtn, exportBtn)
    );
    update();
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
    const btn = h('button', { id: 'wagx-launcher', title: 'Export WhatsApp contacts & group members to Excel', onclick: openModal },
      h('span', { class: 'wagx-icon' }, '⬇'), ' WA Export');
    // Attach to <html> rather than <body> so WhatsApp re-rendering the body can't remove it
    document.documentElement.appendChild(btn);
  }

  // Wait for body, then add the launcher button
  const boot = () => { if (document.documentElement) injectLauncher(); else setTimeout(boot, 500); };
  boot();
  // WhatsApp re-renders a lot; make sure the button survives
  setInterval(injectLauncher, 3000);

  // Expose a small API for power users / debugging in DevTools
  window.WAGX = {
    open: openModal,
    openContacts: async () => { await openModal(); const S = getStore(); const panel = overlay && overlay.querySelector('.wagx-panel'); if (S && panel) renderMode(S, panel, 'contacts'); },
    diagnose() {
      const S = getStore();
      const info = {
        hasRequire: typeof window.require === 'function',
        storeFound: !!S,
        chats: S ? modelsOf(S.Chat).length : 0,
        groups: S ? modelsOf(S.Chat).filter(isGroupChat).length : 0,
        personChats: S ? listPersonChats(S).length : 0,
        savedContacts: S ? listSavedContacts(S).length : 0,
        contacts: S ? modelsOf(S.Contact).length : 0,
        apiContact: !!(S && S.ApiContact),
      };
      console.table(info);
      console.log(diagnostics());
      return info;
    },
  };
  log('loaded — click "WA Export" (bottom-right) or run WAGX.open()');
})();
