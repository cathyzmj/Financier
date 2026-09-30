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

## Running it

Requires **Node.js 20.6+** (uses `--env-file`).

### First time

```bash
cd server && npm install
cd ../web && npm install && npm run build
```

Then copy `server/.env.example` to `server/.env` and set a password:

```
FINANCIER_PASSWORD=some-long-passphrase
```

### Every time

```bash
cd server && npm start
```

Open **http://127.0.0.1:8000**. That single command serves both the API and the UI —
one process, one port, one URL.

On first run it creates the database at `~/asset-tracker/tracker.db` and applies the
schema. The schema auto-migrates on startup, so pulling a newer version never requires
deleting the database.

> The backend binds `127.0.0.1` deliberately (not `localhost`), which on some machines
> resolves to IPv6 and refuses connections.

### Developing the frontend

For hot-reload while editing the UI, run the backend as above and, in a second terminal:

```bash
cd web && npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the backend, so the login session
works exactly as it does in production.

---

## Access it from your phone (Tailscale)

Financier stays on your own machine — Tailscale just builds a private network between
your devices so you can reach it from your phone or laptop, anywhere, without exposing
anything to the public internet. Free for personal use.

1. Install Tailscale on **this Mac** and on **your phone**, and sign in to the same
   account on both (https://tailscale.com/download).
2. Find this Mac's name on your tailnet: `tailscale status` — it looks like
   `your-macbook.tailXXXX.ts.net`.
3. Start Financier listening beyond loopback:

   ```bash
   cd server && npm run share
   ```

4. On your phone, open `http://your-macbook.tailXXXX.ts.net:8000` and log in.

**`npm run share` refuses to start without `FINANCIER_PASSWORD` set.** That is
deliberate — the app holds your holdings, transactions and account references, and it
must never be reachable from another device without a login in front of it.

Your Mac has to be awake and running the server for the phone to reach it.

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
