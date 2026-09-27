document.getElementById('open').addEventListener('click', async () => {
  const [existing] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
  }
  window.close();
});
