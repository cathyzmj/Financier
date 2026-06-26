// Financier v2 — backend
// Node + Express (ES modules), better-sqlite3 (synchronous), runs on 127.0.0.1:8000.
// Computed fields (avg_cost, total_shares, market_value, P&L) derived from transactions, never stored.

import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import dns from 'dns';
import { execSync } from 'child_process';

// This Mac's IPv6 stack is broken (same reason the server binds 127.0.0.1, not
// localhost). Some upstreams — notably IBKR's Flex hosts — publish Teredo (2001::)
// AAAA records that simply hang on connect. Prefer IPv4 for all outbound DNS.
dns.setDefaultResultOrder('ipv4first');
// IPv4-only https agent — used for the IBKR Flex requests when connecting directly
// (no proxy). See getFlexProxy() for the mainland-China proxy path.
const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

// From mainland China the GFW blocks IBKR's Flex hosts outright and makes Yahoo /
// frankfurter flaky. When a local/system HTTP proxy is available — e.g. SakuraCat /
// Clash on 127.0.0.1:7897 — route ALL outbound data calls through it; otherwise
// connect directly over IPv4. Explicit IBKR_FLEX_PROXY / HTTPS_PROXY wins; otherwise
// auto-detect the macOS system proxy so things "just work" whenever the proxy app is on.
function detectMacProxy() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 });
    const on = /HTTPSEnable\s*:\s*1/.test(out);
    const host = out.match(/HTTPSProxy\s*:\s*([0-9.]+)/)?.[1];
    const port = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    if (on && host && port) return { host, port: Number(port) };
  } catch { /* scutil unavailable — fall through to a direct connection */ }
  return null;
}
// Cache proxy detection briefly — getPrice/getFxRate call this a lot.
let _proxyCache = { at: 0, val: null, has: false };
function getProxy() {
  const env = process.env.IBKR_FLEX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  if (env) {
    try {
      const u = new URL(env.includes('://') ? env : `http://${env}`);
      return { host: u.hostname, port: Number(u.port) || 7897 };
    } catch { /* malformed proxy string — ignore */ }
  }
  if (_proxyCache.has && Date.now() - _proxyCache.at < 30000) return _proxyCache.val;
  const val = detectMacProxy();
  _proxyCache = { at: Date.now(), val, has: true };
  return val;
}
// axios options for any outbound data call: via the proxy if present, else direct/IPv4.
function netOpts() {
  const p = getProxy();
  return p ? { proxy: { host: p.host, port: p.port, protocol: 'http' } } : { httpsAgent: ipv4Agent };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB path: Electron sets FINANCIER_DB_PATH to the app's userData dir. Standalone
// dev falls back to ~/asset-tracker/tracker.db (unchanged behaviour).
const DB_PATH = process.env.FINANCIER_DB_PATH
  || path.join(os.homedir(), 'asset-tracker', 'tracker.db');
// Schema lives next to this file; allow override for packaged apps.
const SCHEMA_PATH = process.env.FINANCIER_SCHEMA_PATH
  || path.join(__dirname, 'schema.sql');
const PORT = 8000;
const HOST = '127.0.0.1';
const PRICE_TTL_MS = 15 * 60 * 1000; // 15-min cache

// Ensure the DB directory exists (userData dir may not have it yet).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ---- DB init ----
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
if (fs.existsSync(SCHEMA_PATH)) db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// ---- Lightweight auto-migration ----
// CREATE TABLE IF NOT EXISTS handles new tables, but not new columns on tables that
// already exist. This adds any missing columns so swapping in a newer server.js never
// requires deleting tracker.db. Add new columns here when the schema gains them.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`migrated: added ${table}.${column}`);
  }
}
function migrate() {
  // memos — ETF fields
  ensureColumn('memos', 'tracks', 'TEXT');
  ensureColumn('memos', 'expense_ratio', 'REAL');
  ensureColumn('memos', 'strategy', 'TEXT'); // free-text investing style, user-extensible
  // cash_accounts — MECE banking fields
  ensureColumn('cash_accounts', 'bank', 'TEXT');
  ensureColumn('cash_accounts', 'product', 'TEXT');
  ensureColumn('cash_accounts', 'category', "TEXT NOT NULL DEFAULT 'current'");
  ensureColumn('cash_accounts', 'access_type', 'TEXT');
  ensureColumn('cash_accounts', 'is_isa', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('cash_accounts', 'is_monthly_saver', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('cash_accounts', 'monthly_amount', 'REAL');
  ensureColumn('cash_accounts', 'account_ref', 'TEXT');
  ensureColumn('cash_accounts', 'term', 'TEXT');
  ensureColumn('cash_accounts', 'start_date', 'TEXT');
}
try { migrate(); } catch (e) { console.error('migration warning:', e.message); }

// Tables exported/imported by the backup feature.
const BACKUP_TABLES = [
  'holdings', 'transactions', 'memos', 'thesis_history',
  'cash_accounts', 'bonds', 'budget_settings', 'expenses',
];

// ---- App ----
const app = express();
app.use(express.json());
// The server only ever binds 127.0.0.1, so it's not network-exposed. Allow the
// Vite dev origins and Electron's file:// origin (which sends Origin: null / none).
app.use(cors({
  origin: (origin, cb) => cb(null, true),
}));

// ---- Helpers: position math ----
// Moving-average cost basis (the broker-standard method). A sell removes shares at the
// CURRENT average, so it never distorts the average cost of the shares that remain —
// matching IBKR. (The old "total buy cost / total buy shares" was wrong after any sell.)
function positionFromTxns(txns) {
  const sorted = [...txns].sort((a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
  let shares = 0, cost = 0, realized = 0;
  for (const t of sorted) {
    if (t.type === 'buy') {
      cost += t.price * t.shares;
      shares += t.shares;
    } else { // sell at the running average; profit is locked in as realized
      const avg = shares > 0 ? cost / shares : 0;
      realized += (t.price - avg) * t.shares;
      shares -= t.shares;
      cost = shares > 0.0000001 ? avg * shares : 0; // avg unchanged by the sell
    }
  }
  const avgCost = shares > 0.0000001 ? cost / shares : 0;
  return { totalShares: shares, avgCost, costBasis: shares > 0 ? cost : 0, realizedPnl: realized };
}

function computePosition(holdingId) {
  return positionFromTxns(db.prepare('SELECT * FROM transactions WHERE holding_id = ?').all(holdingId));
}

// Re-evaluate is_open after a sell brings shares to 0
function reconcileOpenState(holdingId) {
  const { totalShares } = computePosition(holdingId);
  const isOpen = totalShares > 0.0000001 ? 1 : 0;
  db.prepare('UPDATE holdings SET is_open = ? WHERE id = ?').run(isOpen, holdingId);
  return isOpen;
}

// ---- Helpers: prices (Yahoo Finance unofficial JSON, 15-min SQLite cache) ----
async function getPrice(ticker) {
  const t = ticker.toUpperCase();
  const cached = db.prepare('SELECT * FROM price_cache WHERE ticker = ?').get(t);
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at + 'Z').getTime();
    if (age < PRICE_TTL_MS) {
      return { ticker: t, price: cached.price, currency: cached.currency, change_pct: cached.change_pct, cached: true };
    }
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}`;
    const { data } = await axios.get(url, {
      params: { interval: '1d', range: '1d' },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000, ...netOpts(),
    });
    const r = data?.chart?.result?.[0];
    const meta = r?.meta;
    if (!meta || meta.regularMarketPrice == null) throw new Error('no price in response');
    let price = meta.regularMarketPrice;
    let prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
    let currency = meta.currency || 'USD';
    // Yahoo quotes most LSE listings in GBp (pence). Normalize to GBP (£).
    if (currency === 'GBp' || currency === 'GBX') {
      price = price / 100;
      prevClose = prevClose / 100;
      currency = 'GBP';
    }
    const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    db.prepare(`INSERT INTO price_cache (ticker, price, currency, change_pct, fetched_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(ticker) DO UPDATE SET
                  price=excluded.price, currency=excluded.currency,
                  change_pct=excluded.change_pct, fetched_at=excluded.fetched_at`)
      .run(t, price, currency, changePct);
    return { ticker: t, price, currency, change_pct: changePct, cached: false };
  } catch (err) {
    if (cached) return { ticker: t, price: cached.price, currency: cached.currency, change_pct: cached.change_pct, cached: true, stale: true };
    return { ticker: t, price: null, currency: 'USD', change_pct: null, error: err.message };
  }
}

// Build the enriched holding object the frontend table consumes
async function enrichHolding(h) {
  const { totalShares, avgCost, costBasis } = computePosition(h.id);
  const memo = db.prepare('SELECT sector, thesis, target_price, stop_loss FROM memos WHERE holding_id = ?').get(h.id) || {};
  const p = await getPrice(h.ticker);
  const currentPrice = p.price;
  const dayChangePct = p.change_pct ?? null;
  const marketValue = currentPrice != null ? totalShares * currentPrice : null;
  const pnl = marketValue != null ? marketValue - costBasis : null;
  const pnlPct = (pnl != null && costBasis > 0) ? (pnl / costBasis) * 100 : null;
  return {
    id: h.id,
    ticker: h.ticker,
    name: h.name,
    asset_type: h.asset_type,
    currency: h.currency,
    quote_currency: p.currency || h.currency || 'USD', // true currency of price & market_value
    is_open: h.is_open,
    sector: memo.sector ?? null,
    thesis: memo.thesis ?? null,
    target_price: memo.target_price ?? null,
    stop_loss: memo.stop_loss ?? null,
    total_shares: totalShares,
    avg_cost: avgCost,
    cost_basis: costBasis,
    current_price: currentPrice,
    day_change_pct: dayChangePct,
    market_value: marketValue,
    pnl,
    pnl_pct: pnlPct,
    price_stale: p.stale || false,
  };
}

// =====================================================================
// Holdings + Transactions
// =====================================================================

// GET /api/holdings — all open holdings, enriched
app.get('/api/holdings', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM holdings WHERE is_open = 1 ORDER BY ticker').all();
    const enriched = await Promise.all(rows.map(enrichHolding));
    res.json(enriched);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/holdings — create holding + first transaction + memo in one request
app.post('/api/holdings', (req, res) => {
  const {
    ticker, name, asset_type = 'stock', currency = 'USD',
    date, price, shares, notes,
    // optional memo fields (all nullable)
    thesis, sector, catalysts, target_price, stop_loss, time_horizon,
    conviction, position_size_pct, macro_context, sector_view,
    risk_factors, variant_perception, tracks, expense_ratio, strategy,
  } = req.body;

  if (!ticker || !date || price == null || shares == null) {
    return res.status(400).json({ error: 'ticker, date, price, shares are required' });
  }
  if (!thesis || !thesis.trim()) {
    return res.status(400).json({ error: 'A one-line thesis is required.' });
  }

  const tx = db.transaction(() => {
    const h = db.prepare(`INSERT INTO holdings (ticker, name, asset_type, currency)
                          VALUES (?, ?, ?, ?)`)
      .run(ticker.toUpperCase(), name ?? null, asset_type, currency);
    const holdingId = h.lastInsertRowid;

    db.prepare(`INSERT INTO transactions (holding_id, type, date, price, shares, notes)
                VALUES (?, 'buy', ?, ?, ?, ?)`)
      .run(holdingId, date, price, shares, notes ?? null);

    db.prepare(`INSERT INTO memos
      (holding_id, thesis, sector, catalysts, target_price, stop_loss, time_horizon,
       conviction, position_size_pct, macro_context, sector_view, risk_factors, variant_perception,
       tracks, expense_ratio, strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(holdingId, thesis ?? null, sector ?? null, catalysts ?? null,
        target_price ?? null, stop_loss ?? null, time_horizon ?? null,
        conviction ?? null, position_size_pct ?? null, macro_context ?? null,
        sector_view ?? null, risk_factors ?? null, variant_perception ?? null,
        tracks ?? null, expense_ratio ?? null, strategy ?? null);

    db.prepare(`INSERT INTO thesis_history (holding_id, thesis) VALUES (?, ?)`)
      .run(holdingId, thesis.trim());

    return holdingId;
  });

  try {
    const id = tx();
    res.status(201).json({ id, ticker: ticker.toUpperCase() });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: `Holding ${ticker.toUpperCase()} already exists. Add a transaction instead.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/holdings/:id — cascades to transactions + memo
app.delete('/api/holdings/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM holdings WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'holding not found' });
    res.json({ deleted: Number(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/holdings/:id/transactions — newest first + computed summary
app.get('/api/holdings/:id/transactions', (req, res) => {
  try {
    const id = req.params.id;
    const txns = db.prepare('SELECT * FROM transactions WHERE holding_id = ? ORDER BY date DESC, id DESC').all(id);
    const withSubtotal = txns.map(t => ({ ...t, subtotal: t.price * t.shares }));
    const { totalShares, avgCost } = computePosition(id);
    res.json({ transactions: withSubtotal, total_shares: totalShares, avg_cost: avgCost });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/holdings/:id/transactions — add buy or sell
app.post('/api/holdings/:id/transactions', (req, res) => {
  try {
    const id = req.params.id;
    const { type, date, price, shares, notes } = req.body;
    if (!['buy', 'sell'].includes(type)) return res.status(400).json({ error: "type must be 'buy' or 'sell'" });
    if (!date || price == null || shares == null) return res.status(400).json({ error: 'date, price, shares required' });

    const h = db.prepare('SELECT id FROM holdings WHERE id = ?').get(id);
    if (!h) return res.status(404).json({ error: 'holding not found' });

    db.prepare(`INSERT INTO transactions (holding_id, type, date, price, shares, notes)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, type, date, price, shares, notes ?? null);

    const isOpen = reconcileOpenState(id);
    const { totalShares, avgCost } = computePosition(id);
    res.status(201).json({ holding_id: Number(id), total_shares: totalShares, avg_cost: avgCost, is_open: isOpen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/transactions/:id — recomputes position afterward
app.delete('/api/transactions/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT holding_id FROM transactions WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'transaction not found' });
    db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
    const isOpen = reconcileOpenState(row.holding_id);
    const { totalShares, avgCost } = computePosition(row.holding_id);
    res.json({ deleted: Number(req.params.id), holding_id: row.holding_id, total_shares: totalShares, avg_cost: avgCost, is_open: isOpen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/holdings/:id/memo — full memo
app.get('/api/holdings/:id/memo', (req, res) => {
  try {
    const memo = db.prepare('SELECT * FROM memos WHERE holding_id = ?').get(req.params.id);
    if (!memo) return res.status(404).json({ error: 'memo not found' });
    res.json(memo);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/holdings/:id/memo — partial update of any memo fields
const MEMO_FIELDS = new Set([
  'thesis', 'sector', 'catalysts', 'target_price', 'stop_loss', 'time_horizon',
  'conviction', 'position_size_pct', 'macro_context', 'sector_view', 'risk_factors',
  'variant_perception', 'tracks', 'expense_ratio', 'thesis_intact', 'catalyst_status',
  'exit_date', 'exit_price', 'exit_reason', 'post_mortem', 'strategy',
]);
app.patch('/api/holdings/:id/memo', (req, res) => {
  try {
    const id = req.params.id;
    const memo = db.prepare('SELECT * FROM memos WHERE holding_id = ?').get(id);
    if (!memo) return res.status(404).json({ error: 'memo not found' });

    // Thesis is required — reject an update that would blank it out.
    if ('thesis' in req.body && (!req.body.thesis || !req.body.thesis.trim())) {
      return res.status(400).json({ error: 'A one-line thesis is required.' });
    }

    const updates = Object.entries(req.body).filter(([k]) => MEMO_FIELDS.has(k));
    if (updates.length === 0) return res.status(400).json({ error: 'no valid memo fields supplied' });

    const setClause = updates.map(([k]) => `${k} = ?`).join(', ');
    const values = updates.map(([, v]) => v);
    db.prepare(`UPDATE memos SET ${setClause}, updated_at = datetime('now') WHERE holding_id = ?`)
      .run(...values, id);

    // If the thesis text actually changed, append it to history.
    if ('thesis' in req.body && req.body.thesis.trim() !== (memo.thesis || '').trim()) {
      db.prepare(`INSERT INTO thesis_history (holding_id, thesis) VALUES (?, ?)`)
        .run(id, req.body.thesis.trim());
    }

    res.json(db.prepare('SELECT * FROM memos WHERE holding_id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/holdings/:id/thesis-history — thesis edits, newest first
app.get('/api/holdings/:id/thesis-history', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, thesis, logged_at FROM thesis_history WHERE holding_id = ? ORDER BY logged_at DESC, id DESC'
    ).all(req.params.id);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/strategies — distinct strategies you've already used, for suggestions
app.get('/api/strategies', (req, res) => {
  try {
    const rows = db.prepare("SELECT DISTINCT strategy FROM memos WHERE strategy IS NOT NULL AND TRIM(strategy) != '' ORDER BY strategy").all();
    res.json(rows.map((r) => r.strategy));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Journal / decision-review ----
// The diary: every position (open + closed) with its REASONING (thesis, intended
// strategy, conviction, exit reason, post-mortem, thesis history) alongside the
// operations — the part a broker never captures.
async function buildJournalRows() {
  const holdings = db.prepare('SELECT * FROM holdings ORDER BY is_open DESC, ticker').all();
  const out = [];
  for (const h of holdings) {
    const memo = db.prepare('SELECT * FROM memos WHERE holding_id = ?').get(h.id) || {};
    const txns = db.prepare('SELECT * FROM transactions WHERE holding_id = ? ORDER BY date ASC, id ASC').all(h.id);
    const { totalShares, avgCost, costBasis, realizedPnl } = positionFromTxns(txns);
    const firstBuy = txns.find((t) => t.type === 'buy');
    const lastSell = [...txns].reverse().find((t) => t.type === 'sell');
    let currentPrice = null, unrealizedPnl = null;
    if (h.is_open && totalShares > 0.0000001) {
      const p = await getPrice(h.ticker);
      currentPrice = p.price;
      if (currentPrice != null) unrealizedPnl = round2(totalShares * currentPrice - costBasis);
    }
    const hist = db.prepare('SELECT thesis, logged_at FROM thesis_history WHERE holding_id = ? ORDER BY logged_at ASC, id ASC').all(h.id);
    out.push({
      id: h.id, ticker: h.ticker, name: h.name, asset_type: h.asset_type, currency: h.currency,
      is_open: h.is_open,
      thesis: memo.thesis ?? null, sector: memo.sector ?? null, strategy: memo.strategy ?? null, conviction: memo.conviction ?? null,
      time_horizon: memo.time_horizon ?? null, catalysts: memo.catalysts ?? null,
      risk_factors: memo.risk_factors ?? null, variant_perception: memo.variant_perception ?? null,
      target_price: memo.target_price ?? null, stop_loss: memo.stop_loss ?? null,
      thesis_intact: memo.thesis_intact ?? null,
      exit_reason: memo.exit_reason ?? null, exit_price: memo.exit_price ?? null,
      exit_date: memo.exit_date ?? null, post_mortem: memo.post_mortem ?? null,
      entry_date: firstBuy ? firstBuy.date : null,
      avg_cost: round2(avgCost),
      total_shares: totalShares,
      current_price: currentPrice,
      realized_pnl: round2(realizedPnl),
      unrealized_pnl: unrealizedPnl,
      last_sell_date: lastSell ? lastSell.date : null,
      transactions: txns.map((t) => ({ type: t.type, date: t.date, shares: t.shares, price: t.price })),
      thesis_history: hist,
    });
  }
  return out;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

// Roll the rows into deterministic aggregates so the AI never has to (and can't)
// invent numbers — it interprets, we compute. This is the machine-optimal payload.
function buildAnalysisPayload(rows) {
  const today = new Date().toISOString().slice(0, 10);
  const open = rows.filter((r) => r.is_open);
  const closed = rows.filter((r) => !r.is_open);

  const byStrategy = {};
  for (const r of rows) {
    const k = r.strategy || '(untagged)';
    const s = byStrategy[k] || (byStrategy[k] = { count: 0, open: 0, closed: 0, realized: 0, holdDays: [], wins: 0, losses: 0 });
    s.count++; if (r.is_open) s.open++; else s.closed++;
    if (!r.is_open) {
      s.realized += r.realized_pnl || 0;
      if ((r.realized_pnl || 0) > 0) s.wins++; else if ((r.realized_pnl || 0) < 0) s.losses++;
      const d = daysBetween(r.entry_date, r.exit_date || r.last_sell_date);
      if (d != null) s.holdDays.push(d);
    }
  }
  const by_strategy = Object.entries(byStrategy).map(([strategy, s]) => ({
    strategy, positions: s.count, open: s.open, closed: s.closed, realized_pnl: round2(s.realized),
    avg_hold_days: s.holdDays.length ? Math.round(s.holdDays.reduce((a, b) => a + b, 0) / s.holdDays.length) : null,
    win_rate_closed_pct: (s.wins + s.losses) ? round2((s.wins / (s.wins + s.losses)) * 100) : null,
  }));

  const byExit = {};
  for (const r of closed) {
    const k = r.exit_reason || '(no reason logged)';
    const e = byExit[k] || (byExit[k] = { count: 0, realized: 0 });
    e.count++; e.realized += r.realized_pnl || 0;
  }
  const by_exit_reason = Object.entries(byExit).map(([reason, e]) => ({ reason, count: e.count, realized_pnl: round2(e.realized) }));

  const byConv = {};
  for (const r of rows) {
    if (r.conviction == null) continue;
    const c = byConv[r.conviction] || (byConv[r.conviction] = { positions: 0, closed: 0, realized: 0 });
    c.positions++; if (!r.is_open) { c.closed++; c.realized += r.realized_pnl || 0; }
  }
  const by_conviction = Object.entries(byConv)
    .map(([conviction, c]) => ({ conviction: Number(conviction), positions: c.positions, closed: c.closed, realized_pnl: round2(c.realized) }))
    .sort((a, b) => a.conviction - b.conviction);

  const openHold = open.map((r) => daysBetween(r.entry_date, today)).filter((d) => d != null);
  return {
    generated_at: new Date().toISOString(),
    note: 'Reasoning is first-class (thesis, intended strategy, conviction, exit_reason, post_mortem, thesis_history). P&L is average-cost and approximate — secondary to decision quality.',
    counts: { total: rows.length, open: open.length, closed: closed.length },
    totals: {
      realized_pnl: round2(closed.reduce((a, r) => a + (r.realized_pnl || 0), 0)),
      unrealized_pnl: round2(open.reduce((a, r) => a + (r.unrealized_pnl || 0), 0)),
    },
    avg_open_hold_days: openHold.length ? Math.round(openHold.reduce((a, b) => a + b, 0) / openHold.length) : null,
    by_strategy, by_exit_reason, by_conviction,
    positions: rows,
  };
}

const REVIEW_SYSTEM = `You are a sharp, candid investing research partner reviewing a private investor's decision journal. This is NOT a performance report — their broker already shows returns. Examine the RELATIONSHIP between their stated reasons and their actual decisions and outcomes.

Focus on:
- Stated vs revealed strategy: each position has an intended "strategy". From holding period, entry/exit timing and exit reason, infer the strategy their behaviour ACTUALLY reflects, and flag mismatches by name.
- Thesis vs outcome: did the thesis play out? Did the exit reason fit the thesis and stated horizon? Note thesis drift in thesis_history that reads like after-the-fact rationalisation.
- Cross-position patterns: selling winners early, holding losers, impatience vs stated horizon, conviction calibration (do higher-conviction positions actually do better?), exit-reason discipline.
- End with 2-3 pointed questions that would sharpen their process.

Rules: Use ONLY numbers in the payload — never invent figures. No buy/sell/hold recommendations, no price predictions. Be direct; challenge the thinking, don't flatter. If the sample is small (few closed trades), say so and frame points as hypotheses. Write for a human: clear prose, short "## " sections, no raw-number tables, no preamble about your process.`;

const STYLE_SYSTEM = `You are a sharp investing research partner profiling a private investor's STYLE from their decision journal. Describe what kind of investor they actually are, grounded only in the data: holding-period behaviour, the mix of strategies and how each performs, conviction calibration, single-stock vs fund tilt, sector/strategy concentration, risk/return posture. Explicitly contrast the strategies they INTEND with what their behaviour REVEALS.

Rules: Use ONLY numbers in the payload — never invent figures. No buy/sell/hold recommendations, no price predictions. Be candid, not flattering. If the sample is small, say so and frame as hypotheses. Write for a human: clear prose, short "## " sections, no raw-number tables, no preamble.`;

// Claude via raw HTTP through the SAME proxy as every other outbound call —
// api.anthropic.com is blocked from mainland China, so it must use netOpts() too.
async function callClaude(system, userText, key) {
  const { data } = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: userText }],
  }, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    timeout: 120000, ...netOpts(),
  });
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text || 'No analysis returned.';
}

// GET /api/journal — diary rows for the Journal tab.
app.get('/api/journal', async (req, res) => {
  try { res.json(await buildJournalRows()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/journal/payload — machine-optimal export (rows + aggregates), the exact
// structured form fed to the AI; download or copy to feed any AI yourself.
app.get('/api/journal/payload', async (req, res) => {
  try { res.json(buildAnalysisPayload(await buildJournalRows())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/journal/review { mode:'review'|'style', api_key? } — human-readable AI
// analysis. Key from body (UI) or ANTHROPIC_API_KEY env.
app.post('/api/journal/review', async (req, res) => {
  try {
    const key = (req.body && req.body.api_key) || process.env.ANTHROPIC_API_KEY;
    if (!key) return res.json({ error: 'no_key' });
    const mode = req.body && req.body.mode === 'style' ? 'style' : 'review';
    const payload = buildAnalysisPayload(await buildJournalRows());
    if (payload.counts.total === 0) return res.json({ review: 'Nothing to analyse yet — add a position with a thesis first.', mode, model: 'claude-opus-4-8' });
    const userText = `Here is the investor's decision journal as JSON. Analyse it.\n\n${JSON.stringify(payload)}`;
    const review = await callClaude(mode === 'style' ? STYLE_SYSTEM : REVIEW_SYSTEM, userText, key);
    res.json({ review, mode, model: 'claude-opus-4-8' });
  } catch (err) {
    const s = err.response?.status;
    if (s === 401) return res.status(502).json({ error: 'Anthropic rejected the API key — check it.' });
    if (s === 429) return res.status(502).json({ error: 'Anthropic rate limit — wait a moment and retry.' });
    res.status(502).json({ error: err.message });
  }
});

// =====================================================================
// Cash, Prices, Summary
// =====================================================================

// GET /api/cash — grouped by country
app.get('/api/cash', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM cash_accounts ORDER BY country, account_name').all();
    const grouped = {};
    for (const r of rows) {
      // Monthly saver: balance accrues monthly_amount each month from start_date.
      // We compute a derived "accrued_balance" (number of payments made × monthly_amount,
      // capped at the term length if a fixed term is set), but keep the stored balance too.
      if (r.is_monthly_saver && r.monthly_amount && r.start_date) {
        const start = new Date(r.start_date + 'T00:00:00');
        const now = new Date();
        let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
        // count the start month itself as payment 1 if the day has passed
        months = months + 1;
        if (months < 0) months = 0;
        // cap at term (e.g. 12 for a 1-year saver) if known
        const termMonths = { '1yr': 12, '2yr': 24, '3yr': 36, '5yr': 60 }[r.term];
        if (termMonths) months = Math.min(months, termMonths);
        r.payments_made = months;
        r.accrued_balance = Math.round(months * r.monthly_amount * 100) / 100;
      }
      (grouped[r.country] ??= []).push(r);
    }
    res.json(grouped);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/cash
app.post('/api/cash', (req, res) => {
  try {
    const { account_name, bank, product, country, currency, category = 'current',
            access_type, is_isa = 0, is_monthly_saver = 0, monthly_amount, account_ref,
            term, balance = 0, your_rate, start_date, maturity_date, notes } = req.body;
    if (!account_name || !country || !currency || !category) {
      return res.status(400).json({ error: 'account_name, country, currency, category required' });
    }
    const info = db.prepare(`INSERT INTO cash_accounts
      (account_name, bank, product, country, currency, category, access_type, is_isa, is_monthly_saver, monthly_amount, account_ref, term, balance, your_rate, start_date, maturity_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(account_name, bank ?? null, product ?? null, country, currency, category,
           access_type ?? null, is_isa ? 1 : 0, is_monthly_saver ? 1 : 0, monthly_amount ?? null, account_ref ?? null,
           term ?? null, balance, your_rate ?? null, start_date ?? null, maturity_date ?? null, notes ?? null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/cash/:id
const CASH_FIELDS = new Set([
  'account_name', 'bank', 'product', 'country', 'currency', 'category', 'access_type',
  'is_isa', 'is_monthly_saver', 'monthly_amount', 'account_ref', 'term', 'balance', 'your_rate',
  'start_date', 'maturity_date', 'notes',
]);
app.patch('/api/cash/:id', (req, res) => {
  try {
    const exists = db.prepare('SELECT id FROM cash_accounts WHERE id = ?').get(req.params.id);
    if (!exists) return res.status(404).json({ error: 'account not found' });
    const updates = Object.entries(req.body).filter(([k]) => CASH_FIELDS.has(k));
    if (updates.length === 0) return res.status(400).json({ error: 'no valid fields supplied' });
    const setClause = updates.map(([k]) => `${k} = ?`).join(', ');
    const values = updates.map(([, v]) => v);
    db.prepare(`UPDATE cash_accounts SET ${setClause}, last_updated = datetime('now') WHERE id = ?`)
      .run(...values, req.params.id);
    res.json(db.prepare('SELECT * FROM cash_accounts WHERE id = ?').get(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/cash/:id
app.delete('/api/cash/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM cash_accounts WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'account not found' });
    res.json({ deleted: Number(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/cash/refresh-rates — fetch BOE base rate, store in reference_rates
app.post('/api/cash/refresh-rates', async (req, res) => {
  try {
    // BOE official Bank Rate via the IADB CSV series IUDBEDR (latest observation).
    const url = 'https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp'
      + '?csv.x=yes&Datefrom=01/Jan/2024&Dateto=now&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N';
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000, ...netOpts() });
    const lines = String(data).trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1].split(',');
    const rateValue = parseFloat(last[last.length - 1]);
    if (Number.isNaN(rateValue)) throw new Error('could not parse BOE rate');
    db.prepare(`INSERT INTO reference_rates (country, rate_name, rate_value, source, fetched_at)
                VALUES ('UK', 'BOE Base Rate', ?, 'Bank of England IADB IUDBEDR', datetime('now'))`)
      .run(rateValue);
    res.json({ country: 'UK', rate_name: 'BOE Base Rate', rate_value: rateValue });
  } catch (err) {
    res.status(502).json({ error: `rate fetch failed: ${err.message}` });
  }
});

// GET /api/cash/maturing?days=7
app.get('/api/cash/maturing', (req, res) => {
  try {
    const days = parseInt(req.query.days ?? '7', 10);
    const rows = db.prepare(`
      SELECT * FROM cash_accounts
      WHERE maturity_date IS NOT NULL
        AND date(maturity_date) >= date('now')
        AND date(maturity_date) <= date('now', ?)
      ORDER BY maturity_date ASC`).all(`+${days} days`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/search/:query — ticker/company autocomplete (Yahoo symbol search)
app.get('/api/search/:query', async (req, res) => {
  try {
    const q = req.params.query.trim();
    if (!q) return res.json([]);
    const { data } = await axios.get('https://query1.finance.yahoo.com/v1/finance/search', {
      params: { q, quotesCount: 8, newsCount: 0 },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 6000, ...netOpts(),
    });
    const results = (data?.quotes || [])
      .filter((x) => x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF'))
      .map((x) => ({
        symbol: x.symbol,
        name: x.shortname || x.longname || '',
        type: x.quoteType === 'ETF' ? 'etf' : 'stock',
        exchange: x.exchDisp || '',
      }));
    res.json(results);
  } catch (err) {
    res.json([]); // search failures are non-fatal — user can still type freely
  }
});

// GET /api/price/:ticker — single price (15-min cache)
app.get('/api/price/:ticker', async (req, res) => {
  try {
    const p = await getPrice(req.params.ticker);
    if (p.price == null) return res.status(502).json(p);
    res.json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/summary — totals for header (everything converted to USD)
app.get('/api/summary', async (req, res) => {
  try {
    const holdings = db.prepare('SELECT * FROM holdings WHERE is_open = 1').all();
    const enriched = await Promise.all(holdings.map(enrichHolding));

    let equity = 0, costBasisTotal = 0, pnl = 0;
    for (const h of enriched) {
      // Convert each holding from its quote currency into USD before summing.
      const fx = await getFxRate(h.quote_currency || 'USD', 'USD');
      const rate = fx.rate != null ? fx.rate : 1;
      if (h.market_value != null) equity += h.market_value * rate;
      costBasisTotal += h.cost_basis * rate;
      if (h.pnl != null) pnl += h.pnl * rate;
    }
    // Cash totals stay in native currency, grouped — no FX conversion (private/local, manual).
    const cashRows = db.prepare('SELECT currency, SUM(balance) AS total FROM cash_accounts GROUP BY currency').all();
    const cashByCurrency = {};
    for (const c of cashRows) cashByCurrency[c.currency] = c.total;

    const pnlPct = costBasisTotal > 0 ? (pnl / costBasisTotal) * 100 : null;

    res.json({
      equity,
      cost_basis: costBasisTotal,
      cash_by_currency: cashByCurrency,
      pnl,
      pnl_pct: pnlPct,
      position_count: enriched.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Historical daily closes from Yahoo (for portfolio reconstruction) ----
// Returns a map { 'YYYY-MM-DD': close } for the ticker over [period1, now].
async function getHistory(ticker, period1Unix) {
  const t = ticker.toUpperCase();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}`;
    const { data } = await axios.get(url, {
      params: { interval: '1d', period1: period1Unix, period2: Math.floor(Date.now() / 1000) },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000, ...netOpts(),
    });
    const r = data?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const closes = r?.indicators?.quote?.[0]?.close || [];
    // Match the GBp→GBP normalization used for live prices.
    const isPence = (r?.meta?.currency === 'GBp' || r?.meta?.currency === 'GBX');
    const div = isPence ? 100 : 1;
    const map = {};
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      const day = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      map[day] = closes[i] / div;
    }
    return map;
  } catch {
    return {};
  }
}

// How far back each period reaches, as days. WTD/MTD/YTD computed from calendar.
function periodStart(period) {
  const now = new Date();
  const d = new Date(now);
  switch (period) {
    case '1D': d.setDate(d.getDate() - 1); break;
    case 'WTD': { const dow = (now.getDay() + 6) % 7; d.setDate(d.getDate() - dow); break; } // Monday
    case 'MTD': d.setDate(1); break;
    case '1M': d.setMonth(d.getMonth() - 1); break;
    case '3M': d.setMonth(d.getMonth() - 3); break;
    case 'YTD': d.setMonth(0); d.setDate(1); break;
    default: d.setMonth(d.getMonth() - 1);
  }
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/overview/allocation?base=GBP — value breakdown + net worth, converted to base currency
app.get('/api/overview/allocation', async (req, res) => {
  try {
    const base = (req.query.base || 'GBP').toUpperCase();
    const holdings = db.prepare('SELECT * FROM holdings WHERE is_open = 1').all();
    const enriched = await Promise.all(holdings.map(enrichHolding));

    const convert = async (amount, from) => {
      if (amount == null) return null;
      const fx = await getFxRate(from || base, base);
      return fx.rate != null ? amount * fx.rate : null;
    };

    // Per-holding equity slices, each converted from its quote currency to base.
    const equitySlices = [];
    let equityTotal = 0;
    let fxOk = true;
    for (const h of enriched) {
      if (h.market_value == null || h.market_value <= 0) continue;
      const v = await convert(h.market_value, h.quote_currency);
      if (v == null) { fxOk = false; continue; }
      equitySlices.push({ label: h.ticker, value: Math.round(v * 100) / 100, group: 'Investing', currency: base });
      equityTotal += v;
    }

    // Bank accounts grouped by currency, converted to base.
    const acctRows = db.prepare('SELECT currency, SUM(balance) AS total FROM cash_accounts GROUP BY currency').all();
    // Monthly savers store balance=0; add their accrued amounts.
    const savers = db.prepare("SELECT currency, monthly_amount, term, start_date FROM cash_accounts WHERE is_monthly_saver = 1 AND monthly_amount IS NOT NULL AND start_date IS NOT NULL").all();
    const acctByCur = {};
    for (const r of acctRows) acctByCur[r.currency] = (acctByCur[r.currency] || 0) + r.total;
    for (const s of savers) {
      const start = new Date(s.start_date + 'T00:00:00'); const now = new Date();
      let m = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1;
      if (m < 0) m = 0;
      const termMonths = { '1yr': 12, '2yr': 24, '3yr': 36, '5yr': 60 }[s.term];
      if (termMonths) m = Math.min(m, termMonths);
      acctByCur[s.currency] = (acctByCur[s.currency] || 0) + m * s.monthly_amount;
    }
    const bankSlices = [];
    let bankTotal = 0;
    for (const [cur, total] of Object.entries(acctByCur)) {
      if (!total || total <= 0) continue;
      const v = await convert(total, cur);
      if (v == null) { fxOk = false; continue; }
      bankSlices.push({ label: `Bank ${cur}`, value: Math.round(v * 100) / 100, group: 'Bank', currency: base });
      bankTotal += v;
    }

    res.json({
      base,
      equity_slices: equitySlices,
      bank_slices: bankSlices,
      equity_total: Math.round(equityTotal * 100) / 100,
      bank_total: Math.round(bankTotal * 100) / 100,
      net_worth: Math.round((equityTotal + bankTotal) * 100) / 100,
      fx_ok: fxOk,
      note: `All values converted to ${base} at live mid-market rates (approximate).`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/overview/timeseries?period=3M — reconstructed equity value & P&L per day
app.get('/api/overview/timeseries', async (req, res) => {
  try {
    const period = req.query.period || '1M';
    const start = periodStart(period);
    const period1 = Math.floor(start.getTime() / 1000);

    const windowStart = start.toISOString().slice(0, 10);
    const holdings = db.prepare('SELECT * FROM holdings').all();
    if (holdings.length === 0) return res.json({ period, window_start: windowStart, points: [] });

    // Fetch historical closes + all transactions for every holding.
    const histByHolding = {};
    const txByHolding = {};
    await Promise.all(holdings.map(async (h) => {
      histByHolding[h.id] = await getHistory(h.ticker, period1);
      txByHolding[h.id] = db.prepare('SELECT * FROM transactions WHERE holding_id = ? ORDER BY date ASC').all(h.id);
    }));

    // Walk each calendar day in the window. For each holding, compute shares held
    // and cost basis as of that day, value it at that day's close (carry forward last
    // known close for weekends/holidays), and sum.
    const lastClose = {};
    const points = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let day = new Date(start); day <= today; day.setDate(day.getDate() + 1)) {
      const iso = day.toISOString().slice(0, 10);
      let value = 0, costBasis = 0, priced = false;

      for (const h of holdings) {
        const txns = txByHolding[h.id].filter((t) => t.date <= iso);
        if (txns.length === 0) continue;
        const { totalShares: shares, costBasis: cb } = positionFromTxns(txns);
        if (shares <= 0.0000001) continue;

        const close = histByHolding[h.id][iso];
        if (close != null) lastClose[h.id] = close;
        const px = close ?? lastClose[h.id];
        if (px == null) continue;

        value += shares * px;
        costBasis += cb;
        priced = true;
      }

      if (!priced) continue; // skip days before any holding was priced
      points.push({
        date: iso,
        value: Math.round(value * 100) / 100,
        cost_basis: Math.round(costBasis * 100) / 100,
        pnl: Math.round((value - costBasis) * 100) / 100,
        pnl_pct: costBasis > 0 ? Math.round(((value - costBasis) / costBasis) * 10000) / 100 : null,
      });
    }

    res.json({ period, window_start: windowStart, points });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- FX rates (frankfurter.app — free, no key; 1-hour cache, manual override fallback) ----
const FX_TTL_MS = 60 * 60 * 1000;
async function getFxRate(from, to) {
  const f = from.toUpperCase(), t = to.toUpperCase();
  if (f === t) return { pair: `${f}_${t}`, rate: 1, cached: true };
  const pair = `${f}_${t}`;
  const cached = db.prepare('SELECT * FROM fx_cache WHERE pair = ?').get(pair);
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at + 'Z').getTime();
    if (age < FX_TTL_MS) return { pair, rate: cached.rate, cached: true };
  }
  try {
    const { data } = await axios.get('https://api.frankfurter.app/latest', {
      params: { from: f, to: t }, timeout: 8000, ...netOpts(),
    });
    const rate = data?.rates?.[t];
    if (rate == null) throw new Error('no rate');
    db.prepare(`INSERT INTO fx_cache (pair, rate, fetched_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(pair) DO UPDATE SET rate=excluded.rate, fetched_at=excluded.fetched_at`)
      .run(pair, rate);
    return { pair, rate, cached: false };
  } catch (err) {
    if (cached) return { pair, rate: cached.rate, cached: true, stale: true };
    return { pair, rate: null, error: err.message };
  }
}

// GET /api/fx?from=CNY&to=GBP — single rate (for the frontend to convert/override)
app.get('/api/fx', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const r = await getFxRate(from, to);
    if (r.rate == null) return res.status(502).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/budget/settings — the singleton budget config
app.get('/api/budget/settings', (req, res) => {
  try {
    let row = db.prepare('SELECT * FROM budget_settings WHERE id = 1').get();
    if (!row) {
      db.prepare('INSERT INTO budget_settings (id, monthly_budget, base_currency) VALUES (1, 0, ?)').run('GBP');
      row = db.prepare('SELECT * FROM budget_settings WHERE id = 1').get();
    }
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/budget/settings — update budget amount and/or base currency
app.patch('/api/budget/settings', (req, res) => {
  try {
    const { monthly_budget, base_currency } = req.body;
    db.prepare('INSERT OR IGNORE INTO budget_settings (id) VALUES (1)').run();
    const sets = [], vals = [];
    if (monthly_budget != null) { sets.push('monthly_budget = ?'); vals.push(monthly_budget); }
    if (base_currency) { sets.push('base_currency = ?'); vals.push(base_currency); }
    if (sets.length) {
      db.prepare(`UPDATE budget_settings SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = 1`).run(...vals);
    }
    res.json(db.prepare('SELECT * FROM budget_settings WHERE id = 1').get());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/expenses?month=YYYY-MM — expenses for a month + category & spend totals in base currency
app.get('/api/expenses', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const settings = db.prepare('SELECT * FROM budget_settings WHERE id = 1').get()
      || { monthly_budget: 0, base_currency: 'GBP' };
    const base = settings.base_currency;

    const rows = db.prepare(
      "SELECT * FROM expenses WHERE substr(date,1,7) = ? ORDER BY date DESC, id DESC"
    ).all(month);

    // Convert each expense into base currency for totals (rates cached).
    const currencies = [...new Set(rows.map((r) => r.currency))];
    const rateMap = {};
    for (const c of currencies) {
      const r = await getFxRate(c, base);
      rateMap[c] = r.rate; // may be null if fetch failed and no cache
    }

    let spentBase = 0;
    const byCategory = {};
    const enriched = rows.map((r) => {
      const rate = rateMap[r.currency];
      const baseAmount = rate != null ? r.amount * rate : null;
      if (baseAmount != null) {
        spentBase += baseAmount;
        byCategory[r.category] = (byCategory[r.category] || 0) + baseAmount;
      }
      return { ...r, base_amount: baseAmount != null ? Math.round(baseAmount * 100) / 100 : null };
    });

    spentBase = Math.round(spentBase * 100) / 100;
    const categoryTotals = Object.entries(byCategory)
      .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);

    res.json({
      month,
      base_currency: base,
      monthly_budget: settings.monthly_budget,
      spent: spentBase,
      remaining: Math.round((settings.monthly_budget - spentBase) * 100) / 100,
      category_totals: categoryTotals,
      rates: rateMap,
      expenses: enriched,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/expenses — add a spend
app.post('/api/expenses', (req, res) => {
  try {
    const { date, amount, currency, category, wallet, note } = req.body;
    if (!date || amount == null || !currency || !category) {
      return res.status(400).json({ error: 'date, amount, currency, category required' });
    }
    const info = db.prepare(`INSERT INTO expenses (date, amount, currency, category, wallet, note)
                             VALUES (?, ?, ?, ?, ?, ?)`)
      .run(date, amount, currency, category, wallet ?? null, note ?? null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/expenses/:id
app.delete('/api/expenses/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'expense not found' });
    res.json({ deleted: Number(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/export — dump all user data as a JSON backup
app.get('/api/export', (req, res) => {
  try {
    const dump = { version: 2, exported_at: new Date().toISOString(), tables: {} };
    for (const t of BACKUP_TABLES) {
      dump.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="financier-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(dump, null, 2));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/import — overwrite all data from a JSON backup (clears existing first)
app.post('/api/import', (req, res) => {
  try {
    const dump = req.body;
    if (!dump || !dump.tables) {
      return res.status(400).json({ error: 'Invalid backup file — missing "tables".' });
    }
    const tx = db.transaction(() => {
      // Clear in reverse FK order (children before parents).
      const clearOrder = [...BACKUP_TABLES].reverse();
      for (const t of clearOrder) db.prepare(`DELETE FROM ${t}`).run();
      db.prepare("DELETE FROM sqlite_sequence").run();

      // Insert in forward order (parents before children).
      for (const t of BACKUP_TABLES) {
        const rows = dump.tables[t];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        // Only insert columns that exist in this DB (tolerates older/newer backups).
        const dbCols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
        for (const row of rows) {
          const cols = Object.keys(row).filter((c) => dbCols.includes(c));
          if (cols.length === 0) continue;
          const placeholders = cols.map(() => '?').join(', ');
          db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders})`)
            .run(...cols.map((c) => row[c]));
        }
      }
    });
    tx();
    const counts = {};
    for (const t of BACKUP_TABLES) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    res.json({ ok: true, counts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Bonds ----
// Compute the meaningful metrics for an individually-held bond.
function enrichBond(b) {
  const totalFace = b.face_value * b.quantity;
  const totalCost = b.purchase_price * b.quantity;
  const annualIncome = (b.coupon_rate / 100) * b.face_value * b.quantity; // coupon is % of face
  // Current yield = annual coupon income / current market value (or cost if no mark).
  const markPrice = b.current_price != null ? b.current_price : b.purchase_price;
  const marketValue = markPrice * b.quantity;
  const currentYield = markPrice > 0 ? (annualIncome / (markPrice * b.quantity)) * 100 : null;
  // Yield on cost = annual income / what you actually paid.
  const yieldOnCost = totalCost > 0 ? (annualIncome / totalCost) * 100 : null;

  // Time to maturity (years).
  let yearsToMaturity = null;
  if (b.maturity_date) {
    const ms = new Date(b.maturity_date + 'T00:00:00') - new Date();
    yearsToMaturity = Math.round((ms / (365.25 * 24 * 3600 * 1000)) * 100) / 100;
  }

  // Hold-to-maturity total return (simple, not annualised): all remaining coupons +
  // (face − purchase price) capital gain/loss at redemption, as % of cost.
  let htmTotalReturnPct = null, htmTotalProfit = null;
  if (yearsToMaturity != null && yearsToMaturity > 0) {
    const couponsRemaining = annualIncome * yearsToMaturity; // approx (ignores part-periods precisely)
    const redemptionGain = (b.face_value - b.purchase_price) * b.quantity;
    htmTotalProfit = couponsRemaining + redemptionGain;
    htmTotalReturnPct = totalCost > 0 ? (htmTotalProfit / totalCost) * 100 : null;
  }

  // Unrealised P&L vs current mark (only meaningful if a mark was entered).
  const markPnl = b.current_price != null ? (b.current_price - b.purchase_price) * b.quantity : null;

  return {
    ...b,
    total_face: round2(totalFace),
    total_cost: round2(totalCost),
    market_value: round2(marketValue),
    annual_income: round2(annualIncome),
    current_yield: currentYield != null ? round2(currentYield) : null,
    yield_on_cost: yieldOnCost != null ? round2(yieldOnCost) : null,
    years_to_maturity: yearsToMaturity,
    htm_total_return_pct: htmTotalReturnPct != null ? round2(htmTotalReturnPct) : null,
    htm_total_profit: htmTotalProfit != null ? round2(htmTotalProfit) : null,
    mark_pnl: markPnl != null ? round2(markPnl) : null,
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

// GET /api/bonds — all bonds with computed metrics
app.get('/api/bonds', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM bonds ORDER BY maturity_date ASC').all();
    res.json(rows.map(enrichBond));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bonds
app.post('/api/bonds', (req, res) => {
  try {
    const { name, issuer, bond_type, currency = 'GBP', face_value, quantity = 1,
            coupon_rate, frequency = 2, purchase_price, purchase_date, maturity_date,
            current_price, notes } = req.body;
    if (!name || face_value == null || coupon_rate == null || purchase_price == null || !maturity_date) {
      return res.status(400).json({ error: 'name, face_value, coupon_rate, purchase_price, maturity_date required' });
    }
    const info = db.prepare(`INSERT INTO bonds
      (name, issuer, bond_type, currency, face_value, quantity, coupon_rate, frequency, purchase_price, purchase_date, maturity_date, current_price, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, issuer ?? null, bond_type ?? null, currency, face_value, quantity,
           coupon_rate, frequency, purchase_price, purchase_date ?? null, maturity_date,
           current_price ?? null, notes ?? null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const BOND_FIELDS = new Set([
  'name', 'issuer', 'bond_type', 'currency', 'face_value', 'quantity', 'coupon_rate',
  'frequency', 'purchase_price', 'purchase_date', 'maturity_date', 'current_price', 'notes',
]);
app.patch('/api/bonds/:id', (req, res) => {
  try {
    const exists = db.prepare('SELECT id FROM bonds WHERE id = ?').get(req.params.id);
    if (!exists) return res.status(404).json({ error: 'bond not found' });
    const updates = Object.entries(req.body).filter(([k]) => BOND_FIELDS.has(k));
    if (updates.length === 0) return res.status(400).json({ error: 'no valid fields supplied' });
    const setClause = updates.map(([k]) => `${k} = ?`).join(', ');
    const values = updates.map(([, v]) => v);
    db.prepare(`UPDATE bonds SET ${setClause}, updated_at = datetime('now') WHERE id = ?`)
      .run(...values, req.params.id);
    res.json(enrichBond(db.prepare('SELECT * FROM bonds WHERE id = ?').get(req.params.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bonds/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM bonds WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'bond not found' });
    res.json({ deleted: Number(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start the server only when run directly (node server.js), not when imported
// by the Electron main process (which calls startServer itself).
export function startServer() {
// ---- IBKR Flex Web Service ----
// Two-step protocol: (1) SendRequest with token+queryId returns a ReferenceCode;
// (2) GetStatement with token+ReferenceCode returns the report XML.
const FLEX_BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';

function flexAttr(tag, attr) {
  const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
  return m ? m[1] : null;
}

// IBKR reports bare local symbols (e.g. "2DG"); Yahoo needs an exchange suffix
// ("2DG.MU"). Map the IBKR listing-exchange code to a Yahoo suffix; US listings get
// none. Best-effort default — the import UI lets you correct it and remembers the fix,
// so unknown exchanges still end up right.
const US_EXCHANGES = new Set(['NYSE','NASDAQ','NMS','ARCA','AMEX','BATS','IEX','ISLAND','PINK','NYSENAT','PSX']);
const EXCHANGE_SUFFIX = {
  LSE: '.L', LSEETF: '.L',
  IBIS: '.DE', IBIS2: '.DE', XETRA: '.DE', FWB: '.F', FWB2: '.F', SWB: '.SG',
  GETTEX: '.MU', MUN: '.MU', MUNICH: '.MU', TGATE: '.TG', BVME: '.MI', 'BVME.ETF': '.MI', BIT: '.MI',
  AEB: '.AS', SBF: '.PA', 'ENEXT.BE': '.BR', 'ENEXT.PA': '.PA', BVL: '.LS',
  SWX: '.SW', EBS: '.SW', BM: '.MC', SFB: '.ST', OMXNO: '.OL', OSE: '.OL', CPH: '.CO', HEX: '.HE', VSE: '.VI', WSE: '.WA',
  SEHK: '.HK', SEHKNTL: '.HK', TSEJ: '.T', SGX: '.SI', ASX: '.AX', KSE: '.KS', KOSDAQ: '.KQ', TWSE: '.TW', SET: '.BK', NSE: '.NS', BSE: '.BO',
  TSE: '.TO', VENTURE: '.V',
};
const CURRENCY_SUFFIX = { GBP: '.L', HKD: '.HK', JPY: '.T', SGD: '.SI', AUD: '.AX', KRW: '.KS', TWD: '.TW', CHF: '.SW', SEK: '.ST', NOK: '.OL', DKK: '.CO', CAD: '.TO' };
function yahooSymbol(symbol, exchange, currency) {
  const sym = (symbol || '').toUpperCase();
  if (!sym || sym.includes('.')) return sym;        // already suffixed
  const ex = (exchange || '').toUpperCase();
  if (US_EXCHANGES.has(ex) || (!ex && currency === 'USD')) return sym; // US: no suffix
  if (EXCHANGE_SUFFIX[ex]) return sym + EXCHANGE_SUFFIX[ex];
  const cs = CURRENCY_SUFFIX[(currency || '').toUpperCase()];
  return cs ? sym + cs : sym;                        // rough fallback; user can fix
}

// Parse <OpenPosition .../> rows from a Flex statement into normalised holdings.
function parseFlexPositions(xml) {
  const rows = xml.match(/<OpenPosition\b[^>]*\/>/g) || [];
  const positions = [];
  for (const row of rows) {
    const symbol = flexAttr(row, 'symbol');
    const qty = parseFloat(flexAttr(row, 'position'));
    if (!symbol || !qty) continue;
    const costPrice = parseFloat(flexAttr(row, 'costBasisPrice') || flexAttr(row, 'openPrice') || '0');
    const assetCat = (flexAttr(row, 'assetCategory') || '').toUpperCase();
    const currency = flexAttr(row, 'currency') || 'USD';
    const exchange = flexAttr(row, 'listingExchange') || flexAttr(row, 'exchange') || null;
    positions.push({
      symbol,
      name: flexAttr(row, 'description') || null,
      quantity: qty,
      cost_price: costPrice || null,
      currency,
      listing_exchange: exchange,
      yahoo_symbol: yahooSymbol(symbol, exchange, currency),
      asset_type: assetCat === 'ETF' ? 'etf' : 'stock',
      asset_category: assetCat,
    });
  }
  return positions;
}

// Parse <Trade .../> rows (equities only — skip FX/options/etc.) into normalised fills.
function parseFlexTrades(xml) {
  const rows = xml.match(/<Trade\b[^>]*\/>/g) || [];
  const trades = [];
  for (const row of rows) {
    const assetCat = (flexAttr(row, 'assetCategory') || '').toUpperCase();
    if (assetCat !== 'STK' && assetCat !== 'ETF') continue; // ignore GBP.USD etc.
    const symbol = flexAttr(row, 'symbol');
    const qty = Math.abs(parseFloat(flexAttr(row, 'quantity')));
    const price = parseFloat(flexAttr(row, 'tradePrice'));
    const side = (flexAttr(row, 'buySell') || '').toUpperCase();
    const dt = flexAttr(row, 'dateTime') || flexAttr(row, 'tradeDate') || '';
    const date = dt.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'); // YYYY-MM-DD
    if (!symbol || !qty || Number.isNaN(price) || !(side === 'BUY' || side === 'SELL')) continue;
    trades.push({ symbol: symbol.toUpperCase(), date, type: side === 'BUY' ? 'buy' : 'sell', shares: qty, price });
  }
  return trades;
}

// Build a transaction list for one position by combining its in-window trades with the
// Open Positions baseline. Trades give the granular fills; if the position predates the
// window, one synthetic "opening" buy reconciles the remainder to IBKR's average cost.
function buildPositionTxns(openPos, trades, windowStartIso, label = 'IBKR') {
  const fills = trades
    .filter((t) => t.symbol === openPos.symbol.toUpperCase())
    .sort((a, b) => a.date.localeCompare(b.date));
  const P = openPos.quantity;
  const A = openPos.cost_price; // broker average cost
  let buyQ = 0, buyCost = 0, sellQ = 0;
  for (const f of fills) {
    if (f.type === 'buy') { buyQ += f.shares; buyCost += f.shares * f.price; }
    else sellQ += f.shares;
  }
  const txns = [];
  // Shares not accounted for by in-window fills — acquired before the window, or the
  // whole position when there are no fills at all (e.g. Trading212 positions).
  const openingQ = Math.round((P - (buyQ - sellQ)) * 1e6) / 1e6;
  if (openingQ > 0.0001 && A != null) {
    const openingCost = P * A - buyCost;             // remainder of the cost basis
    const openingPrice = openingCost > 0 ? openingCost / openingQ : A;
    txns.push({ type: 'buy', date: openPos.opening_date || windowStartIso,
      price: Math.round(openingPrice * 1e6) / 1e6, shares: openingQ,
      notes: `Opening position (average cost) — ${label}` });
  }
  for (const f of fills) txns.push({ type: f.type, date: f.date, price: f.price, shares: f.shares, notes: `Imported from ${label}` });
  return txns;
}

// Shared import engine for any broker. `positions` are normalised open positions;
// `trades` are individual fills (empty for sources without trade history). Creates a
// new holding (thesis required) per selection, or rebuilds a held one's transactions.
function importSelections(selections, positions, trades, windowStartIso, label) {
  const bySymbol = new Map(positions.map((p) => [p.symbol.toUpperCase(), p]));
  const existing = new Map(db.prepare('SELECT id, ticker FROM holdings').all().map((h) => [h.ticker.toUpperCase(), h.id]));
  const today = new Date().toISOString().slice(0, 10);
  let added = 0, resynced = 0; const skipped = []; const errors = [];
  const insertTxn = db.prepare(`INSERT INTO transactions (holding_id, type, date, price, shares, notes) VALUES (?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const sel of selections) {
      const srcSym = String(sel.symbol || '').toUpperCase();
      const p = bySymbol.get(srcSym);
      if (!p) { errors.push(`${srcSym}: not in latest ${label} data`); continue; }
      const ticker = String(sel.ticker || p.yahoo_symbol || p.symbol).trim().toUpperCase();
      if (!ticker) { errors.push(`${srcSym}: ticker required`); continue; }
      const built = buildPositionTxns(p, trades, windowStartIso, label);
      const txns = built.length ? built
        : [{ type: 'buy', date: p.opening_date || today, price: p.cost_price ?? 0, shares: p.quantity, notes: `Imported from ${label}` }];
      if (existing.has(ticker)) {
        const holdingId = existing.get(ticker);          // already held → rebuild its history, keep memo
        db.prepare('DELETE FROM transactions WHERE holding_id = ?').run(holdingId);
        for (const t of txns) insertTxn.run(holdingId, t.type, t.date, t.price, t.shares, t.notes);
        const { totalShares } = computePosition(holdingId);
        db.prepare('UPDATE holdings SET is_open = ? WHERE id = ?').run(totalShares > 0.0000001 ? 1 : 0, holdingId);
        resynced++;
      } else {
        const thesis = String(sel.thesis || '').trim();
        if (!thesis) { errors.push(`${ticker}: thesis required`); continue; }
        const h = db.prepare(`INSERT INTO holdings (ticker, name, asset_type, currency) VALUES (?, ?, ?, ?)`)
          .run(ticker, p.name, p.asset_type, p.currency);
        const holdingId = h.lastInsertRowid;
        for (const t of txns) insertTxn.run(holdingId, t.type, t.date, t.price, t.shares, t.notes);
        db.prepare(`INSERT INTO memos (holding_id, thesis) VALUES (?, ?)`).run(holdingId, thesis);
        db.prepare(`INSERT INTO thesis_history (holding_id, thesis) VALUES (?, ?)`).run(holdingId, thesis);
        existing.set(ticker, holdingId);
        added++;
      }
    }
  });
  tx();
  return { added, resynced, skipped, errors };
}

async function fetchFlexStatement(token, queryId) {
  // IBKR is blocked from mainland China. Route through a local/system proxy when one
  // is present (SakuraCat/Clash etc.); otherwise connect directly over IPv4.
  const proxy = getProxy();
  const net = netOpts();
  if (proxy) console.log(`IBKR: routing Flex calls via proxy ${proxy.host}:${proxy.port}`);

  // Step 1: request the statement, get a reference code.
  const send = await axios.get(`${FLEX_BASE}/SendRequest`, {
    ...net, params: { t: token, q: queryId, v: 3 }, timeout: 20000,
  });
  const sendXml = String(send.data);
  const refCode = sendXml.match(/<ReferenceCode>(\d+)<\/ReferenceCode>/)?.[1];
  const errMsg = sendXml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/)?.[1];
  if (!refCode) {
    throw new Error(errMsg || 'IBKR did not return a reference code — check token and query ID.');
  }
  // IBKR returns the host to fetch the statement from (gdcdyn), which differs from
  // the SendRequest host (ndcdyn). Use the URL it hands back when present.
  const stmtUrl = sendXml.match(/<Url>([^<]+)<\/Url>/)?.[1] || `${FLEX_BASE}/GetStatement`;

  // Step 2: IBKR generates the report asynchronously. Poll, retrying transient
  // network errors so one slow attempt doesn't abort the whole import.
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 3000));
    let xml;
    try {
      const stmt = await axios.get(stmtUrl, {
        ...net, params: { t: token, q: refCode, v: 3 }, timeout: 20000,
      });
      xml = String(stmt.data);
    } catch (e) {
      if (attempt === 9) throw e; // out of retries — surface the error
      continue;
    }
    if (/<ErrorCode>1019<\/ErrorCode>/.test(xml) || /generation in progress/i.test(xml)) continue;
    const err = xml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/)?.[1];
    if (err && !/<OpenPosition/.test(xml)) throw new Error(`IBKR: ${err}`);
    return xml;
  }
  throw new Error('IBKR statement was not ready after several attempts — try again shortly.');
}

function getFlexCreds(req) {
  const token = (req.body && req.body.token) || process.env.IBKR_FLEX_TOKEN;
  const queryId = (req.body && req.body.query_id) || process.env.IBKR_FLEX_QUERY_ID;
  return { token, queryId };
}

// POST /api/ibkr/preview — fetch & parse positions, mark which are new, DON'T save
app.post('/api/ibkr/preview', async (req, res) => {
  try {
    const { token, queryId } = getFlexCreds(req);
    if (!token || !queryId) return res.status(400).json({ error: 'IBKR Flex token and query ID required.' });
    const xml = await fetchFlexStatement(token, queryId);
    const positions = parseFlexPositions(xml);
    const existing = new Set(db.prepare('SELECT ticker FROM holdings').all().map((h) => h.ticker.toUpperCase()));
    const preview = positions.map((p) => ({ ...p, is_new: !existing.has((p.yahoo_symbol || p.symbol).toUpperCase()) }));
    const accountId = xml.match(/<FlexStatement\b[^>]*\baccountId="([^"]*)"/)?.[1] || null;
    res.json({ account_id: accountId, count: positions.length, new_count: preview.filter((p) => p.is_new).length, positions: preview });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/ibkr/sync — import the positions the user selected, each with its own
// (required) thesis and a confirmed Yahoo ticker. Body: { selections: [{ symbol,
// ticker, thesis }] }. Only inserts tickers not already held; nothing is overwritten.
app.post('/api/ibkr/sync', async (req, res) => {
  try {
    const { token, queryId } = getFlexCreds(req);
    if (!token || !queryId) return res.status(400).json({ error: 'IBKR Flex token and query ID required.' });
    const selections = Array.isArray(req.body?.selections) ? req.body.selections : null;
    if (!selections || selections.length === 0) {
      return res.status(400).json({ error: 'No positions selected to import.' });
    }
    const xml = await fetchFlexStatement(token, queryId);
    const positions = parseFlexPositions(xml);
    const trades = parseFlexTrades(xml);
    const m = xml.match(/<FlexStatement\b[^>]*\bfromDate="(\d{4})(\d{2})(\d{2})"/);
    const windowStartIso = m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
    res.json(importSelections(selections, positions, trades, windowStartIso, 'IBKR'));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Trading212 ----
// REST API: Authorization header carries the raw API key. Live vs practice = host.
function t212Base(env) { return env === 'demo' ? 'https://demo.trading212.com' : 'https://live.trading212.com'; }
function getT212Creds(req) {
  return {
    apiKey: (req.body && req.body.api_key) || process.env.T212_API_KEY,
    env: (req.body && req.body.environment) || 'live',
  };
}
function t212Err(err) {
  const s = err.response?.status;
  if (s === 401 || s === 403) return 'Trading212 rejected the API key — check it has the Portfolio permission and matches the chosen (live/practice) account.';
  if (s === 429) return 'Trading212 rate limit hit — wait a minute and try again.';
  return err.message;
}
// Instruments metadata is large and heavily rate-limited — cache it per process.
let _t212Instruments = { at: 0, base: null, map: null };
async function getT212Instruments(base, apiKey) {
  if (_t212Instruments.map && _t212Instruments.base === base && Date.now() - _t212Instruments.at < 24 * 3600 * 1000) {
    return _t212Instruments.map;
  }
  const { data } = await axios.get(`${base}/api/v0/equity/metadata/instruments`, {
    headers: { Authorization: apiKey }, timeout: 30000, ...netOpts(),
  });
  const map = new Map();
  for (const i of (Array.isArray(data) ? data : [])) map.set(i.ticker, i);
  _t212Instruments = { at: Date.now(), base, map };
  return map;
}
// Fetch open positions and normalise them into the same shape the importer expects.
async function fetchT212Positions(base, apiKey) {
  const { data } = await axios.get(`${base}/api/v0/equity/portfolio`, {
    headers: { Authorization: apiKey }, timeout: 20000, ...netOpts(),
  });
  const rows = Array.isArray(data) ? data : [];
  let instruments = new Map();
  try { instruments = await getT212Instruments(base, apiKey); } catch { /* metadata optional */ }
  return rows.map((r) => {
    const meta = instruments.get(r.ticker) || {};
    const bare = String(meta.shortName || String(r.ticker).split('_')[0] || r.ticker).toUpperCase();
    const currency = meta.currencyCode || 'USD';
    const type = String(meta.type || '').toUpperCase() === 'ETF' ? 'etf' : 'stock';
    return {
      symbol: bare,
      name: meta.name || null,
      quantity: r.quantity,
      cost_price: r.averagePrice != null ? r.averagePrice : null,
      currency,
      listing_exchange: null,
      yahoo_symbol: yahooSymbol(bare, null, currency),
      asset_type: type,
      asset_category: type.toUpperCase(),
      opening_date: r.initialFillDate ? String(r.initialFillDate).slice(0, 10) : null,
      t212_ticker: r.ticker,
    };
  });
}

// POST /api/t212/preview — fetch & normalise positions, mark which are new
app.post('/api/t212/preview', async (req, res) => {
  try {
    const { apiKey, env } = getT212Creds(req);
    if (!apiKey) return res.status(400).json({ error: 'Trading212 API key required.' });
    const positions = await fetchT212Positions(t212Base(env), apiKey);
    const existing = new Set(db.prepare('SELECT ticker FROM holdings').all().map((h) => h.ticker.toUpperCase()));
    const preview = positions.map((p) => ({ ...p, is_new: !existing.has((p.yahoo_symbol || p.symbol).toUpperCase()) }));
    res.json({ count: positions.length, new_count: preview.filter((p) => p.is_new).length, positions: preview });
  } catch (err) {
    res.status(502).json({ error: t212Err(err) });
  }
});

// POST /api/t212/sync — import the selected positions (single buy at average cost;
// Trading212 portfolio carries no per-trade history yet)
app.post('/api/t212/sync', async (req, res) => {
  try {
    const { apiKey, env } = getT212Creds(req);
    if (!apiKey) return res.status(400).json({ error: 'Trading212 API key required.' });
    const selections = Array.isArray(req.body?.selections) ? req.body.selections : null;
    if (!selections || selections.length === 0) return res.status(400).json({ error: 'No positions selected to import.' });
    const positions = await fetchT212Positions(t212Base(env), apiKey);
    const today = new Date().toISOString().slice(0, 10);
    res.json(importSelections(selections, positions, [], today, 'Trading212'));
  } catch (err) {
    res.status(502).json({ error: t212Err(err) });
  }
});

  return app.listen(PORT, HOST, () => {
    console.log(`Financier backend running at http://${HOST}:${PORT}`);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();

export { app, DB_PATH };
