#!/usr/bin/env bash
# Financier v2 — endpoint curl tests
# Run AFTER: cd ~/asset-tracker && node server.js
# Usage: bash curl-tests.sh   (or paste blocks individually)
# Requires: jq  (brew install jq)  — remove "| jq" if you don't have it.

set -e
API=http://127.0.0.1:8000/api

echo "=================================================="
echo " 1. CREATE HOLDINGS (holding + first buy + memo)"
echo "=================================================="

# --- SNDK: 5 @ 584.91, TMT ---
echo "--- POST SNDK ---"
curl -s -X POST $API/holdings -H 'Content-Type: application/json' -d '{
  "ticker": "SNDK",
  "name": "SanDisk",
  "asset_type": "stock",
  "currency": "USD",
  "date": "2025-04-20",
  "price": 584.91,
  "shares": 5,
  "thesis": "AI Chip Memory, SSD NAND",
  "sector": "TMT"
}' | jq

# --- AXTI: first buy 20 @ 72.71, TMT ---
echo "--- POST AXTI (first buy) ---"
AXTI_ID=$(curl -s -X POST $API/holdings -H 'Content-Type: application/json' -d '{
  "ticker": "AXTI",
  "name": "AXT Inc",
  "asset_type": "stock",
  "currency": "USD",
  "date": "2025-04-20",
  "price": 72.71,
  "shares": 20,
  "thesis": "InP 衬底，光模块上游",
  "sector": "TMT"
}' | jq -r '.id')
echo "AXTI holding id = $AXTI_ID"

# --- MRVL: 50 @ 160.73, TMT ---
echo "--- POST MRVL ---"
curl -s -X POST $API/holdings -H 'Content-Type: application/json' -d '{
  "ticker": "MRVL",
  "name": "Marvell Technology",
  "asset_type": "stock",
  "currency": "USD",
  "date": "2025-04-20",
  "price": 160.73,
  "shares": 50,
  "thesis": "CPO 主线，定制 ASIC + 光电整合",
  "sector": "TMT"
}' | jq

echo "=================================================="
echo " 2. SECOND BUY on AXTI (70 more @ 76.00)"
echo "    -> one row, weighted avg cost"
echo "=================================================="
curl -s -X POST $API/holdings/$AXTI_ID/transactions -H 'Content-Type: application/json' -d '{
  "type": "buy",
  "date": "2025-05-02",
  "price": 76.00,
  "shares": 70,
  "notes": "second buy, same thesis"
}' | jq
# EXPECT: total_shares 90, avg_cost = (72.71*20 + 76*70)/90 = 75.2689

echo "=================================================="
echo " 3. GET all holdings (computed + live price + P&L)"
echo "=================================================="
curl -s $API/holdings | jq

echo "=================================================="
echo " 4. GET AXTI transactions (newest first + summary)"
echo "=================================================="
curl -s $API/holdings/$AXTI_ID/transactions | jq
# EXPECT: 2 transactions, total_shares 90, avg_cost ~75.27

echo "=================================================="
echo " 5. GET + PATCH memo (partial update)"
echo "=================================================="
curl -s $API/holdings/$AXTI_ID/memo | jq
curl -s -X PATCH $API/holdings/$AXTI_ID/memo -H 'Content-Type: application/json' -d '{
  "target_price": 95.0,
  "stop_loss": 60.0,
  "conviction": 4,
  "variant_perception": "Market underrates InP substrate supply constraints",
  "thesis_intact": "Yes"
}' | jq

echo "=================================================="
echo " 6. SELL test: partial then full close on a scratch holding"
echo "=================================================="
SCRATCH_ID=$(curl -s -X POST $API/holdings -H 'Content-Type: application/json' -d '{
  "ticker": "TEST",
  "name": "Scratch",
  "date": "2025-01-10",
  "price": 100,
  "shares": 10
}' | jq -r '.id')
echo "scratch id = $SCRATCH_ID"

echo "--- partial sell 4 @ 120 (expect total_shares 6, is_open 1) ---"
curl -s -X POST $API/holdings/$SCRATCH_ID/transactions -H 'Content-Type: application/json' -d '{
  "type": "sell", "date": "2025-02-01", "price": 120, "shares": 4
}' | jq

echo "--- full sell remaining 6 @ 130 (expect total_shares 0, is_open 0) ---"
curl -s -X POST $API/holdings/$SCRATCH_ID/transactions -H 'Content-Type: application/json' -d '{
  "type": "sell", "date": "2025-03-01", "price": 130, "shares": 6
}' | jq

echo "--- confirm closed holding no longer in GET /api/holdings ---"
curl -s $API/holdings | jq '[.[] | .ticker]'
# EXPECT: ["AXTI","MRVL","SNDK"]  — TEST excluded (is_open=0)

echo "--- cleanup scratch holding ---"
curl -s -X DELETE $API/holdings/$SCRATCH_ID | jq

echo "=================================================="
echo " 7. DUPLICATE ticker guard (expect 409)"
echo "=================================================="
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST $API/holdings \
  -H 'Content-Type: application/json' -d '{
  "ticker": "SNDK", "date": "2025-06-01", "price": 600, "shares": 1
}'
# EXPECT: HTTP 409

echo "=================================================="
echo " 8. SINGLE PRICE (15-min cache)"
echo "=================================================="
curl -s $API/price/MRVL | jq
echo "--- second call should show cached:true ---"
curl -s $API/price/MRVL | jq '.cached'

echo "=================================================="
echo " 9. CASH ACCOUNTS CRUD"
echo "=================================================="
echo "--- add CNY current ---"
curl -s -X POST $API/cash -H 'Content-Type: application/json' -d '{
  "account_name": "ICBC Current", "country": "CN", "currency": "CNY",
  "account_type": "current", "balance": 50000, "your_rate": 0.3
}' | jq

echo "--- add GBP ISA (fixed, with maturity) ---"
ISA_ID=$(curl -s -X POST $API/cash -H 'Content-Type: application/json' -d '{
  "account_name": "Trading212 ISA", "country": "UK", "currency": "GBP",
  "account_type": "ISA", "balance": 8000, "your_rate": 4.6,
  "rate_type": "fixed", "maturity_date": "2026-06-18"
}' | jq -r '.id')
echo "ISA id = $ISA_ID"

echo "--- get cash grouped by country ---"
curl -s $API/cash | jq

echo "--- patch ISA balance ---"
curl -s -X PATCH $API/cash/$ISA_ID -H 'Content-Type: application/json' -d '{
  "balance": 8200
}' | jq '.balance'

echo "--- maturing within 7 days (ISA matures 2026-06-18) ---"
curl -s "$API/cash/maturing?days=7" | jq '[.[] | .account_name]'

echo "=================================================="
echo " 10. SUMMARY (header totals)"
echo "=================================================="
curl -s $API/summary | jq

echo "=================================================="
echo " 11. REFRESH BOE RATE (live fetch — may fail if offline)"
echo "=================================================="
curl -s -X POST $API/cash/refresh-rates | jq

echo ""
echo "ALL TESTS DONE."
echo "Sanity checks to eyeball above:"
echo "  - AXTI avg_cost ≈ 75.27, total_shares 90  (single row, two buys)"
echo "  - TEST excluded from holdings after full sell (is_open 0)"
echo "  - duplicate SNDK returned 409"
echo "  - MRVL second price call cached:true"
echo "  - cash grouped under CN and UK"
