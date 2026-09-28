<div align="center">

<img src="icons/icon128.png" width="96" alt="logo">

# WhatsApp Contacts & Groups Exporter

**Export your WhatsApp contacts, the people you chat with, and the members of your groups to Excel with one click, straight from WhatsApp Web in Chrome.**

Phone number · Country · Public name · Saved name · Group / Source · Contact & Business flags · Last chat

![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-00a884)
![No dependencies](https://img.shields.io/badge/dependencies-0-00a884)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## ✨ Features

**Two export modes, in one window:**

| Mode | What it exports |
|---|---|
| **Group members** | Every participant of the groups you pick |
| **Chats & contacts** | Everyone you have an individual chat with (archived chats included), and optionally every saved contact who uses WhatsApp |

- **One-click export**: a green **WA Export** button appears inside WhatsApp Web.
- **Pick any groups**: search, select all or clear, and see member counts.
- **Excel (.xlsx) or CSV**: Arabic and emoji names stay intact.
- **Group layouts**: one combined sheet, or one sheet per group.
- **Summary sheet**: totals, plus a per-country breakdown for contacts.
- **Remove duplicates**: each number appears once. The group names or sources it came from are merged.
- **Exclude your own number** (on by default). Broadcast lists and channels are always skipped.
- **Smart sorting**: groups list saved contacts first, and chats list the most recent conversation first.
- **100% local**: nothing is uploaded, and there is no server, analytics or tracking. The file is built in your browser.
- **No dependencies**: it ships its own small XLSX writer.

## 📊 Output columns

**Group members**

| Column | Example | Source |
|---|---|---|
| Country Code | `966` | Derived from the phone number |
| Country | `Saudi Arabia` | Derived from the phone number |
| Phone Number | `+966506724188` | Group participant |
| Public Display Name | `M.N` | The name the person set in WhatsApp ("pushname") |
| Saved Name | `Maher` | The name in *your* phone contacts |
| Group Name | `Riyadh Tech Group` | Group subject |
| Is My Contact | `True` / `False` | Saved in your contacts? |
| Is Business | `True` / `False` | WhatsApp Business account? |

**Chats & contacts**: the same columns, except that *Group Name* becomes **Source** (`Chat`, `Saved contact` or both), plus a **Last Chat** column (`2026-09-27 20:13`).

A sample file is included: [`docs/sample-output.xlsx`](docs/sample-output.xlsx).

| Group members | Chats & contacts |
|---|---|
| ![Groups](docs/screenshot.png) | ![Contacts](docs/screenshot-contacts.png) |

---

## 🚀 Installation

The extension isn't on the Chrome Web Store, so you install it in *Developer mode*. It takes about a minute.

### Option A: download a release (easiest)

1. Go to the [**Releases**](../../releases) page and download `wa-group-exporter-x.y.z.zip`.
2. **Unzip** it into a folder you'll keep. Don't delete that folder later, or Chrome will remove the extension.
3. Continue with **Load into Chrome** below.

### Option B: clone the repository

```bash
git clone https://github.com/<your-username>/whatsapp-group-contacts-exporter.git
```

Or click **Code → Download ZIP** on GitHub and unzip it.

### Load into Chrome

1. Open `chrome://extensions` in the address bar.
2. Turn on **Developer mode** (the toggle at the top-right).
3. Click **Load unpacked**.
4. Select the folder that contains **`manifest.json`**.
5. *(Optional)* Click the 🧩 puzzle icon in the toolbar and **pin** the extension.

It also works in **Microsoft Edge** (`edge://extensions`), **Brave** (`brave://extensions`), **Opera** and other Chromium browsers running version **111 or newer**.

---

## 🧭 How to use

1. Open **[web.whatsapp.com](https://web.whatsapp.com)** and log in by scanning the QR code with your phone.
2. Wait until your chat list has fully loaded.
3. Click the green **⬇ WA Export** button in the bottom-right corner, or click the extension icon and then **Open export window**.

**To export group members** (the *Group members* tab):

4. Tick the groups you want. Use the search box to filter.
5. Choose the options:
   - **Layout**: *One sheet* (all groups together) or *One sheet per group*
   - **Format**: *Excel (.xlsx)* or *CSV*
   - **Remove duplicate numbers**
   - **Exclude my own number**
6. Click **Export**. The file downloads as `WhatsApp_Group_Contacts_YYYY-MM-DD_HH-mm.xlsx`.

**To export chats & contacts** (the *Chats & contacts* tab):

4. Tick **People I have chatted with**, **All saved contacts on WhatsApp**, or both.
5. Pick the format and click **Export**. The file downloads as `WhatsApp_Contacts_YYYY-MM-DD_HH-mm.xlsx`.

> 💡 **Large exports:** the tool reads groups one by one with a short pause between them. Keep the tab open until the progress bar finishes.

---

## ❓ FAQ & troubleshooting

**The "WA Export" button doesn't appear.**
Click the extension icon in the Chrome toolbar and choose **Open export window**. This loads the exporter into the WhatsApp tab on demand and opens the export window directly.
If that doesn't work either, reload WhatsApp Web (`Ctrl+R`). Then check at `chrome://extensions` that the extension is enabled and shows no errors. If it still doesn't appear, open DevTools (`F12`) → **Console** and look for `[WA Group Exporter] loaded`.

**Some rows say `Hidden (privacy)`.**
WhatsApp now hides some members' phone numbers in certain groups (large groups, communities, or when a member uses the "hide phone number" privacy setting). The tool fills in the number whenever WhatsApp Web knows it, for example when the person is in your contacts or has messaged you. Otherwise only the name is exported. This is a WhatsApp privacy feature and cannot be bypassed.

**"Saved Name" is empty for many people.**
That column only has a value for people saved in *your* phone contacts. That is expected.

**A group shows 0 members or fails to load.**
Open that group once in WhatsApp Web so it syncs, then export again.

**Excel shows Arabic text wrongly in the CSV.**
Use the **.xlsx** format, or in Excel go to *Data → From Text/CSV* and choose **UTF-8**.

**It stopped working after a WhatsApp update.**
WhatsApp Web changes its internals from time to time. Open DevTools → Console, run `WAGX.diagnose()`, and [open an issue](../../issues) with the output.

---

## 🛠️ How it works (for developers)

```
manifest.json          Manifest V3: content script injected into web.whatsapp.com (MAIN world)
src/content.js         Reads WhatsApp Web's in-memory data, builds the UI, runs the export
src/xlsx-writer.js     Tiny dependency-free XLSX (Office Open XML) + ZIP writer
src/countries.js       Calling-code → country lookup (longest-prefix match)
src/styles.css         UI styles (light & dark theme aware)
popup/                 Toolbar popup with usage instructions
scripts/package.sh     Builds dist/wa-group-exporter-<version>.zip
.github/workflows/     Attaches the zip to a GitHub Release on every v* tag
```

- The content script runs in the page's **MAIN world**, so it can use WhatsApp Web's own module loader (`require('WAWebCollections')`). That gives it the `Chat`, `Contact` and `GroupMetadata` collections, the same data WhatsApp uses to draw the group info screen. For older WhatsApp builds there is a fallback to the legacy webpack chunk.
- Group participants come from `GroupMetadata`. If metadata isn't cached yet, it is fetched with `GroupMetadata.find()`.
- Members addressed by a privacy ID (`@lid`) are mapped back to a phone number through `participant.phoneNumber`, `contact.phoneNumber` or `WAWebApiContact.getPhoneNumber()` when WhatsApp exposes it.
- The UI is built with plain DOM APIs (no `innerHTML`), so it works with WhatsApp's Trusted Types CSP.
- **Permissions:** only `https://web.whatsapp.com/*`. There are no background scripts, no remote code and no network requests.

**DevTools helpers:** `WAGX.open()` opens the export window and `WAGX.diagnose()` prints a status table.

### Releasing a new version

```bash
# 1. bump "version" in manifest.json and add a CHANGELOG entry
git commit -am "Release v1.0.1"
git tag v1.0.1
git push && git push --tags      # GitHub Actions builds the zip and creates the Release
```

To build the zip locally, run `./scripts/package.sh`.

---

## ⚖️ Responsible use & disclaimer

- This project is **not affiliated with, endorsed by, or connected to WhatsApp or Meta**. "WhatsApp" is a trademark of its respective owner.
- The tool only reads data your own WhatsApp account can already see in groups you belong to.
- Automated extraction may be against [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service). Use it at your own risk.
- Exported phone numbers are **personal data**. Handle them lawfully and follow your local privacy law (for example Saudi PDPL, EU GDPR or Egypt Law 151/2020). **Do not use this tool for spam or unsolicited bulk messaging.** Bulk messaging can get your WhatsApp number banned.

## 📄 License

[MIT](LICENSE)
