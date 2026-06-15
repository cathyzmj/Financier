# Financier

A local-first, private personal-finance tracker. Runs entirely on your own
machine — your data never leaves your computer.

It tracks:

- **Investing** — stocks, ETFs/funds (live prices via Yahoo Finance), and
  individually-held bonds (gilts, treasuries, corporates) with yield calculations.
  Each position carries an investment memo (thesis, sector, catalysts, conviction,
  review and exit notes).
- **Banking** — current/savings accounts, fixed-rate bonds, ISAs, and regular
  (monthly) savers with auto-accruing balances.
- **Cash** — a monthly budget with categorised expenses and a live-FX overview.
- **Overview** — net worth across everything, converted to a base currency you
  choose, plus an allocation pie and a reconstructed portfolio value/performance chart.
- **Backup** — one-click JSON export/import.

---

## ⚠️ Before anything else: your data and secrets

This repo contains **code only**. Two things must **never** be committed, and the
included `.gitignore` already excludes them:

1. **`tracker.db`** — your actual financial data (holdings, balances, sort codes,
   card numbers). It lives in `~/asset-tracker/tracker.db` on your machine.
2. **`.env`** — API keys (for the planned AI features). Use `.env.example` as a template.

If you ever fork or share this repo, double-check neither has been added.

---

## Project structure

```
financier/
├── server/          # Backend — Express + SQLite (better-sqlite3)
│   ├── server.js
│   ├── schema.sql
│   ├── package.json
│   └── .env.example
└── web/             # Frontend — React + Vite
    ├── src/
    │   ├── App.jsx
    │   ├── App.css
    │   └── main.jsx
    ├── index.html
    ├── vite.config.js
    └── package.json
```

---

## Running it locally

Requires **Node.js 18+**.

### 1. Backend

```bash
cd server
npm install
npm start
```

The API runs at `http://127.0.0.1:8000`. On first run it creates the database at
`~/asset-tracker/tracker.db` and applies the schema. The schema auto-migrates on
startup, so pulling a newer version never requires deleting the database.

> Note: the backend binds `127.0.0.1` deliberately (not `localhost`), which on some
> machines resolves to IPv6 and refuses connections.

### 2. Frontend

In a second terminal:

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:5173`.

---

## Backups

Use the **Export** button in the app header to download a JSON snapshot of all your
data, and **Import** to restore it (import overwrites all current data). Exported
backup files contain real financial data and are gitignored — keep them somewhere
private.

It's good practice to export a backup before pulling code changes.

---

## Tech notes

- Prices come from Yahoo Finance's unofficial JSON endpoint, cached for 15 minutes.
  London-listed tickers (e.g. `EQQQ.L`) quoted in GBp (pence) are normalised to GBP.
- FX rates (for the budget and net-worth conversions) come from frankfurter.app,
  cached for an hour. These are mid-market approximations, not your actual dealt rates.
- All position maths (average cost, P&L, yields) is computed from transactions /
  terms at request time, never stored — so it stays correct as you add fills.

---

## Status

Personal project, under active development. Not affiliated with any financial
institution; figures are for personal tracking only and are not financial advice.
