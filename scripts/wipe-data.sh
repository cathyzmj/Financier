#!/usr/bin/env bash
# Financier — wipe all user data for a clean shareable version.
# Clears holdings, transactions, memos, cash accounts, and cached prices.
# Keeps the schema intact. Stop the server (Ctrl-C) before running this.

DB=~/asset-tracker/tracker.db

if [ ! -f "$DB" ]; then
  echo "No database found at $DB — nothing to wipe."
  exit 0
fi

sqlite3 "$DB" <<'SQL'
PRAGMA foreign_keys = ON;
DELETE FROM transactions;
DELETE FROM memos;
DELETE FROM holdings;
DELETE FROM cash_accounts;
DELETE FROM price_cache;
DELETE FROM reference_rates;
DELETE FROM sqlite_sequence;   -- reset AUTOINCREMENT counters to 1
VACUUM;
SQL

echo "Wiped. Row counts now:"
sqlite3 "$DB" "SELECT 'holdings', COUNT(*) FROM holdings
  UNION ALL SELECT 'transactions', COUNT(*) FROM transactions
  UNION ALL SELECT 'memos', COUNT(*) FROM memos
  UNION ALL SELECT 'cash_accounts', COUNT(*) FROM cash_accounts;"
