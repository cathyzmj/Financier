-- Financier v2 schema
-- holdings = identity + memo link only; transactions = source of truth for all position state.
-- avg_cost / total_shares / market_value / P&L are computed in the backend, never stored.

PRAGMA foreign_keys = ON;

-- holdings: identity only, one row per ticker
CREATE TABLE IF NOT EXISTS holdings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker      TEXT NOT NULL UNIQUE,
  name        TEXT,
  asset_type  TEXT NOT NULL DEFAULT 'stock', -- stock | etf
  currency    TEXT NOT NULL DEFAULT 'USD',
  is_open     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- transactions: every buy and sell
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id  INTEGER NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,  -- buy | sell
  date        TEXT NOT NULL,  -- ISO date: 2025-04-20
  price       REAL NOT NULL,  -- per share, USD
  shares      REAL NOT NULL,  -- always positive
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- memos: investment logic, 1:1 with holdings
CREATE TABLE IF NOT EXISTS memos (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id         INTEGER NOT NULL UNIQUE REFERENCES holdings(id) ON DELETE CASCADE,
  thesis             TEXT,
  sector             TEXT,   -- TMT|Healthcare|Energy|Consumer|Financials|Industrials|Other
  catalysts          TEXT,
  target_price       REAL,
  stop_loss          REAL,
  time_horizon       TEXT,
  conviction         INTEGER, -- 1-5
  position_size_pct  REAL,
  macro_context      TEXT,
  sector_view        TEXT,
  risk_factors       TEXT,
  variant_perception TEXT,
  tracks             TEXT,   -- ETF: index/asset it tracks, e.g. "S&P 500"
  expense_ratio      REAL,   -- ETF: annual fee %
  thesis_intact      TEXT DEFAULT 'Yes', -- Yes|Partially|No
  catalyst_status    TEXT,
  exit_date          TEXT,
  exit_price         REAL,
  exit_reason        TEXT,   -- TakeProfit|StopLoss|ThesisBroken|BetterOpp|Other
  post_mortem        TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- cash_accounts: bank deposits, manual entry
CREATE TABLE IF NOT EXISTS cash_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name  TEXT NOT NULL,
  bank          TEXT,            -- HSBC | Lloyds | ... | Other
  product       TEXT,            -- e.g. "1-Year Fixed Rate Bond"
  country       TEXT NOT NULL,   -- ISO-ish country name/code
  currency      TEXT NOT NULL,   -- any ISO currency
  category      TEXT NOT NULL DEFAULT 'current', -- current | savings
  access_type   TEXT,            -- easy_access | fixed   (only when category = savings)
  is_isa        INTEGER NOT NULL DEFAULT 0,       -- tax wrapper: 0 = no, 1 = yes
  is_monthly_saver INTEGER NOT NULL DEFAULT 0,    -- regular saver: balance accrues monthly
  monthly_amount   REAL,                          -- amount paid in each month
  account_ref      TEXT,                           -- free-text: sort code + account no, card no, IBAN, etc.
  term          TEXT,            -- Instant | 1yr | 2yr | 3yr | 5yr
  balance       REAL NOT NULL DEFAULT 0,
  your_rate     REAL,
  start_date    TEXT,
  maturity_date TEXT,
  notes         TEXT,
  last_updated  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- thesis_history: append-only log of thesis edits, so the evolution of thinking is visible
CREATE TABLE IF NOT EXISTS thesis_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id  INTEGER NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  thesis      TEXT NOT NULL,
  logged_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- bonds: individually-held bonds (gilts, treasuries, corporates)
CREATE TABLE IF NOT EXISTS bonds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,        -- e.g. "UK Treasury 4.25% 2032"
  issuer        TEXT,                 -- UK Govt | US Treasury | company name
  bond_type     TEXT,                 -- gilt | treasury | corporate | other
  currency      TEXT NOT NULL DEFAULT 'GBP',
  face_value    REAL NOT NULL,        -- par value per bond (e.g. 100)
  quantity      REAL NOT NULL DEFAULT 1, -- number of bonds / units held
  coupon_rate   REAL NOT NULL,        -- annual coupon % of face
  frequency     INTEGER NOT NULL DEFAULT 2, -- coupon payments per year (1/2/4)
  purchase_price REAL NOT NULL,       -- clean price paid per bond
  purchase_date TEXT,
  maturity_date TEXT NOT NULL,
  current_price REAL,                 -- optional manual mark
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- budget_settings: one row holding the user's monthly budget + base currency
CREATE TABLE IF NOT EXISTS budget_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row
  monthly_budget  REAL NOT NULL DEFAULT 0,
  base_currency   TEXT NOT NULL DEFAULT 'GBP',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- expenses: every spend entry
CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,   -- ISO date
  amount      REAL NOT NULL,   -- in original currency
  currency    TEXT NOT NULL,   -- currency it was spent in
  category    TEXT NOT NULL,   -- Food | Transport | Shopping | Entertainment | Living | Other
  wallet      TEXT,            -- Monzo | Revolut | WeChat | Alipay | Cash | ...
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- fx_cache: foreign exchange rates, 1-hour TTL
CREATE TABLE IF NOT EXISTS fx_cache (
  pair        TEXT PRIMARY KEY,  -- e.g. "CNY_GBP"
  rate        REAL NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- price_cache: 15-min TTL
CREATE TABLE IF NOT EXISTS price_cache (
  ticker      TEXT PRIMARY KEY,
  price       REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  change_pct  REAL,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- reference_rates: central bank rates, auto-fetched
CREATE TABLE IF NOT EXISTS reference_rates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  country     TEXT NOT NULL,
  rate_name   TEXT NOT NULL,
  rate_value  REAL NOT NULL,
  source      TEXT,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_holding ON transactions(holding_id);
CREATE INDEX IF NOT EXISTS idx_memo_holding ON memos(holding_id);
CREATE INDEX IF NOT EXISTS idx_thesis_holding ON thesis_history(holding_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
