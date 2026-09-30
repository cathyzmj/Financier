# Financier — Development Log

A running record of what changed, why, the bugs hit, and how they were resolved.
**Newest version on top.**

### How versions work (semver: `MAJOR.MINOR.PATCH`)
- **MAJOR** (e.g. 2 → 3): a big rewrite or a change that breaks existing data/behaviour.
- **MINOR** (e.g. 2.2 → 2.3): a new feature, backward-compatible. ← most entries.
- **PATCH** (e.g. 2.3.0 → 2.3.1): a bug fix only, no new feature.

To cut a new version: pick the number per the rules above, update `APP_VERSION` in
`web/src/App.jsx` (it shows next to the logo), and add a section here.

---

## v2.11.0 — 2026-09-30 — Price chart + the correctness fixes (rebuilt v2.9 work)
The v2.9.0/v2.9.1 work was built on a machine that became unavailable before it was ever
pushed. This rebuilds it on top of v2.10.0. (Numbered 2.11 rather than 2.9 because it
lands after 2.10 — version numbers don't go backwards.)
### Added
- **Per-investment price chart** on the memo page: the Yahoo close line with your
  **▲ buy (green)** and **▼ sell (red)** markers plotted at the price you transacted.
  Periods 1M / 3M / 6M / 1Y / ALL (ALL = since your first trade). Backend:
  `GET /api/holdings/:id/chart?period=…`. Markers snap to the nearest trading day, and
  only draw inside the charted window — otherwise an old trade snapped onto the chart's
  edge and drew at a price nowhere near the line there.
### Fixed — money
- **The Overview value chart was summing currencies at 1:1.** A EUR-quoted holding was
  added straight to USD ones. `/api/overview/timeseries` now takes `?base=` and converts
  each holding at its FX rate; the chart follows the Net-worth base buttons, and its axis
  and tooltip use that currency's symbol instead of a hardcoded `$`. Verified the same
  window returns materially different totals for `base=GBP` vs `base=USD`.
- **Broker-import opening price was wrong whenever the window contained a sell.** The old
  `P*A − buyCost` is only valid without sells, because moving-average accounting removes
  shares at the *running* average, which itself depends on the opening price. Replaced
  with an exact solver: the replayed final average is linear in the opening price, so
  evaluating at X=0 and X=1 inverts it precisely for any order of fills. Unit-tested
  against four interleavings — the old formula was **$11–16/share** out; the new one is
  exact to 1e-13.
- **Monthly-saver accrual unified** into one helper used by `/api/cash`, `/api/summary`
  and the allocation donut. An account edited into a saver counted *both* its stored
  balance and its accrual; the header's Cash figure also ignored accruals entirely, so it
  disagreed with the Banking tab. Verified: a saver with a stale £9,999 balance now
  reports only its £3,000 accrual, in both places.
- Investing table and transactions drawer formatted every price as `$` regardless of the
  holding's currency.
- A failed price lookup reported `currency: 'USD'`, which made `/api/summary` convert GBP
  cost bases at 1:1. Now null, so callers fall back to the holding's own currency.
- Flex imports could double-count a position when the query is set to lot-level detail
  (a row per lot *plus* a summary row) — non-summary rows are now skipped.
- Flex trade dates only parsed `20250420;…`, silently dropping fills in the
  `2025-04-20;…` format; a row with an unparseable date now can't become a dateless
  transaction.
- Trading212 imports didn't normalise GBX (pence) to GBP, so LSE cost bases came in 100×.
- `/api/cash/maturing?days=abc` produced `NaN`, which nullified the SQL date modifier.
- Local-calendar dates throughout (`localDayIso` / `localIso`): "today", the default
  expense month and export filenames used the UTC day, which is still yesterday until
  8am in China. Yahoo's own timestamp conversion is deliberately left in UTC — it maps a
  market trading day, not a user calendar day.
### Fixed — UI
- **The memo fields lost focus after every keystroke.** `Field` was defined inside
  `MemoPage`, so its component type was a new function each render and React remounted
  the input on every change. Hoisted to module level. Verified: 66 characters typed in
  one go, all landed, field still focused.
### Changed
- Broker routes were defined *inside* `startServer()`; moved to module level so an
  imported `app` always carries the full API.

## v2.10.0 — 2026-09-30 — Password login, single-origin serving, phone access
The app can now be reached from your other devices. Everything here exists to make that
safe, because until now the *only* thing protecting the data was that it refused
connections from anywhere but the machine it ran on.
### Added — access control
- **Password login.** `FINANCIER_PASSWORD` in `server/.env` gates every `/api` route.
  The session is an HMAC-signed, **httpOnly** cookie (30 days), so page scripts can't
  read it; the signing secret is stored in a new `app_meta` table, so restarting the
  server doesn't log your phone out. `SameSite=Lax`, and `Secure` added automatically
  when actually served over HTTPS. Brute force is rate-limited (8 tries → 60s lockout),
  and the password comparison is constant-time.
- **A safety interlock:** the server **refuses to start** on a non-loopback address
  unless a password is set, and says why. It is not possible to expose this app without
  a login by accident.
- Login screen and a **Lock** button in the header; a 401 anywhere (e.g. an expired
  session) drops straight back to the login screen.
### Changed
- **The backend now serves the built frontend**, so it's one process on one port at one
  URL instead of two terminals and two ports. This is what lets a single Tailscale
  address work from any device.
- **`API` is now the relative `/api`** instead of a hardcoded `http://127.0.0.1:8000`.
  That hardcoded host was why the UI could only ever work on the machine running it.
  Vite proxies `/api` in dev so the dev experience is unchanged.
- **CORS locked down** — was `origin: () => cb(null, true)`, i.e. *any* website you had
  open could read `/api/export` (your whole database) or POST `/api/import` (replace it)
  in the background. Now an allowlist: loopback, `*.ts.net`, `100.x` tailnet addresses.
- `npm start` loads `.env`; `npm run share` binds `0.0.0.0` for tailnet access.
- Mobile layout: tables scroll rather than squash, header/nav/forms stack at ≤640px.
### Notes
- Verified end-to-end: unauthenticated `/api/holdings`, `/api/export` and `/api/import`
  all return 401; forged and expired cookies rejected; hostile origin gets no CORS
  header; login → reload → still in; Lock → logged out; checked at phone width.
- The remaining v2.9.x work (price chart, timeseries FX conversion, import opening-price
  solver, saver-accrual dedupe) is **still not in this repo** — it was built on a machine
  that is no longer available and needs rebuilding.

## v2.8.1 — 2026-06-26 — Fix: average cost wrong after a sell
### Fixed
- Average cost was computed as `total buy cost ÷ total buy shares` over ALL buys, so a
  fully-sold cheap batch kept dragging the average down (MRVL showed $198.76 vs IBKR's
  $262.17). Switched to **moving-average cost basis**: a sell removes shares at the
  running average, leaving the average of the remaining shares unchanged — matching the
  broker. Verified against real trades (MRVL/NVDA/SNDK now match IBKR to the cent;
  residual = commissions in IBKR's basis).
- One `positionFromTxns()` helper now drives the holdings table, the transactions
  drawer, the journal (incl. correct realized/unrealized P&L), and the Overview
  reconstruction. Cost is computed at request time, so it self-corrects on restart —
  no data change needed.

## v2.8.0 — 2026-06-25 — AI decision review
### Added
- **Decision review** in the Journal: "Review decisions (AI)" and "Style profile (AI)"
  → Claude (`claude-opus-4-8`) returns a human-readable analysis focused on
  stated-vs-revealed strategy, thesis-vs-outcome, conviction calibration and
  behavioural patterns — deliberately NOT a returns recap (the broker does that).
- The differentiator: Financier captures the **reasoning** (thesis, intended strategy,
  conviction, exit reason, post-mortem, thesis history) and computes deterministic
  aggregates in code, so the AI interprets and never invents numbers.
- **Machine-optimal export:** "Copy data (JSON)" + "Download JSON" — the exact
  structured payload (rows + reasoning + aggregates) the AI sees, to feed any AI
  yourself. (Machine-optimal in → human-readable out.)
- API key: "Set AI key" stores your Anthropic key locally (localStorage, sent per
  request); `ANTHROPIC_API_KEY` env also works. No key → graceful prompt.
- Backend: `buildJournalRows` / `buildAnalysisPayload` / `callClaude` (raw HTTP via the
  same proxy — `api.anthropic.com` is GFW-blocked too); `GET /api/journal/payload`,
  `POST /api/journal/review`.
### Privacy
- Running the AI review sends the journal payload to Anthropic — opt-in, only on click.
  Everything else stays local. (For distribution: users bring their own key.)
### Next
- Charts (#4): per-investment price timeline with buy/sell markers → v2.9.

## v2.7.1 — 2026-06-25 — Strategy picker, journal fixes
### Changed / Fixed
- Strategy field is now a **visual sticker picker** (icon + one-line description per
  strategy) with a highlighted selection — so each strategy is self-explanatory. Still
  extensible: "Custom" reveals a text input, and your custom strategies come back as chips.
- **Journal cards are clickable** → open that position's memo (was inert before).
- Journal export now downloads as **`.txt`** (opens without the macOS "unverified /
  malware" Gatekeeper warning a `.md` triggered) + a **"Copy for AI"** button (copies
  the journal to clipboard — paste straight into an AI, no file at all).
- Removed the dead "AI analyse" placeholder from the Memo page.
### Note
- `strategy` = the style you *intend*; the upcoming AI decision review will identify the
  style your behaviour actually reflects (stated vs revealed).
### Open (#4, staged → v2.8)
- Per-investment price timeline with buy/sell markers, and/or a calendar P&L heatmap.

## v2.7.0 — 2026-06-25 — Strategy tag (editable / extensible)
### Added
- A `strategy` field on each position — your investing style (seeded with
  Macro-dip ETF / Industry growth / Technical / Sentiment / Income / Other, but
  **free-text**: type any new one and it's remembered as a suggestion next time).
- Shows in Add-position and Memo screens (datalist input), in the Journal, and in
  the Markdown export. Backend: `memos.strategy` column + `GET /api/strategies`
  (distinct used values for suggestions). No code edits ever needed to add a strategy.
### Next
- Decision review (AI): per-strategy stats + thesis-vs-outcome critique via Claude.

## v2.6.0 — 2026-06-25 — Investment journal (decision log)
### Added
- **Sell-with-reason:** when a sell closes a position, the transactions drawer asks
  *why* (Take-profit / Stop-loss / Thesis broken / Better opp / Other) + a post-mortem
  note, saved to the memo's exit fields.
- **Journal tab:** every position, open and closed, with thesis, entry/exit, rationale,
  realized/unrealized P&L, and expandable thesis history.
- **Export Markdown:** one-click `.md` of the whole journal, formatted to hand to an AI
  for investment analysis.
- Backend `GET /api/journal` (entry/exit, realized P&L on average-cost basis, history).
### Fixed
- Overview value/performance chart looked "stuck on 1M" — it was actually showing all
  available history (positions were dated only from June). Added a note when the data
  is shorter than the selected period ("only N days available… rebuild from broker
  trades to extend"), and `window_start` to the timeseries response.
### Note
- To get real multi-month charts, rebuild IBKR positions from trade history (their buy
  dates go back to Feb/Apr); positions currently show single June import buys.

## v2.5.0 — 2026-06-24 — Trading212 import
### Added
- **Import from Trading212** (live or practice), using a read-only API key. Same flow
  as IBKR: preview positions, pick which, edit the Yahoo ticker, write a thesis.
  Imports at Trading212's average cost (per-trade history can come later).
### Changed
- Refactored the import engine into a shared `importSelections(...)` used by both
  IBKR and Trading212; `buildPositionTxns` now dates a single-lot position at its real
  fill date. `parseFlexTrades`/Open-Positions reconciliation unchanged.
- Backend: `/api/t212/preview` + `/api/t212/sync`; positions normalised via the
  `/equity/portfolio` + cached `/metadata/instruments` endpoints; routed through the
  proxy (works behind the GFW). API errors mapped to friendly messages.
### Notes
- API key is read-only, stored locally (`financier.t212.*`). Ticker mapping is a
  currency-based guess + editable/remembered (Trading212 ticker format is quirky).
- Tech debt: T212Modal duplicates the IBKR modal's preview table — consolidate later.

### Open / next
- **Decision log:** record a reason when selling/closing a position, a journal view of
  all positions + theses + exits + rationale, and export to a file (for AI analysis).
  Schema already has `exit_reason`/`exit_price`/`exit_date`/`post_mortem`/`thesis_history`.

## v2.4.0 — 2026-06-24 — IBKR per-trade transaction history
### Added
- Import now reconstructs **each buy/sell from your IBKR Trades** instead of one
  average-cost lump (e.g. AXTI shows 70 @ 76, 20 @ 72.71, 10 @ 91.48).
- Positions bought **before** the query window get one synthetic "opening" entry at
  the back-solved price so the total + average cost still reconcile to IBKR.
- Already-held positions can be **re-synced**: tick a held row to rebuild its
  transaction history from trades (keeps the memo).
### Changed
- `parseFlexTrades` (equities only — FX rows ignored) + `buildPositionTxns`
  reconciliation. `/api/ibkr/sync` builds per-trade transactions and supports rebuild.
### Notes
- Needs the Trades section in the Flex query with **Trade Price**, and a period long
  enough to cover recent buys (Last 365 Calendar Days). Older lots → opening entry.

## v2.3.0 — 2026-06-24 — Multi-account, ticker suggestions, version label
### Added
- **Multiple IBKR accounts:** the import modal saves each account's Flex token +
  Query ID (labelled by IBKR account id) and offers them in an **Account** dropdown.
- **Ticker suffix suggestions:** typing a Yahoo ticker in the import screen suggests
  exchange suffixes (`2DG.` → `2DG.MU`, `2DG.F`, …).
- **Version shown in the header** (`v2.3.0`), driven by `APP_VERSION`.

## v2.2.0 — 2026-06-24 — IBKR import rework
### Added
- Import screen: checkbox to pick which positions to import; a **required** one-line
  thesis per position (no auto-placeholder); an editable, price-verified Yahoo ticker.
- Foreign symbols auto-mapped to Yahoo tickers from the IBKR listing exchange
  (`GETTEX`/`MUN` → `.MU`, `LSE` → `.L`, US → none); corrections remembered per symbol.
### Changed
- `parseFlexPositions` reads `listingExchange`/`exchange` → `yahoo_symbol`.
- `/api/ibkr/sync` takes `selections:[{symbol,ticker,thesis}]`, requires a thesis.
### Open
- Per-buy trade history: Trades section is enabled but the query **period** is
  `LastBusinessDay`, so it's empty. Widen the period (Last 365 days / YTD), then a
  `<Trade>` parser turns each fill into a transaction.

## v2.1.0 — 2026-06-23 — IBKR connectivity from China + UX fixes
### Fixed
- **IBKR import timed out.** Root cause: from mainland China the GFW DNS-poisons
  `interactivebrokers.com` (returns a Facebook IP) and blocks the real IPs. Resolution:
  route IBKR + Yahoo + FX through the local system proxy (SakuraCat `127.0.0.1:7897`,
  auto-detected); fall back to a direct IPv4 connection when no proxy.
- **Overview value graph empty in China** — same cause; Yahoo history now goes through
  the proxy (live prices were silently falling back to stale cache).
- **Delete didn't update until refresh** — now removes the row instantly.
### Added
- Import modal remembers the Flex token + Query ID.

## v2.0.0 — ~2026-06-15 — Baseline (handoff)
Core app: Overview (net worth, allocation, value/performance series), Investing
(stocks/ETFs with live prices + memos + transactions; bonds), Banking (accounts +
budget), JSON backup, CSV export, auto-migration, IBKR Flex backend. Stack:
Node/Express/better-sqlite3 (127.0.0.1:8000) + React/Vite (5173).
