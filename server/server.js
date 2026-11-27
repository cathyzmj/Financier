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
import crypto from 'crypto';
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

// Format a Date as its LOCAL calendar day (YYYY-MM-DD). toISOString() gives the UTC
// day, which is one day behind local until 8am in China (+8) and 1am in UK summer —
// wrong for anything keyed to the user's own calendar (today's date, "this month").
function localDayIso(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB path: Electron sets FINANCIER_DB_PATH to the app's userData dir. Standalone
// dev falls back to ~/asset-tracker/tracker.db (unchanged behaviour).
const DB_PATH = process.env.FINANCIER_DB_PATH
  || path.join(os.homedir(), 'asset-tracker', 'tracker.db');
// Schema lives next to this file; allow override for packaged apps.
const SCHEMA_PATH = process.env.FINANCIER_SCHEMA_PATH
  || path.join(__dirname, 'schema.sql');
const PORT = Number(process.env.FINANCIER_PORT) || 8000;
// Bind address. Defaults to loopback (only this machine). Set FINANCIER_HOST=0.0.0.0
// to reach it from your other devices over Tailscale — that REQUIRES a password (the
// guard below refuses to start otherwise, so the app can never be exposed unprotected).
const HOST = process.env.FINANCIER_HOST || '127.0.0.1';
const PASSWORD = process.env.FINANCIER_PASSWORD || '';
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (!IS_LOOPBACK && !PASSWORD) {
  console.error(`
Refusing to start: FINANCIER_HOST is "${HOST}" (reachable from other machines) but
FINANCIER_PASSWORD is not set. Your holdings, transactions and account references
would be readable and writable by anyone who can reach this port.

Set a password in server/.env:   FINANCIER_PASSWORD=your-long-passphrase
`);
  process.exit(1);
}
const PRICE_TTL_MS = 15 * 60 * 1000; // 15-min cache
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // stay logged in for 30 days

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

// ---- Auth ----
// Small key/value table for server-side state that isn't user data (currently just the
// session-signing secret, kept so a restart doesn't log your phone out).
db.exec(`CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);
function metaGet(key) { return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value ?? null; }
function metaSet(key, value) {
  db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
let SESSION_SECRET = metaGet('session_secret');
if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString('hex'); metaSet('session_secret', SESSION_SECRET); }

// Session token = "<expiry-ms>.<HMAC>", signed with the stored secret. Stateless, so
// there's no session table to expire; changing the password can't invalidate it, but
// deleting the app_meta row does.
function signToken(expiresAt) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(String(expiresAt)).digest('base64url');
  return `${expiresAt}.${mac}`;
}
function verifyToken(token) {
  const [exp, mac] = String(token || '').split('.');
  if (!exp || !mac) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(exp).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}
// Constant-time password check — a plain === leaks the password length/prefix by timing.
function passwordMatches(supplied) {
  const a = Buffer.from(String(supplied ?? ''), 'utf8');
  const b = Buffer.from(PASSWORD, 'utf8');
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const COOKIE_NAME = 'financier_session';
const AUTH_ENABLED = !!PASSWORD;

// Tables exported/imported by the backup feature.
const BACKUP_TABLES = [
  'holdings', 'transactions', 'memos', 'thesis_history',
  'cash_accounts', 'bonds', 'budget_settings', 'expenses',
];

// ---- App ----
const app = express();
app.use(express.json({ limit: '50mb' })); // backup import can be large
// CORS must be strict now that the server can bind beyond loopback: reflecting every
// origin would let any website you visit read the whole portfolio (or POST /api/import)
// by fetching this host in the background. The UI is served from this same origin, so
// it needs no CORS at all; this only keeps the Vite dev server and Electron working.
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.ts\.net|100\.\d+\.\d+\.\d+)(:\d+)?$/;
app.use(cors({
  credentials: true,
  origin: (origin, cb) => cb(null, !origin || origin === 'null' || ALLOWED_ORIGIN.test(origin)),
}));

// ---- Auth gate ----
// Everything under /api requires a valid session cookie, except the auth endpoints
// themselves. Mounted before any route below, so a new endpoint is protected by default.
const OPEN_PATHS = new Set(['/auth/login', '/auth/status']);
app.use('/api', (req, res, next) => {
  if (!AUTH_ENABLED || OPEN_PATHS.has(req.path)) return next();
  if (verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME])) return next();
  res.status(401).json({ error: 'unauthorized' });
});

// GET /api/auth/status — does this deployment need a login, and am I already in?
app.get('/api/auth/status', (req, res) => {
  res.json({
    auth_required: AUTH_ENABLED,
    authenticated: !AUTH_ENABLED || verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]),
  });
});

// POST /api/auth/login { password } — sets an httpOnly session cookie.
// httpOnly means page scripts can't read it; SameSite=Lax blocks cross-site form posts.
// `Secure` only when actually on HTTPS — plain http:// over Tailscale would drop it.
let loginFailures = 0, lockedUntil = 0;
app.post('/api/auth/login', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true, auth_required: false });
  if (Date.now() < lockedUntil) {
    return res.status(429).json({ error: 'Too many attempts — wait a minute and try again.' });
  }
  if (!passwordMatches(req.body?.password)) {
    if (++loginFailures >= 8) { lockedUntil = Date.now() + 60000; loginFailures = 0; }
    return res.status(401).json({ error: 'Wrong password.' });
  }
  loginFailures = 0;
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${signToken(expiresAt)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; '));
  res.json({ ok: true });
});

// POST /api/auth/logout — clear the cookie on this device.
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

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
    // currency null (not 'USD') so callers fall back to the holding's own currency —
    // a hardcoded USD here made /api/summary convert GBP cost bases at 1:1.
    return { ticker: t, price: null, currency: null, change_pct: null, error: err.message };
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

// GET /api/holdings/:id/chart?period=1M|3M|6M|1Y|ALL — daily closes for one holding
// plus its transactions, so the UI can plot your buys and sells on the price line.
app.get('/api/holdings/:id/chart', async (req, res) => {
  try {
    const h = db.prepare('SELECT * FROM holdings WHERE id = ?').get(req.params.id);
    if (!h) return res.status(404).json({ error: 'holding not found' });
    const txns = db.prepare('SELECT type, date, price, shares FROM transactions WHERE holding_id = ? ORDER BY date ASC, id ASC').all(h.id);
    const period = req.query.period || 'ALL';
    const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[period];
    const start = new Date();
    if (months) {
      start.setMonth(start.getMonth() - months);
    } else { // ALL → from the earliest transaction, with a few days of lead-in
      const earliest = txns.length ? txns[0].date : null;
      if (earliest) {
        start.setTime(new Date(earliest + 'T00:00:00').getTime());
        start.setDate(start.getDate() - 5);
      } else {
        start.setMonth(start.getMonth() - 12);
      }
    }
    start.setHours(0, 0, 0, 0);
    const histMap = await getHistory(h.ticker, Math.floor(start.getTime() / 1000));
    const points = Object.entries(histMap)
      .map(([date, close]) => ({ date, close }))
      .sort((a, b) => a.date.localeCompare(b.date));
    res.json({ ticker: h.ticker, currency: h.currency, period, points, transactions: txns });
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
  const today = localDayIso();
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

// Monthly saver: how many payments have been made since start_date (the start month
// counts as payment 1 once its day has passed), capped at the term length if fixed.
// Single source of truth — /api/cash, /api/summary and the allocation donut all use it,
// so the Banking tab and the header can't disagree about what a saver is worth.
function saverMonthsPaid(startDateIso, term) {
  const start = new Date(startDateIso + 'T00:00:00');
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1;
  if (now.getDate() < start.getDate()) months -= 1; // this month's payment hasn't happened yet
  if (months < 0) months = 0;
  const termMonths = { '1yr': 12, '2yr': 24, '3yr': 36, '5yr': 60 }[term];
  return termMonths ? Math.min(months, termMonths) : months;
}
const isAccruingSaver = (r) => r.is_monthly_saver && r.monthly_amount && r.start_date;
// Cash by currency, with savers valued at their accrued amount INSTEAD of their stored
// balance — counting both double-counts an account that was later edited into a saver.
function cashByCurrencyAccrued() {
  const byCur = {};
  for (const r of db.prepare('SELECT * FROM cash_accounts').all()) {
    const v = isAccruingSaver(r) ? saverMonthsPaid(r.start_date, r.term) * r.monthly_amount : r.balance;
    byCur[r.currency] = (byCur[r.currency] || 0) + (v || 0);
  }
  return byCur;
}

// GET /api/cash — grouped by country
app.get('/api/cash', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM cash_accounts ORDER BY country, account_name').all();
    const grouped = {};
    for (const r of rows) {
      // Monthly saver: balance accrues monthly_amount each month from start_date.
      // Derived "accrued_balance" (payments made × monthly_amount); stored balance kept too.
      if (isAccruingSaver(r)) {
        const months = saverMonthsPaid(r.start_date, r.term);
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
    const parsed = parseInt(req.query.days ?? '7', 10);
    const days = Number.isFinite(parsed) ? parsed : 7; // NaN would nullify the SQL modifier
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
    // Cash totals stay in native currency, grouped — no FX conversion (private/local,
    // manual). Savers count at their accrued amount, same as the Banking tab shows.
    const cashByCurrency = cashByCurrencyAccrued();

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
    const acctByCur = cashByCurrencyAccrued();
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

    const base = (req.query.base || 'USD').toUpperCase();
    const windowStart = localDayIso(start);
    const holdings = db.prepare('SELECT * FROM holdings').all();
    if (holdings.length === 0) return res.json({ period, base, window_start: windowStart, points: [] });

    // Fetch historical closes + transactions + an FX rate to base for every holding.
    // Without the rate this loop summed raw numbers across currencies — a EUR-quoted
    // holding was added to USD ones at 1:1, silently inflating the whole chart.
    const histByHolding = {};
    const txByHolding = {};
    const fxByHolding = {};
    await Promise.all(holdings.map(async (h) => {
      histByHolding[h.id] = await getHistory(h.ticker, period1);
      txByHolding[h.id] = db.prepare('SELECT * FROM transactions WHERE holding_id = ? ORDER BY date ASC').all(h.id);
      const fx = await getFxRate(h.currency || base, base);
      fxByHolding[h.id] = fx.rate; // null if the rate couldn't be fetched
    }));

    // Walk each calendar day in the window. For each holding, compute shares held
    // and cost basis as of that day, value it at that day's close (carry forward last
    // known close for weekends/holidays), and sum.
    const lastClose = {};
    const points = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let day = new Date(start); day <= today; day.setDate(day.getDate() + 1)) {
      const iso = localDayIso(day);
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

        const rate = fxByHolding[h.id];
        if (rate == null) continue; // no FX rate — omitting beats mis-summing

        value += shares * px * rate;
        costBasis += cb * rate;
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

    res.json({ period, base, window_start: windowStart, points });
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
    const month = req.query.month || localDayIso().slice(0, 7); // local month, not UTC
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
    res.setHeader('Content-Disposition', `attachment; filename="financier-backup-${localDayIso()}.json"`);
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
    // A Flex query set to lot-level detail emits one row per LOT plus a SUMMARY row
    // per symbol — importing both would double-count the position.
    const lod = (flexAttr(row, 'levelOfDetail') || '').toUpperCase();
    if (lod && lod !== 'SUMMARY') continue;
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
    // Accept both Flex date formats: "20250420;093000" and "2025-04-20;09:30:00".
    const dm = dt.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : '';
    if (!symbol || !qty || !date || Number.isNaN(price) || !(side === 'BUY' || side === 'SELL')) continue;
    trades.push({ symbol: symbol.toUpperCase(), date, type: side === 'BUY' ? 'buy' : 'sell', shares: qty, price });
  }
  return trades;
}

// Build a transaction list for one position by combining its in-window trades with the
// Open Positions baseline. Trades give the granular fills; if the position predates the
// window, one synthetic "opening" buy reconciles the remainder to IBKR's average cost.
// Solve the synthetic opening price so the imported position reproduces the broker's
// average cost exactly.
//
// The naive "P*A − buyCost" is only right when the window has no sells. With a sell,
// moving-average accounting removes shares at the *running* average, which itself
// depends on the opening price — so that formula drifts (measured $11–16/share off in
// the test cases below). But replaying the fills is a LINEAR function of the opening
// price X: buys add constants to cost, sells scale it. So evaluating the replay at
// X=0 and X=1 pins the line and inverts it exactly, for any order of buys and sells.
function solveOpeningPrice(openingQ, fills, targetAvg) {
  const finalAvg = (X) => {
    let shares = openingQ, cost = openingQ * X;
    for (const f of fills) {
      if (f.type === 'buy') { cost += f.price * f.shares; shares += f.shares; }
      else { const avg = shares > 0 ? cost / shares : 0; shares -= f.shares; cost = shares > 0.0000001 ? avg * shares : 0; }
    }
    return shares > 0.0000001 ? cost / shares : null;
  };
  const f0 = finalAvg(0), f1 = finalAvg(1);
  // Degenerate: the opening shares were entirely sold inside the window, so the final
  // average carries no information about X. Caller falls back.
  if (f0 == null || f1 == null || Math.abs(f1 - f0) < 1e-9) return null;
  return (targetAvg - f0) / (f1 - f0);
}
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
    const solved = solveOpeningPrice(openingQ, fills, A);
    const openingPrice = (solved != null && solved > 0) ? solved
      : (P * A - buyCost > 0 ? (P * A - buyCost) / openingQ : A); // degenerate — best effort
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
  const today = localDayIso();
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
    const windowStartIso = m ? `${m[1]}-${m[2]}-${m[3]}` : localDayIso();
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
    let currency = meta.currencyCode || 'USD';
    let costPrice = r.averagePrice != null ? r.averagePrice : null;
    // T212 quotes LSE instruments in GBX (pence). Normalise to GBP so the imported
    // cost basis matches the GBp→GBP-normalised Yahoo prices.
    if (currency === 'GBX' || currency === 'GBp') {
      if (costPrice != null) costPrice = costPrice / 100;
      currency = 'GBP';
    }
    const type = String(meta.type || '').toUpperCase() === 'ETF' ? 'etf' : 'stock';
    return {
      symbol: bare,
      name: meta.name || null,
      quantity: r.quantity,
      cost_price: costPrice,
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
    const today = localDayIso();
    res.json(importSelections(selections, positions, [], today, 'Trading212'));
  } catch (err) {
    res.status(502).json({ error: t212Err(err) });
  }
});

// ============================ MARKET SIGNALS ============================
// Why this exists: the ledger half of Financier only has something to say when you
// trade. These metrics have something to say every day — and not one of them needs a
// keystroke. Every number below is fetched; none is entered.
//
// Sources, all free and all key-less. Each was curl-tested before it went in here:
//   FRED   fredgraph.csv?id=<series>  — the macro backbone. One call returns a series'
//          full daily history, so a cold database backfills years in a single pass.
//   alternative.me/fng — crypto Fear & Greed: risk appetite at its frothiest end.
//   yc-oss.github.io   — YC's public company directory, the only free structured
//          venture dataset worth having (see the venture section below).
// Deliberately NOT used: CNN's Fear & Greed endpoint replies HTTP 418 "You're a bot".
// The composite here is computed from its own components instead, which is the better
// outcome anyway — the methodology is visible and reproducible rather than borrowed.

const FRED_START = '2015-01-01';
const SIGNALS_TTL_MS = 12 * 60 * 60 * 1000;  // macro series move at most daily
const VENTURE_TTL_MS = 24 * 60 * 60 * 1000;  // YC's dump is rebuilt once a day
const PCT_WINDOW_DAYS = 365;                 // lookback the percentile ranks are taken over
const PCT_MIN_OBS = 30;                      // below this a component is left out, not faked.
// 30 is chosen deliberately: a weekly series carries ~52 observations a year and must
// qualify, while a monthly one carries 12 and must not — a percentile of 12 points is
// noise wearing a number. At 60 every weekly feed was silently dropped from the score.

// grp drives which section of the UI a metric lands in; blurb is what the UI shows under
// the number, because a metric you can't interpret is just decoration.
const SIGNAL_CATALOG = [
  // ---- risk -------------------------------------------------------------------
  { key: 'fear_index', label: 'Fear & Greed', grp: 'risk', source: 'derived', unit: 'index', decimals: 0, sort: 0,
    blurb: '0 = extreme fear, 100 = extreme greed. Composite of the seven components below.' },
  { key: 'vix', label: 'VIX', grp: 'risk', source: 'fred', source_id: 'VIXCLS', unit: 'level', decimals: 2, sort: 1,
    blurb: "S&P 500 implied volatility, 30 days out — the market's own price for insurance." },
  { key: 'vix3m', label: 'VIX 3-month', grp: 'risk', source: 'fred', source_id: 'VXVCLS', unit: 'level', decimals: 2, sort: 2,
    blurb: 'Same thing, 3 months out. The anchor the front month is measured against.' },
  { key: 'vix_term', label: 'Vol term structure', grp: 'risk', source: 'derived', unit: 'ratio', decimals: 3, sort: 3,
    blurb: 'VIX ÷ 3-month VIX. Above 1.00 is backwardation: fear that is acute, not chronic.' },
  { key: 'vxn', label: 'Nasdaq vol (VXN)', grp: 'risk', source: 'fred', source_id: 'VXNCLS', unit: 'level', decimals: 2, sort: 4,
    blurb: 'Nasdaq-100 implied vol. Far above VIX means the stress is tech-specific.' },
  // FRED serves ICE BofA's spread series under licence and only hands back a rolling
  // ~3-year window without an API key. That is not a bug to chase: the composite ranks
  // each component over a trailing year, so three years is more than it ever needs.
  { key: 'hy_oas', label: 'High-yield spread', grp: 'risk', source: 'fred', source_id: 'BAMLH0A0HYM2', unit: 'pct', decimals: 2, sort: 5,
    blurb: 'Extra yield demanded to lend to junk issuers. Credit panics before equities do.' },
  { key: 'ig_oas', label: 'Investment-grade spread', grp: 'risk', source: 'fred', source_id: 'BAMLC0A0CM', unit: 'pct', decimals: 2, sort: 6,
    blurb: 'The same measure for safe corporate borrowers. Widens only in real trouble.' },
  { key: 'stlfsi', label: 'Financial stress index', grp: 'risk', source: 'fred', source_id: 'STLFSI4', unit: 'index', decimals: 3, sort: 7,
    blurb: 'St. Louis Fed, weekly. Zero is normal; above zero is tighter than normal.' },
  { key: 'nfci', label: 'Financial conditions', grp: 'risk', source: 'fred', source_id: 'NFCI', unit: 'index', decimals: 3, sort: 8,
    blurb: 'Chicago Fed, weekly. Negative = looser than average credit, leverage and risk.' },
  { key: 'spx_momentum', label: 'Market momentum', grp: 'risk', source: 'derived', unit: 'pct', decimals: 2, sort: 9,
    blurb: 'S&P 500 distance above its own 125-day average. Negative = trend has turned.' },
  { key: 'safe_haven', label: 'Safe-haven demand', grp: 'risk', source: 'derived', unit: 'pct', decimals: 2, sort: 10,
    blurb: '20-day stock return minus an estimated bond return. Negative = money hiding.' },
  { key: 'crypto_fng', label: 'Crypto Fear & Greed', grp: 'risk', source: 'cryptofng', unit: 'index', decimals: 0, sort: 11,
    blurb: 'alternative.me, 0-100. The most speculative money, so it turns first.' },
  // ---- rates ------------------------------------------------------------------
  { key: 'dgs3mo', label: '3-month Treasury', grp: 'rates', source: 'fred', source_id: 'DGS3MO', unit: 'pct', decimals: 2, sort: 20,
    blurb: 'Where policy actually sits right now.' },
  { key: 'dgs2', label: '2-year Treasury', grp: 'rates', source: 'fred', source_id: 'DGS2', unit: 'pct', decimals: 2, sort: 21,
    blurb: "The market's forecast of policy over the next two years." },
  { key: 'dgs10', label: '10-year Treasury', grp: 'rates', source: 'fred', source_id: 'DGS10', unit: 'pct', decimals: 2, sort: 22,
    blurb: 'The discount rate under every long-duration asset you own.' },
  { key: 't10y2y', label: '10y − 2y curve', grp: 'rates', source: 'fred', source_id: 'T10Y2Y', unit: 'pct', decimals: 2, sort: 23,
    blurb: 'Below zero is an inversion — historically an early recession signal.' },
  { key: 't10yie', label: '10y breakeven inflation', grp: 'rates', source: 'fred', source_id: 'T10YIE', unit: 'pct', decimals: 2, sort: 24,
    blurb: 'Inflation the bond market is actually pricing, not what forecasters say.' },
  // ---- macro ------------------------------------------------------------------
  { key: 'sp500', label: 'S&P 500', grp: 'macro', source: 'fred', source_id: 'SP500', unit: 'level', decimals: 0, sort: 40,
    blurb: 'Index level. Also feeds the momentum and safe-haven components above.' },
  { key: 'nasdaq', label: 'Nasdaq Composite', grp: 'macro', source: 'fred', source_id: 'NASDAQCOM', unit: 'level', decimals: 0, sort: 41,
    blurb: 'The long-duration, high-growth end of the equity market.' },
  { key: 'dxy', label: 'Dollar index', grp: 'macro', source: 'fred', source_id: 'DTWEXBGS', unit: 'index', decimals: 2, sort: 42,
    blurb: 'Broad trade-weighted dollar. A rising dollar tightens the whole world.' },
  { key: 'wti', label: 'WTI crude', grp: 'macro', source: 'fred', source_id: 'DCOILWTICO', unit: 'level', decimals: 2, sort: 43,
    blurb: 'Oil, $/barrel — the fastest-moving input to headline inflation.' },
  { key: 'cpi_yoy', label: 'US CPI, year on year', grp: 'macro', source: 'derived', unit: 'pct', decimals: 2, sort: 44,
    blurb: 'Realised inflation, monthly. Compare against the breakeven above.' },
  { key: 'unrate', label: 'US unemployment', grp: 'macro', source: 'fred', source_id: 'UNRATE', unit: 'pct', decimals: 1, sort: 45,
    blurb: 'Monthly. The other half of the mandate the Fed is trading off.' },
  { key: 'umcsent', label: 'Consumer sentiment', grp: 'macro', source: 'fred', source_id: 'UMCSENT', unit: 'index', decimals: 1, sort: 46,
    blurb: 'U. Michigan, monthly. How households feel, which is not how markets feel.' },
  { key: 'recession_prob', label: 'Recession probability', grp: 'macro', source: 'fred', source_id: 'RECPROUSM156N', unit: 'pct', decimals: 2, sort: 47,
    blurb: 'Smoothed model estimate, monthly. Slow-moving by construction.' },
  { key: 'gbpusd', label: 'GBP/USD', grp: 'macro', source: 'fred', source_id: 'DEXUSUK', unit: 'level', decimals: 4, sort: 48,
    blurb: 'Dollars per pound — the rate your UK balances convert at.' },
  { key: 'usdcny', label: 'USD/CNY', grp: 'macro', source: 'fred', source_id: 'DEXCHUS', unit: 'level', decimals: 4, sort: 49,
    blurb: 'Yuan per dollar. Beijing manages it, so moves are policy, not noise.' },
  { key: 'cpi_index', label: 'US CPI index', grp: 'macro', source: 'fred', source_id: 'CPIAUCSL', unit: 'level', decimals: 2, sort: 60,
    blurb: 'Raw index level. Carried only so the year-on-year rate above can be derived.' },
];

// The composite. dir = +1 when a high reading means greed, -1 when it means fear.
// `how: 'raw'` is for a component that already arrives as a 0-100 sentiment index;
// everything else is converted to a percentile of its own trailing year, which makes
// series on wildly different units (a ratio, a spread in %, a stress z-score) comparable.
const FEAR_COMPONENTS = [
  { key: 'vix',          label: 'Equity volatility',    dir: -1, how: 'percentile' },
  { key: 'vix_term',     label: 'Vol term structure',   dir: -1, how: 'percentile' },
  { key: 'hy_oas',       label: 'Credit spreads',       dir: -1, how: 'percentile' },
  { key: 'stlfsi',       label: 'Financial stress',     dir: -1, how: 'percentile' },
  { key: 'spx_momentum', label: 'Market momentum',      dir:  1, how: 'percentile' },
  { key: 'safe_haven',   label: 'Safe-haven demand',    dir:  1, how: 'percentile' },
  { key: 'crypto_fng',   label: 'Crypto risk appetite', dir:  1, how: 'raw' },
];

function fearLabel(score) {
  if (score == null) return '—';
  if (score < 20) return 'Extreme fear';
  if (score < 40) return 'Fear';
  if (score < 60) return 'Neutral';
  if (score < 80) return 'Greed';
  return 'Extreme greed';
}

// ---- metric catalogue -------------------------------------------------------
function seedSignalCatalog() {
  const up = db.prepare(`INSERT INTO signal_metrics (key, label, grp, source, source_id, unit, decimals, blurb, sort_order)
    VALUES (@key, @label, @grp, @source, @source_id, @unit, @decimals, @blurb, @sort)
    ON CONFLICT(key) DO UPDATE SET label=excluded.label, grp=excluded.grp, source=excluded.source,
      source_id=excluded.source_id, unit=excluded.unit, decimals=excluded.decimals,
      blurb=excluded.blurb, sort_order=excluded.sort_order`);
  const tx = db.transaction(() => {
    for (const m of SIGNAL_CATALOG) up.run({ source_id: null, ...m });
    // Drop metrics that have been removed from the catalogue, so the UI never renders a
    // tile the code no longer knows how to compute.
    const keys = SIGNAL_CATALOG.map((m) => m.key);
    db.prepare(`DELETE FROM signal_metrics WHERE key NOT IN (${keys.map(() => '?').join(',')})`).run(...keys);
  });
  tx();
}
try { seedSignalCatalog(); } catch (e) { console.error('signal catalogue warning:', e.message); }

// ---- storage helpers --------------------------------------------------------
const insertValue = db.prepare(`INSERT INTO signal_values (metric_key, date, value) VALUES (?, ?, ?)
  ON CONFLICT(metric_key, date) DO UPDATE SET value = excluded.value`);
const writeSeries = db.transaction((key, points) => {
  for (const p of points) if (Number.isFinite(p.value)) insertValue.run(key, p.date, p.value);
});
// Ascending by date, which every computation below depends on.
function seriesArray(key) {
  return db.prepare('SELECT date, value FROM signal_values WHERE metric_key = ? ORDER BY date').all(key);
}
function latestOf(key) {
  return db.prepare('SELECT date, value FROM signal_values WHERE metric_key = ? ORDER BY date DESC LIMIT 1').get(key) || null;
}

// ---- fetchers ---------------------------------------------------------------
// FRED's chart-download endpoint needs no API key and no registration, which is the
// whole reason the backbone of this module sits on it rather than on Yahoo (whose quote
// endpoint rate-limits to HTTP 429 without warning).
async function fetchFredSeries(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}&cosd=${FRED_START}`;
  const { data } = await axios.get(url, { timeout: 25000, responseType: 'text', ...netOpts() });
  const lines = String(data).trim().split(/\r?\n/);
  if (!lines.length || !/^observation_date|^DATE/i.test(lines[0])) throw new Error(`unexpected CSV header for ${seriesId}`);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(',');
    // FRED writes "." or an empty field for holidays and not-yet-published periods.
    const v = Number(raw);
    if (date && raw && raw !== '.' && Number.isFinite(v)) out.push({ date: date.trim(), value: v });
  }
  return out;
}

async function fetchCryptoFng() {
  // limit=0 asks for the whole history (daily since Feb 2018).
  const { data } = await axios.get('https://api.alternative.me/fng/?limit=0&format=json', { timeout: 20000, ...netOpts() });
  const rows = data?.data || [];
  return rows.map((r) => ({
    date: new Date(Number(r.timestamp) * 1000).toISOString().slice(0, 10),
    value: Number(r.value),
  })).filter((p) => Number.isFinite(p.value));
}

// Run async jobs with a small concurrency cap: polite to the upstream, and still turns a
// cold start into a handful of seconds rather than twenty sequential round trips.
async function pool(items, size, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results.push({ item: items[idx], value: await fn(items[idx]) }); }
      catch (e) { results.push({ item: items[idx], error: e.message }); }
    }
  }));
  return results;
}

// ---- derived series ---------------------------------------------------------
function movingAverage(arr, n) {
  // Returns a same-length array of trailing n-point means; null until the window fills.
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i].value;
    if (i >= n) sum -= arr[i - n].value;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function computeDerivedSeries() {
  // Vol term structure: front-month VIX over 3-month VIX, on dates where both printed.
  const v3 = new Map(seriesArray('vix3m').map((p) => [p.date, p.value]));
  const term = [];
  for (const p of seriesArray('vix')) {
    const base = v3.get(p.date);
    if (base > 0) term.push({ date: p.date, value: p.value / base });
  }
  writeSeries('vix_term', term);

  // Market momentum: how far the S&P sits above its own 125-day mean, in percent.
  // 125 sessions is roughly six months — long enough that it is a trend and not a week.
  const spx = seriesArray('sp500');
  const ma = movingAverage(spx, 125);
  writeSeries('spx_momentum', spx.map((p, i) => (ma[i] ? { date: p.date, value: (p.value / ma[i] - 1) * 100 } : null)).filter(Boolean));

  // Safe-haven demand: 20-session equity return minus an ESTIMATED bond return.
  // The estimate is -duration x change-in-yield with duration 8, the rough modified
  // duration of a 10-year note. It is an approximation and deliberately a crude one;
  // what matters for a percentile rank is the sign and the swing, not the basis points.
  const dgs10 = new Map(seriesArray('dgs10').map((p) => [p.date, p.value]));
  const LAG = 20;
  const haven = [];
  for (let i = LAG; i < spx.length; i++) {
    const now = spx[i], then = spx[i - LAG];
    const yNow = dgs10.get(now.date), yThen = dgs10.get(then.date);
    if (!(yNow >= 0) || !(yThen >= 0)) continue;
    const equityRet = (now.value / then.value - 1) * 100;
    const bondRet = -8 * (yNow - yThen);
    haven.push({ date: now.date, value: equityRet - bondRet });
  }
  writeSeries('safe_haven', haven);

  // CPI year on year from the raw index: 12 monthly observations back.
  const cpi = seriesArray('cpi_index');
  const yoy = [];
  for (let i = 12; i < cpi.length; i++) {
    yoy.push({ date: cpi[i].date, value: (cpi[i].value / cpi[i - 12].value - 1) * 100 });
  }
  writeSeries('cpi_yoy', yoy);
}

// ---- the composite ----------------------------------------------------------
// Percentile rank of x within window: the share of observations at or below it. A high
// VIX reading lands near 100 and is then flipped by dir = -1, so the published score
// always reads 0 = fear, 100 = greed.
function percentileRank(values, x) {
  if (!values.length) return null;
  let le = 0;
  for (const v of values) if (v <= x) le++;
  return (le / values.length) * 100;
}

function computeFearSeries() {
  const comps = FEAR_COMPONENTS.map((c) => ({ ...c, arr: seriesArray(c.key), lo: 0, hi: -1 }));
  const anchor = seriesArray('vix'); // the densest daily series: one score per session
  if (!anchor.length) return;
  const out = [];
  const windowMs = PCT_WINDOW_DAYS * 86400000;

  for (const day of anchor) {
    const dayMs = new Date(day.date).getTime();
    const cutoff = dayMs - windowMs;
    const parts = [];
    for (const c of comps) {
      // Advance `hi` to the last observation at or before this day (forward-fill, so a
      // weekly series like STLFSI keeps contributing on the four days it is silent).
      while (c.hi + 1 < c.arr.length && new Date(c.arr[c.hi + 1].date).getTime() <= dayMs) c.hi++;
      if (c.hi < 0) continue;
      while (c.lo < c.hi && new Date(c.arr[c.lo].date).getTime() < cutoff) c.lo++;
      const current = c.arr[c.hi].value;
      let score;
      if (c.how === 'raw') {
        score = Math.max(0, Math.min(100, current));
      } else {
        const window = [];
        for (let i = c.lo; i <= c.hi; i++) window.push(c.arr[i].value);
        if (window.length < PCT_MIN_OBS) continue;
        score = percentileRank(window, current);
      }
      if (score == null) continue;
      parts.push({ key: c.key, label: c.label, score: c.dir === -1 ? 100 - score : score, value: current, as_of: c.arr[c.hi].date });
    }
    // Four of seven is the floor. Fewer than that and the average says more about which
    // feeds happened to be up than about the market.
    if (parts.length < 4) continue;
    out.push({ date: day.date, value: parts.reduce((s, p) => s + p.score, 0) / parts.length, parts });
  }
  writeSeries('fear_index', out.map((o) => ({ date: o.date, value: o.value })));
  // Keep the newest breakdown so the UI can show which components drove today's score.
  const last = out[out.length - 1];
  if (last) metaSet('fear_breakdown', JSON.stringify({ date: last.date, parts: last.parts }));
}

// ---- venture: YC's public company directory ---------------------------------
// The honest framing, which the UI repeats: real venture aggregates (deal counts,
// valuations, dry powder) live behind Crunchbase / PitchBook / Dealroom paywalls. This
// is the best free structured substitute — one accelerator's whole 20-year history,
// which is a sample of early-stage taste rather than a picture of the market. It is
// still the fastest honest read on what the sector mix is doing batch over batch.
// Classifying a company as AI is the single most load-bearing judgement in this whole
// section, so it does not lean on tags alone. Two of the 2026 batches arrived with 136
// of 198 and 125 of 193 companies carrying NO tags at all, while the batches either side
// had two — an upstream tagging gap, not a collapse in AI funding. Tags-only detection
// reported AI falling from 66% to 24% and rebounding to 72%, which is an artefact, and a
// chart of it would have been a straightforwardly false claim about the market.
// So: tags OR the company's own one-liner, which is populated for essentially everyone.
const AI_TAG_RE = /\b(ai|artificial intelligence|machine learning|generative ai|ai assistant|conversational ai|computer vision|llm|deep learning)\b/i;
// Case-SENSITIVE \bAI\b on purpose: "AI" as a standalone word is a strong signal, while a
// case-insensitive match would catch "Ai" inside names. Bare "agent" is excluded too —
// insurance, travel and estate agents are not an AI thesis — but "agentic" and "AI agent"
// are kept.
const AI_TEXT_RE = /\bAI\b|\bA\.I\.|artificial intelligence|machine learning|deep learning|computer vision|\bLLMs?\b|\bGPT|agentic|AI agents?|co-?pilot|chatbot|\bNLP\b|generative/;
function looksLikeAI(tags, oneLiner, name) {
  if (tags.some((t) => AI_TAG_RE.test(t))) return true;
  return AI_TEXT_RE.test(`${oneLiner || ''} ${name || ''}`);
}
const SEASON_ORDER = { winter: 1, spring: 2, summer: 3, fall: 4, autumn: 4 };

function parseBatch(batch) {
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(String(batch || '').trim());
  if (!m) return { year: null, season: null };
  return { year: Number(m[2]), season: SEASON_ORDER[m[1].toLowerCase()] ?? null };
}

async function fetchVenture() {
  // ~11 MB of JSON, rebuilt upstream once a day — hence the 24-hour TTL above.
  const { data } = await axios.get('https://yc-oss.github.io/api/companies/all.json', {
    timeout: 90000, maxContentLength: 40 * 1024 * 1024, maxBodyLength: 40 * 1024 * 1024, ...netOpts(),
  });
  if (!Array.isArray(data)) throw new Error('unexpected YC payload');
  const rows = data.map((c) => {
    const { year, season } = parseBatch(c.batch);
    const tags = Array.isArray(c.tags) ? c.tags : [];
    return {
      id: c.id,
      name: c.name || null,
      batch: c.batch || null,
      batch_year: year,
      batch_season: season,
      industry: c.industry || null,
      subindustry: c.subindustry || null,
      // regions[0] is the country; the rest are continent / remote flags.
      country: (Array.isArray(c.regions) && c.regions[0]) || null,
      team_size: Number.isFinite(c.team_size) ? c.team_size : null,
      status: c.status || null,
      stage: c.stage || null,
      is_hiring: c.isHiring ? 1 : 0,
      top_company: c.top_company ? 1 : 0,
      is_ai: looksLikeAI(tags, c.one_liner, c.name) ? 1 : 0,
      tags: JSON.stringify(tags),
      one_liner: c.one_liner || null,
    };
  });
  const ins = db.prepare(`INSERT INTO venture_companies
    (id,name,batch,batch_year,batch_season,industry,subindustry,country,team_size,status,stage,is_hiring,top_company,is_ai,tags,one_liner)
    VALUES (@id,@name,@batch,@batch_year,@batch_season,@industry,@subindustry,@country,@team_size,@status,@stage,@is_hiring,@top_company,@is_ai,@tags,@one_liner)`);
  db.transaction(() => {
    db.prepare('DELETE FROM venture_companies').run();
    for (const r of rows) if (Number.isFinite(r.id)) ins.run(r);
  })();
  return rows.length;
}

// ---- refresh orchestration --------------------------------------------------
let refreshInFlight = null;

async function refreshSignals({ force = false } = {}) {
  const fredAt = Number(metaGet('signals_fred_at') || 0);
  const ycAt = Number(metaGet('signals_yc_at') || 0);
  const now = Date.now();
  const doFred = force || now - fredAt > SIGNALS_TTL_MS;
  const doYc = force || now - ycAt > VENTURE_TTL_MS;
  const errors = [];

  if (doFred) {
    const fredMetrics = SIGNAL_CATALOG.filter((m) => m.source === 'fred');
    const res = await pool(fredMetrics, 4, async (m) => writeSeries(m.key, await fetchFredSeries(m.source_id)));
    for (const r of res) if (r.error) errors.push(`${r.item.key}: ${r.error}`);
    try { writeSeries('crypto_fng', await fetchCryptoFng()); } catch (e) { errors.push(`crypto_fng: ${e.message}`); }
    // Derived series and the composite are rebuilt from whatever landed, so a single
    // failed feed degrades the score's component count instead of breaking the page.
    try { computeDerivedSeries(); computeFearSeries(); } catch (e) { errors.push(`derived: ${e.message}`); }
    // Only stamp success if at least most of it worked, so a network blip retries soon.
    if (errors.length < fredMetrics.length / 2) metaSet('signals_fred_at', String(now));
  }
  if (doYc) {
    try { await fetchVenture(); metaSet('signals_yc_at', String(now)); }
    catch (e) { errors.push(`venture: ${e.message}`); }
  }
  if (errors.length) console.error('signals refresh:', errors.join(' | '));
  return { refreshed: { fred: doFred, venture: doYc }, errors };
}

function signalsAreEmpty() {
  return !db.prepare('SELECT 1 FROM signal_values LIMIT 1').get();
}

// On a cold database the first request has to wait — there is nothing to show otherwise.
// Once there is history, a stale refresh happens in the background and the request is
// served from SQLite, so opening the tab is always instant after the first time.
async function ensureSignals() {
  if (signalsAreEmpty()) {
    if (!refreshInFlight) refreshInFlight = refreshSignals({ force: true }).finally(() => { refreshInFlight = null; });
    await refreshInFlight;
    return;
  }
  const stale = Date.now() - Number(metaGet('signals_fred_at') || 0) > SIGNALS_TTL_MS
    || Date.now() - Number(metaGet('signals_yc_at') || 0) > VENTURE_TTL_MS;
  if (stale && !refreshInFlight) {
    refreshInFlight = refreshSignals().finally(() => { refreshInFlight = null; });
    refreshInFlight.catch(() => { /* logged in refreshSignals */ });
  }
}

// Change over a lookback, in the metric's own units — the number next to each tile.
function changeOver(arr, days) {
  if (arr.length < 2) return null;
  const last = arr[arr.length - 1];
  const cutoff = new Date(last.date).getTime() - days * 86400000;
  let ref = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (new Date(arr[i].date).getTime() <= cutoff) { ref = arr[i]; break; }
  }
  if (!ref) ref = arr[0];
  return { from: ref.value, abs: last.value - ref.value, from_date: ref.date };
}

const SIGNAL_PERIOD_DAYS = { '1M': 31, '3M': 92, '6M': 184, '1Y': 366, '3Y': 1096, ALL: 100000 };

app.get('/api/signals', async (req, res) => {
  try {
    await ensureSignals();
    const metrics = db.prepare('SELECT * FROM signal_metrics ORDER BY sort_order, key').all();
    const spark = Number(req.query.spark) === 0 ? 0 : 90; // days of sparkline per tile
    const tiles = metrics.map((m) => {
      const arr = seriesArray(m.key);
      const last = arr[arr.length - 1] || null;
      const cutoff = last ? new Date(last.date).getTime() - spark * 86400000 : 0;
      return {
        ...m,
        value: last?.value ?? null,
        as_of: last?.date ?? null,
        d1: changeOver(arr, 1),
        d30: changeOver(arr, 30),
        d365: changeOver(arr, 365),
        points: spark ? arr.filter((p) => new Date(p.date).getTime() >= cutoff) : [],
      };
    });
    const fear = tiles.find((t) => t.key === 'fear_index') || null;
    let breakdown = null;
    try { breakdown = JSON.parse(metaGet('fear_breakdown') || 'null'); } catch { breakdown = null; }
    res.json({
      fear: fear ? { ...fear, label_text: fearLabel(fear.value), breakdown } : null,
      groups: {
        risk: tiles.filter((t) => t.grp === 'risk' && t.key !== 'fear_index'),
        rates: tiles.filter((t) => t.grp === 'rates'),
        macro: tiles.filter((t) => t.grp === 'macro'),
      },
      fetched_at: Number(metaGet('signals_fred_at') || 0) || null,
      refreshing: !!refreshInFlight,
    });
  } catch (err) {
    res.status(502).json({ error: `Could not load market signals: ${err.message}` });
  }
});

app.get('/api/signals/series/:key', (req, res) => {
  const meta = db.prepare('SELECT * FROM signal_metrics WHERE key = ?').get(req.params.key);
  if (!meta) return res.status(404).json({ error: 'Unknown metric.' });
  const days = SIGNAL_PERIOD_DAYS[req.query.period] ?? SIGNAL_PERIOD_DAYS['1Y'];
  const arr = seriesArray(meta.key);
  const last = arr[arr.length - 1];
  const cutoff = last ? new Date(last.date).getTime() - days * 86400000 : 0;
  res.json({ ...meta, points: arr.filter((p) => new Date(p.date).getTime() >= cutoff) });
});

app.post('/api/signals/refresh', async (req, res) => {
  try {
    if (!refreshInFlight) refreshInFlight = refreshSignals({ force: true }).finally(() => { refreshInFlight = null; });
    const out = await refreshInFlight;
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- venture map ------------------------------------------------------------
// Everything here is an aggregate over venture_companies. Batches before 2012 were tiny
// (7-22 companies), so a share computed on them swings wildly; the UI charts from 2012.
app.get('/api/venture', async (req, res) => {
  try {
    await ensureSignals();
    const total = db.prepare('SELECT COUNT(*) n FROM venture_companies').get()?.n || 0;
    if (!total) return res.json({ empty: true, batches: [], sectors: [], industries: [], as_of: null });

    const batches = db.prepare(`
      SELECT batch, batch_year, batch_season,
             COUNT(*)                                           AS companies,
             ROUND(100.0 * SUM(is_ai) / COUNT(*), 1)             AS ai_share,
             ROUND(100.0 * SUM(is_hiring) / COUNT(*), 1)         AS hiring_share,
             ROUND(100.0 * SUM(CASE WHEN country <> 'United States of America' THEN 1 ELSE 0 END) / COUNT(*), 1) AS non_us_share,
             SUM(CASE WHEN country = 'United Kingdom' THEN 1 ELSE 0 END)                       AS uk_companies,
             ROUND(100.0 * SUM(CASE WHEN status IN ('Acquired','Public') THEN 1 ELSE 0 END) / COUNT(*), 1) AS exit_share,
             ROUND(100.0 * SUM(CASE WHEN status = 'Inactive' THEN 1 ELSE 0 END) / COUNT(*), 1) AS dead_share,
             ROUND(AVG(NULLIF(team_size, 0)), 1)                 AS avg_team,
             ROUND(100.0 * SUM(CASE WHEN tags <> '[]' THEN 1 ELSE 0 END) / COUNT(*), 1) AS tag_coverage
      FROM venture_companies
      WHERE batch_year IS NOT NULL AND batch_season IS NOT NULL
      GROUP BY batch_year, batch_season
      ORDER BY batch_year, batch_season`).all();

    // Sector mix per batch, as a share of that batch — the stacked-area view.
    const sectors = db.prepare(`
      SELECT batch_year, batch_season, batch, industry, COUNT(*) AS n
      FROM venture_companies
      WHERE batch_year >= 2012 AND industry IS NOT NULL
      GROUP BY batch_year, batch_season, industry
      ORDER BY batch_year, batch_season`).all();

    const industries = db.prepare(`
      SELECT industry, COUNT(*) AS n,
             SUM(CASE WHEN batch_year >= 2024 THEN 1 ELSE 0 END) AS recent,
             ROUND(100.0 * SUM(is_ai) / COUNT(*), 1)             AS ai_share
      FROM venture_companies WHERE industry IS NOT NULL
      GROUP BY industry ORDER BY n DESC`).all();

    const subindustries = db.prepare(`
      SELECT subindustry, COUNT(*) AS n
      FROM venture_companies
      WHERE batch_year >= 2025 AND subindustry IS NOT NULL
      GROUP BY subindustry ORDER BY n DESC LIMIT 15`).all();

    const countries = db.prepare(`
      SELECT country, COUNT(*) AS n,
             SUM(CASE WHEN batch_year >= 2024 THEN 1 ELSE 0 END) AS recent
      FROM venture_companies WHERE country IS NOT NULL
      GROUP BY country ORDER BY recent DESC, n DESC LIMIT 12`).all();

    // A batch still being assembled (YC publishes companies as they are announced) has a
    // company count far below a real one. Flagged rather than dropped: the table should
    // still show it, but no trend line should be drawn through a batch of 21.
    const typical = batches.filter((b) => b.batch_year >= 2019).map((b) => b.companies).sort((a, b) => a - b);
    const median = typical.length ? typical[Math.floor(typical.length / 2)] : 0;
    for (const b of batches) {
      b.partial = b.companies < Math.max(25, median * 0.4) ? 1 : 0;
      // Thin upstream metadata. The one-liner fallback recovers most of a badly tagged
      // batch but not all of it, so these points are still likely to UNDERSTATE AI share.
      // Flagged so the chart can draw them as estimates rather than as measurements.
      b.low_confidence = b.tag_coverage != null && b.tag_coverage < 60 ? 1 : 0;
    }

    res.json({
      empty: false,
      total,
      batches,
      sectors,
      industries,
      subindustries,
      countries,
      as_of: Number(metaGet('signals_yc_at') || 0) || null,
    });
  } catch (err) {
    res.status(502).json({ error: `Could not load the venture map: ${err.message}` });
  }
});

// Warm the cache shortly after boot so the first visit to the tab is already populated.
// Deliberately not awaited: a slow or blocked network must never delay listen().
setTimeout(() => { refreshSignals().catch(() => { /* logged inside */ }); }, 2000);

// ---- Serve the built UI ----
// Registered last so it never shadows an /api route. With the frontend served from the
// same origin as the API there's one URL, one port, and no CORS involved at all — which
// is what makes a single Tailscale address work from any of your devices.
const WEB_DIR = process.env.FINANCIER_WEB_DIR || path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
  app.use(express.static(WEB_DIR));
  // SPA fallback: any non-/api path returns index.html so client routing works.
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));
}

// Start the server only when run directly (node server.js), not when imported by a
// test or an Electron main process. Every route is registered at module level above,
// so an imported `app` always carries the full API and this can't double-register them.
export function startServer() {
  return app.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Financier running at http://${shown}:${PORT}`);
    if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
      console.log('No built UI found — run "npm run build" in web/, or use the Vite dev server.');
    }
    console.log(AUTH_ENABLED
      ? `Login required${IS_LOOPBACK ? '' : ' — reachable from your other devices on this network'}.`
      : 'No password set: loopback only, no login. Set FINANCIER_PASSWORD to enable access from other devices.');
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();

export { app, DB_PATH };
