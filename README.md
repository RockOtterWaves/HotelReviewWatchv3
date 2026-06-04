# 🏨 Hotel Review Tracker

Tracks new reviews monthly across Booking.com, Expedia, Airbnb, and Google Business Profile for 16 properties. Runs free on GitHub Actions, results on a GitHub Pages dashboard.

---

## Quick Start (new repo setup)

### 1. Fork / create repo, upload these files

### 2. Run the URL finder to fill in missing links (optional but recommended)
```bash
cd scraper
npm install
npm run search
# → prompts for hotel name + address
# → auto-finds Booking.com, Expedia, Google URLs
# → Airbnb URLs are already pre-filled in properties.json
```

### 3. Enable GitHub Actions
Repo → **Actions** tab → "I understand, enable workflows"

### 4. Enable GitHub Pages
**Settings → Pages → Source: Deploy from branch → main → /dashboard**

Dashboard URL: `https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/`

### 5. Run baseline FIRST (important!)
**Actions → Monthly Review Scraper → Run workflow → mode: baseline**

This stores current Airbnb total counts so next month's delta can be calculated.

### 6. Automatic monthly runs
The scraper runs automatically on the **7th of each month at 9 AM PST**.

---

## Modes

| Mode | Command | When to use |
|------|---------|-------------|
| `baseline` | `node index.js --baseline` | First-ever run — stores Airbnb totals |
| `monthly` | `node index.js` | Normal monthly run (7th of month) |
| `dry-run` | `node index.js --dry-run` | Validate config, no scraping |
| `--month YYYY-MM` | `node index.js --month 2026-05` | Rerun a specific month |

---

## Airbnb: how the delta works

Airbnb doesn't show dated reviews — it shows a total count.  
- **Baseline run**: stores `rawTotal = 312`  
- **Next month's run**: gets new total `= 318` → delta `= 6 new reviews`  
- First run always shows `(baseline)` in the dashboard — delta appears from month 2 onward.

---

## Adding / updating properties

**Option A — Interactive search (finds Booking/Expedia/Google URLs automatically):**
```bash
cd scraper && npm run search
```

**Option B — Edit directly:**  
Edit `properties.json`. All 16 Airbnb profile URLs are pre-filled. Add the other platform URLs manually or via Option A.

---

## File structure
```
/
├── .github/workflows/scrape.yml   ← Runs 7th of month, 9 AM PST
├── scraper/
│   ├── index.js                   ← Orchestrator (baseline/monthly/dry-run modes)
│   ├── browser.js                 ← Stealth Playwright setup
│   ├── search-property.js         ← Interactive URL finder
│   ├── package.json
│   └── scrapers/
│       ├── booking.js             ← Paginates, date-matches
│       ├── expedia.js             ← Sorts newest, expands, date-matches
│       ├── airbnb.js              ← Host profile: sums listing review totals
│       └── google.js              ← Sorts newest, scrolls, relative-date math
├── data/
│   ├── reviews.json               ← Auto-updated each run
│   └── alerts.json                ← Errors/warnings from last 10 runs
├── dashboard/
│   └── index.html                 ← GitHub Pages dashboard
└── properties.json                ← All 16 hotels (edit to add URLs)
```
