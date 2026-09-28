# Changelog

## [1.0.1] — 2026-09-28
### Fixed
- Toolbar popup: "Open / reload WhatsApp Web" now actually reloads an already-open WhatsApp tab.
- Export button is attached to the page root so WhatsApp re-rendering cannot remove it.
### Added
- Popup "Open export window" button that injects the exporter on demand if the automatic button does not appear.
- Popup status line showing whether the exporter is active on WhatsApp Web.

## [1.0.0] — 2026-09-28
### Added
- "Export Groups" button inside WhatsApp Web.
- Group picker with search, select all / clear, and member counts.
- Excel (.xlsx) and CSV export with the columns: Country Code, Country, Phone Number, Public Display Name, Saved Name, Group Name, Is My Contact, Is Business.
- Layouts: one combined sheet, or one sheet per group, plus a Summary sheet.
- Option to remove duplicate numbers across groups (group names are merged).
- Option to exclude your own number.
- Support for WhatsApp's hidden-number (LID) members, resolving the phone number when WhatsApp exposes it.
- Built-in, dependency-free XLSX writer (Arabic and emoji safe).
