const WA_URL = 'https://web.whatsapp.com/';
const statusEl = document.getElementById('status');
const exportBtn = document.getElementById('export');
const reloadBtn = document.getElementById('reload');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

async function findWaTab() {
  // Prefer the active tab if it is WhatsApp, otherwise any WhatsApp tab.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && active.url && active.url.startsWith(WA_URL)) return active;
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  return tabs[0] || null;
}

// Make sure the exporter is running inside the WhatsApp tab.
// If the automatic content script did not load, inject it now.
async function ensureInjected(tab) {
  const [{ result: present } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => typeof window.WAGX === 'object',
  });
  if (present) return 'already';

  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/styles.css'] });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    files: ['src/countries.js', 'src/xlsx-writer.js', 'src/content.js'],
  });
  return 'injected';
}

async function refreshStatus() {
  try {
    const tab = await findWaTab();
    if (!tab) {
      setStatus('WhatsApp Web is not open. Click "Open / reload WhatsApp Web".');
      exportBtn.disabled = true;
      return;
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => ({
        loaded: typeof window.WAGX === 'object',
        waReady: typeof window.require === 'function',
      }),
    });
    if (result && result.loaded) setStatus('Exporter is active on WhatsApp Web ✔', 'ok');
    else setStatus('WhatsApp Web is open. Click "Open export window" to start.');
    exportBtn.disabled = false;
  } catch (e) {
    setStatus('Cannot access the WhatsApp tab: ' + (e.message || e), 'err');
  }
}

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  try {
    const tab = await findWaTab();
    if (!tab) { setStatus('Open WhatsApp Web first.', 'err'); return; }
    await ensureInjected(tab);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => window.WAGX && window.WAGX.open(),
    });
    window.close();
  } catch (e) {
    setStatus('Error: ' + (e.message || e), 'err');
    exportBtn.disabled = false;
  }
});

reloadBtn.addEventListener('click', async () => {
  try {
    const tab = await findWaTab();
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.reload(tab.id);
    } else {
      await chrome.tabs.create({ url: WA_URL });
    }
    window.close();
  } catch (e) {
    setStatus('Error: ' + (e.message || e), 'err');
  }
});

refreshStatus();
