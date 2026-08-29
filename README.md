# Southeast Pet 2026 Trade Show Order Builder

Single-page web app that turns the PDF trade show book into a tablet-friendly order form. Built for the 2026 show only — the PDF won't change, so this is one-shot.

## How it works

- Loads the trade show PDF in the browser (PDF.js) and overlays invisible input fields on every qty cell.
- You type quantities per vendor page; autosave to localStorage every keystroke.
- Service worker caches everything on first load, so the app works offline thereafter.
- On Submit, fills the AcroForm in the PDF, flattens it, and downloads both the filled PDF and a CSV.

## Setup

1. Enable GitHub Pages on this repo (Settings → Pages → Source: `main`, `/ (root)`).
2. Visit the URL on the iPad once on home wifi to let the Service Worker cache the assets.
3. Bookmark the URL.

## Backup / recovery

- **Backup JSON button** in the toolbar → downloads the current order state. Drop it in a Drive folder before each session.
- **Restore JSON button** → picks a backup from Files.
- All order state lives in `localStorage` per origin. If Safari data is cleared, the most recent backup can be restored.

## Files

- `app/index.html` — page shell
- `app/app.js` — all client logic
- `app/data/data.json` — parsed PDF widget index (regenerable via `scripts/parse_pdf.py`)
- `app/assets/2026-Trade-Show-Book.pdf` — source PDF
- `sw.js` — Service Worker (offline cache)
- `scripts/parse_pdf.py` — rebuilds `data.json` from the PDF

## Rebuilding data.json

```
pip install pymupdf
python3 scripts/parse_pdf.py
```

Only needed if the source PDF changes.

## Buyer line

Store name + city/state entered at the top of the page is written to every "STORE NAME & CITY/STATE" field on every page on submit, matching the printed dead-tree layout.

## Notes per vendor

Each vendor page has a notes field (e.g. rep conversations, special instructions). Saved with the rest of the order.
