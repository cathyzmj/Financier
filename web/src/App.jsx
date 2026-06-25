import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import './App.css';

// Backend MUST be 127.0.0.1 — localhost resolves to IPv6 on this Mac and refuses connection.
const API = 'http://127.0.0.1:8000/api';

// Bump on each released change set (semver: MAJOR.MINOR.PATCH). Shown in the header.
const APP_VERSION = '2.8.0';

// Common Yahoo Finance exchange suffixes — offered as suggestions when editing an
// IBKR import ticker (e.g. typing "2DG." suggests 2DG.MU, 2DG.F, …).
const YAHOO_SUFFIXES = ['.MU', '.F', '.DE', '.SG', '.BE', '.DU', '.HM', '.L', '.PA', '.AS', '.BR', '.MI', '.MC', '.SW', '.ST', '.OL', '.CO', '.HE', '.VI', '.WA', '.HK', '.T', '.SI', '.AX', '.KS', '.TW', '.TO', '.V'];

const SECTORS = ['TMT', 'Healthcare', 'Energy', 'Consumer', 'Financials', 'Industrials', 'Other'];
const TERMS = ['Short', 'Medium', 'Long'];
// Seed investing-style strategies, shown as a visual picker (sticker + description so
// each is self-explanatory). Free-text + extensible: type a new one and it's
// remembered (appears as a chip next time).
const STRATEGY_PRESETS = [
  { label: 'Macro-dip ETF', icon: '📉', desc: 'Hold an index/ETF, add on macro pullbacks' },
  { label: 'Industry growth', icon: '🚀', desc: 'Pick a stock, wait for exponential growth' },
  { label: 'Technical', icon: '📊', desc: 'Chart & technical signals' },
  { label: 'Sentiment', icon: '🗣️', desc: 'Market sentiment / momentum' },
  { label: 'Income', icon: '💵', desc: 'Bonds / dividends for yield' },
  { label: 'Other', icon: '✳️', desc: 'Something else' },
];
const STRATEGIES = STRATEGY_PRESETS.map((p) => p.label);
const BANKS = ['HSBC', 'Lloyds', 'Barclays', 'NatWest', 'Santander', 'Halifax', 'Nationwide', 'Monzo', 'Revolut', 'Starling', 'Chase', 'TSB', 'Co-operative Bank', 'First Direct', 'Metro Bank', 'Virgin Money', 'ICBC (工商银行)', 'China Construction Bank (建设银行)', 'Agricultural Bank of China (农业银行)', 'Bank of China (中国银行)', 'Postal Savings Bank of China (邮政储蓄)', 'Bank of Communications (交通银行)', 'China Merchants Bank (招商银行)', 'CITIC Bank (中信银行)', 'China Everbright Bank (光大银行)', 'Ping An Bank (平安银行)', 'Citibank', 'JPMorgan Chase', 'Bank of America', 'Wells Fargo', 'Goldman Sachs (Marcus)', 'Standard Chartered', 'DBS', 'OCBC'];
const ACCESS_TYPES = [
  { value: 'easy_access', label: 'Easy-access' },
  { value: 'fixed', label: 'Fixed-rate' },
];
// Account terms with month offsets for auto-calculating maturity. Instant = no maturity.
const ACCOUNT_TERMS = [
  { value: '', label: 'Instant / no term', months: null },
  { value: '1yr', label: '1 year', months: 12 },
  { value: '2yr', label: '2 years', months: 24 },
  { value: '3yr', label: '3 years', months: 36 },
  { value: '5yr', label: '5 years', months: 60 },
];
// Add `months` to an ISO date string (YYYY-MM-DD); returns ISO date.
function addMonths(isoDate, months) {
  if (!isoDate || months == null) return '';
  const d = new Date(isoDate + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
const EXIT_REASONS = ['TakeProfit', 'StopLoss', 'ThesisBroken', 'BetterOpp', 'Other'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'HKD', 'CHF', 'CAD', 'AUD', 'NZD', 'SGD', 'KRW', 'INR', 'TWD', 'THB', 'MYR', 'IDR', 'PHP', 'VND', 'AED', 'SAR', 'ZAR', 'BRL', 'MXN', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'RUB', 'ILS'];
const COUNTRIES = ['United Kingdom', 'United States', 'China', 'Hong Kong', 'Japan', 'Singapore', 'South Korea', 'Taiwan', 'India', 'Australia', 'New Zealand', 'Canada', 'Germany', 'France', 'Switzerland', 'Netherlands', 'Ireland', 'Spain', 'Italy', 'Sweden', 'Norway', 'Denmark', 'Poland', 'United Arab Emirates', 'Saudi Arabia', 'South Africa', 'Brazil', 'Mexico', 'Other'];
const COUNTRY_FLAGS = {
  'China': '🇨🇳', 'United Kingdom': '🇬🇧', 'United States': '🇺🇸', 'Hong Kong': '🇭🇰',
  'Japan': '🇯🇵', 'Singapore': '🇸🇬', 'South Korea': '🇰🇷', 'Taiwan': '🇹🇼', 'India': '🇮🇳',
  'Australia': '🇦🇺', 'New Zealand': '🇳🇿', 'Canada': '🇨🇦', 'Germany': '🇩🇪', 'France': '🇫🇷',
  'Switzerland': '🇨🇭', 'Netherlands': '🇳🇱', 'Ireland': '🇮🇪', 'Spain': '🇪🇸', 'Italy': '🇮🇹',
  'Sweden': '🇸🇪', 'Norway': '🇳🇴', 'Denmark': '🇩🇰', 'Poland': '🇵🇱',
  'United Arab Emirates': '🇦🇪', 'Saudi Arabia': '🇸🇦', 'South Africa': '🇿🇦',
  'Brazil': '🇧🇷', 'Mexico': '🇲🇽', 'Other': '🏳️',
};

// ---------- formatting helpers ----------
const fmtMoney = (n, cur = 'USD') =>
  n == null ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
const fmtNum = (n, d = 2) => (n == null ? '—' : Number(n).toFixed(d));
const fmtPct = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const pnlClass = (n) => (n == null ? '' : n >= 0 ? 'pos' : 'neg');
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Build a CSV from an array of {header, value} column defs over rows, and download it.
// Each column is [header, accessorFn]. Values are CSV-escaped.
function exportCsv(filename, columns, rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c[0])).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c[1](r))).join(',')).join('\n');
  const csv = head + '\n' + body;
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Render a readable account type from the MECE fields.
function accountTypeLabel(a) {
  if (a.category === 'current') return a.is_isa ? 'Current · ISA' : 'Current';
  const access = a.access_type === 'fixed' ? 'Fixed-rate' : 'Easy-access';
  return a.is_isa ? `${access} · ISA` : access;
}

// Type-to-filter select: shows options, filters as you type, click or Enter to pick.
function SearchSelect({ value, onChange, options, placeholder, allowCustom }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shown = open && query
    ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
    : options;
  const exactMatch = options.some((o) => o.toLowerCase() === query.trim().toLowerCase());
  const commit = (v) => { onChange(v); setOpen(false); setQuery(''); };
  return (
    <div style={{ position: 'relative' }}>
      <input
        value={open ? query : value}
        placeholder={placeholder || value}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setQuery(''); setOpen(true); }}
        onBlur={() => setTimeout(() => {
          // For free-text fields, keep whatever was typed if it's non-empty.
          if (allowCustom && query.trim()) onChange(query.trim());
          setOpen(false);
        }, 150)}
        autoComplete="off"
      />
      {open && (shown.length > 0 || (allowCustom && query.trim() && !exactMatch)) && (
        <ul className="autocomplete">
          {allowCustom && query.trim() && !exactMatch && (
            <li onMouseDown={() => commit(query.trim())}>
              <span className="ac-symbol">Use “{query.trim()}”</span>
            </li>
          )}
          {shown.map((o) => (
            <li key={o} onMouseDown={() => commit(o)}>
              <span className="ac-symbol">{o}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('overview');
  const [view, setView] = useState({ name: 'list' }); // list | memo
  const [holdings, setHoldings] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [txHolding, setTxHolding] = useState(null); // holding object for drawer
  const [pnlMode, setPnlMode] = useState('money'); // money | pct — toggled in the table header

  const loadPortfolio = useCallback(async (isRefresh) => {
    if (!isRefresh) setLoading(true);
    try {
      const [h, s] = await Promise.all([
        axios.get(`${API}/holdings`),
        axios.get(`${API}/summary`),
      ]);
      setHoldings(h.data);
      setSummary(s.data);
    } catch (err) {
      console.error('load failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio]);

  const deleteHolding = async (id) => {
    if (!window.confirm('Delete this holding and all its transactions and memo?')) return;
    await axios.delete(`${API}/holdings/${id}`);
    // Remove the row immediately for an instant feel, then reconcile totals in the
    // background (the refetch re-prices every holding and can take a second or two).
    setHoldings((prev) => prev.filter((h) => h.id !== id));
    loadPortfolio(true);
  };

  return (
    <>
      <Header summary={summary} tab={tab} setTab={(t) => { setTab(t); setView({ name: 'list' }); }} />

      <main className="main">
        {tab === 'overview' && <Overview />}

        {tab === 'investing' && view.name === 'list' && (
          <Portfolio
            holdings={holdings}
            loading={loading}
            pnlMode={pnlMode}
            onTogglePnl={() => setPnlMode((m) => (m === 'money' ? 'pct' : 'money'))}
            onAdd={() => setShowAdd(true)}
            onMemo={(h) => setView({ name: 'memo', holding: h })}
            onTx={(h) => setTxHolding(h)}
            onDelete={deleteHolding}
            onSynced={() => loadPortfolio(true)}
          />
        )}

        {tab === 'investing' && view.name === 'memo' && (
          <MemoPage
            holding={view.holding}
            onBack={() => { setView({ name: 'list' }); loadPortfolio(); }}
          />
        )}

        {tab === 'banking' && <CashTab />}

        {tab === 'journal' && <Journal onOpen={(h) => { setTab('investing'); setView({ name: 'memo', holding: h }); }} />}
      </main>

      {showAdd && (
        <AddPositionModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); loadPortfolio(true); }}
        />
      )}

      {txHolding && (
        <TransactionsDrawer
          holding={txHolding}
          onClose={() => { setTxHolding(null); loadPortfolio(true); }}
        />
      )}
    </>
  );
}

// ============================ OVERVIEW ============================
const PERIODS = ['1D', 'WTD', 'MTD', '1M', '3M', 'YTD'];
// Bauhaus palette for pie slices — brick/cobalt/ochre family + neutrals.
const PIE_COLORS = ['#c8431f', '#234e9c', '#e8a32c', '#1d6e3a', '#8b6020', '#7a5c9c', '#4a8a8a', '#a8602f', '#5a7a3a'];

function Overview() {
  const [period, setPeriod] = useState('1M');
  const [metric, setMetric] = useState('value'); // value | performance
  const [base, setBase] = useState('GBP');
  const [alloc, setAlloc] = useState(null);
  const [series, setSeries] = useState(null);
  const [windowStart, setWindowStart] = useState(null);
  const [loadingSeries, setLoadingSeries] = useState(true);

  useEffect(() => {
    axios.get(`${API}/overview/allocation?base=${base}`).then((r) => setAlloc(r.data)).catch(() => setAlloc(null));
  }, [base]);

  useEffect(() => {
    setLoadingSeries(true);
    axios.get(`${API}/overview/timeseries?period=${period}`)
      .then((r) => { setSeries(r.data.points || []); setWindowStart(r.data.window_start || null); })
      .catch(() => setSeries([]))
      .finally(() => setLoadingSeries(false));
  }, [period]);

  const baseSym = ({ GBP: '£', USD: '$', CNY: '¥', EUR: '€', HKD: 'HK$', JPY: '¥' }[base] || (base + ' '));
  const fmtBase = (n) => n == null ? '—' : `${baseSym}${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const pieData = alloc
    ? [...(alloc.equity_slices || []), ...(alloc.bank_slices || [])]
    : [];
  const hasPie = pieData.length > 0;
  const hasSeries = series && series.length > 1;
  // The reconstruction only reaches back to the earliest transaction. If that's later
  // than the requested window start, the chart is shorter than the period — say so.
  const shortHistory = hasSeries && windowStart && series[0].date > windowStart;

  // Performance = % return vs the first point in the window (rebased to 0).
  const chartData = (series || []).map((p) => ({
    date: p.date,
    value: p.value,
    performance: p.pnl_pct,
  }));
  const firstPct = hasSeries ? chartData[0].performance : null;
  const rebased = chartData.map((p) => ({
    ...p,
    rebased: (p.performance != null && firstPct != null) ? p.performance - firstPct : null,
  }));

  const lineColor = metric === 'value' ? '#234e9c'
    : (hasSeries && rebased[rebased.length - 1].rebased >= 0 ? '#1d6e3a' : '#a83030');

  return (
    <>
      <div className="section-head">
        <div className="section-titles">
          <h2>Overview</h2>
          <div className="subnav">
            {PERIODS.map((p) => (
              <button
                key={p}
                className={`subnav-item ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >{p}</button>
            ))}
          </div>
        </div>
        <div className="metric-toggle">
          <button className={metric === 'value' ? 'active' : ''} onClick={() => setMetric('value')}>Value</button>
          <button className={metric === 'performance' ? 'active' : ''} onClick={() => setMetric('performance')}>Performance</button>
        </div>
      </div>

      {alloc && (
        <div className="networth-band">
          <div className="nw-main">
            <div className="nw-row">
              <span className="mono nw-label">Net worth</span>
              <div className="nw-base">
                {['GBP', 'USD', 'CNY', 'EUR'].map((c) => (
                  <button key={c} className={base === c ? 'active' : ''} onClick={() => setBase(c)}>{c}</button>
                ))}
              </div>
            </div>
            <div className="nw-value">{fmtBase(alloc.net_worth)}</div>
          </div>
          <div className="nw-split">
            <div className="nw-stat"><span className="mono">Investing</span><span className="nw-sub">{fmtBase(alloc.equity_total)}</span></div>
            <div className="nw-stat"><span className="mono">Bank accounts</span><span className="nw-sub">{fmtBase(alloc.bank_total)}</span></div>
          </div>
        </div>
      )}
      {alloc && !alloc.fx_ok && <p className="ov-note" style={{ color: 'var(--negative)' }}>Some live FX rates couldn't be fetched — totals may be incomplete.</p>}

      <div className="overview-grid">
        <div className="ov-card">
          <span className="mono ov-card-label">Allocation · {base}</span>
          {!hasPie ? (
            <div className="empty">No assets yet. Add a position or account.</div>
          ) : (
            <div className="pie-wrap">
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="label" cx="50%" cy="50%" outerRadius={100} innerRadius={55}
                    label={({ percent }) => percent >= 0.04 ? `${(percent * 100).toFixed(0)}%` : ''}
                    labelLine={false}
                    style={{ fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
                    {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [fmtBase(v), n]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pie-legend">
                {(() => {
                  const total = pieData.reduce((s, x) => s + x.value, 0);
                  return pieData.map((s, i) => (
                    <div className="legend-row" key={s.label}>
                      <span className="legend-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="legend-label">{s.label}</span>
                      <span className="legend-pct">{total > 0 ? `${((s.value / total) * 100).toFixed(1)}%` : ''}</span>
                      <span className="legend-val">{fmtBase(s.value)}</span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
          {alloc?.note && <p className="ov-note">{alloc.note}</p>}
        </div>

        <div className="ov-card">
          <span className="mono ov-card-label">{metric === 'value' ? 'Portfolio value' : 'Performance'} · {period}</span>
          {loadingSeries ? (
            <div className="loading">Reconstructing from historical prices…</div>
          ) : !hasSeries ? (
            <div className="empty">Not enough history for this period yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={rebased} margin={{ top: 10, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#d4cdc0" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fontFamily: 'DM Mono, monospace' }} tickFormatter={(d) => d.slice(5)} minTickGap={40} stroke="#7a7268" />
                <YAxis
                  tick={{ fontSize: 11, fontFamily: 'DM Mono, monospace' }}
                  stroke="#7a7268"
                  width={60}
                  tickFormatter={(v) => metric === 'value' ? `$${(v / 1000).toFixed(0)}k` : `${v.toFixed(0)}%`}
                  domain={metric === 'performance' ? ['auto', 'auto'] : ['auto', 'auto']}
                />
                <Tooltip
                  formatter={(v) => metric === 'value' ? fmtMoney(v) : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}
                  labelStyle={{ fontFamily: 'DM Mono, monospace', fontSize: 12 }}
                />
                <Line
                  type="monotone"
                  dataKey={metric === 'value' ? 'value' : 'rebased'}
                  stroke={lineColor}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
          {shortHistory && (
            <p className="ov-note">Only {series.length} days available — your earliest transaction is {series[0].date}, so there's no portfolio history before then for this period. Rebuild a position from its broker trade history (Investing → Import) to extend it.</p>
          )}
        </div>
      </div>
    </>
  );
}

// ============================ JOURNAL ============================
// Download a text/markdown file (the journal export).
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Build a Markdown investment journal from the /api/journal rows — formatted to hand
// to an AI for analysis.
function journalMarkdown(rows) {
  const money = (n, c = 'USD') => (n == null ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(n));
  const open = rows.filter((r) => r.is_open);
  const closed = rows.filter((r) => !r.is_open);
  const lines = ['# Financier — Investment Journal', '', `_Exported ${new Date().toISOString().slice(0, 10)}._`, ''];
  const section = (title, list) => {
    lines.push(`## ${title}`, '');
    if (!list.length) { lines.push('_None._', ''); return; }
    for (const r of list) {
      const cur = r.currency || 'USD';
      lines.push(`### ${r.ticker}${r.name ? ` — ${r.name}` : ''}${r.sector ? ` · ${r.sector}` : ''}`);
      if (r.thesis) lines.push(`- **Thesis:** ${r.thesis}`);
      if (r.strategy) lines.push(`- **Strategy:** ${r.strategy}`);
      if (r.conviction != null) lines.push(`- **Conviction:** ${r.conviction}/5${r.time_horizon ? ` · Horizon: ${r.time_horizon}` : ''}`);
      lines.push(`- **Entry:** ${r.entry_date || '—'} @ ${money(r.avg_cost, cur)}${r.total_shares ? ` · ${r.total_shares} shares` : ''}`);
      if (r.catalysts) lines.push(`- **Catalysts:** ${r.catalysts}`);
      if (r.risk_factors) lines.push(`- **Risks:** ${r.risk_factors}`);
      if (r.target_price != null || r.stop_loss != null) lines.push(`- **Target / Stop:** ${money(r.target_price, cur)} / ${money(r.stop_loss, cur)}`);
      if (r.is_open) {
        lines.push(`- **Status:** Open${r.current_price != null ? ` · now ${money(r.current_price, cur)}` : ''}${r.unrealized_pnl != null ? ` · unrealized ${money(r.unrealized_pnl, cur)}` : ''}`);
      } else {
        lines.push(`- **Exit:** ${r.exit_date || r.last_sell_date || '—'}${r.exit_price != null ? ` @ ${money(r.exit_price, cur)}` : ''} · reason: ${r.exit_reason || '—'}`);
        lines.push(`- **Realized P&L:** ${money(r.realized_pnl, cur)}`);
        if (r.post_mortem) lines.push(`- **Post-mortem:** ${r.post_mortem}`);
      }
      if (r.thesis_history && r.thesis_history.length > 1) {
        lines.push('- **Thesis evolution:**');
        for (const th of r.thesis_history) lines.push(`  - ${(th.logged_at || '').slice(0, 10)}: ${th.thesis}`);
      }
      lines.push('');
    }
  };
  section('Open positions', open);
  section('Closed positions', closed);
  return lines.join('\n');
}

// Minimal markdown renderer for the AI analysis (## headings, - bullets, **bold**).
function MarkdownLite({ text }) {
  const inline = (s) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    (part.startsWith('**') && part.endsWith('**'))
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>);
  const out = []; let bullets = null;
  const flush = (key) => { if (bullets) { out.push(<ul key={`u${key}`}>{bullets}</ul>); bullets = null; } };
  (text || '').split('\n').forEach((ln, i) => {
    const t = ln.trim();
    if (t.startsWith('### ')) { flush(i); out.push(<h4 key={i} className="md-h">{inline(t.slice(4))}</h4>); }
    else if (t.startsWith('## ')) { flush(i); out.push(<h4 key={i} className="md-h">{inline(t.slice(3))}</h4>); }
    else if (t.startsWith('- ') || t.startsWith('* ')) { (bullets || (bullets = [])).push(<li key={i}>{inline(t.slice(2))}</li>); }
    else if (t === '') { flush(i); }
    else { flush(i); out.push(<p key={i} className="md-p">{inline(t)}</p>); }
  });
  flush('end');
  return <div className="md">{out}</div>;
}

function Journal({ onOpen }) {
  const [rows, setRows] = useState(null);
  const [copied, setCopied] = useState(false);
  const [aiKey, setAiKey] = useState(() => localStorage.getItem('financier.anthropic.key') || '');
  const [keyOpen, setKeyOpen] = useState(false);
  const [review, setReview] = useState(null);          // { mode, model, text } | { error }
  const [reviewLoading, setReviewLoading] = useState(false);
  useEffect(() => { axios.get(`${API}/journal`).then((r) => setRows(r.data)).catch(() => setRows([])); }, []);
  if (rows == null) return <div className="loading">Loading journal…</div>;
  const open = rows.filter((r) => r.is_open);
  const closed = rows.filter((r) => !r.is_open);

  const runAnalysis = async (mode) => {
    setReview(null); setReviewLoading(true);
    try {
      const r = await axios.post(`${API}/journal/review`, { mode, api_key: aiKey.trim() || undefined }, { timeout: 135000 });
      if (r.data.error === 'no_key') { setKeyOpen(true); setReview({ error: 'Add your Anthropic API key to run the analysis — it stays on this machine.' }); }
      else setReview({ mode, model: r.data.model, text: r.data.review });
    } catch (e) {
      setReview({ error: e.response?.data?.error || 'Analysis failed — is the backend running (and your VPN on, in China)?' });
    } finally { setReviewLoading(false); }
  };
  const saveKey = () => { localStorage.setItem('financier.anthropic.key', aiKey.trim()); setKeyOpen(false); };
  const copyJson = async () => {
    try { const r = await axios.get(`${API}/journal/payload`); await navigator.clipboard.writeText(JSON.stringify(r.data, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  };
  const downloadJson = async () => {
    const r = await axios.get(`${API}/journal/payload`);
    downloadText(`financier-journal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(r.data, null, 2));
  };

  return (
    <>
      <div className="section-head">
        <div className="section-titles">
          <h2>Journal</h2>
          <div className="subnav"><span className="mono">{open.length} open · {closed.length} closed · click a card to open it</span></div>
        </div>
        {rows.length > 0 && (
          <div className="head-actions">
            <button className="btn-primary" onClick={() => runAnalysis('review')} disabled={reviewLoading}>{reviewLoading ? 'Analysing…' : 'Review decisions (AI)'}</button>
            <button className="csv-btn" onClick={() => runAnalysis('style')} disabled={reviewLoading}>Style profile (AI)</button>
            <button className="csv-btn" onClick={copyJson}>{copied ? 'Copied ✓' : 'Copy data (JSON)'}</button>
            <button className="csv-btn" onClick={downloadJson}>Download JSON</button>
            <button className="csv-btn" onClick={() => setKeyOpen((o) => !o)} title="Set Anthropic API key">{aiKey ? 'AI key ✓' : 'Set AI key'}</button>
          </div>
        )}
      </div>

      {keyOpen && (
        <div className="key-row">
          <input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder="Anthropic API key (sk-ant-…) — stored locally on this device" />
          <button className="btn-primary" onClick={saveKey}>Save</button>
        </div>
      )}
      {reviewLoading && <div className="ai-box"><span className="mono">AI analysis · claude-opus-4-8</span>Reading your decisions and reasoning…</div>}
      {review && review.error && <div className="ai-box warn"><span className="mono">AI analysis</span>{review.error}</div>}
      {review && review.text && (
        <div className="ai-box">
          <span className="mono">{review.mode === 'style' ? 'Style profile' : 'Decision review'} · {review.model}</span>
          <MarkdownLite text={review.text} />
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty">No positions yet. Your theses and exits will appear here as a diary.</div>
      ) : (
        <>
          <JournalSection title="Open" list={open} onOpen={onOpen} />
          <JournalSection title="Closed" list={closed} onOpen={onOpen} />
        </>
      )}
    </>
  );
}
function JournalSection({ title, list, onOpen }) {
  if (!list.length) return null;
  return (
    <div className="journal-section">
      <div className="divider-label">{title}</div>
      {list.map((r) => <JournalCard key={r.id} r={r} onOpen={onOpen} />)}
    </div>
  );
}
function JournalCard({ r, onOpen }) {
  const [showHist, setShowHist] = useState(false);
  const cur = r.currency || 'USD';
  return (
    <div className="journal-card clickable" onClick={() => onOpen && onOpen({ id: r.id, ticker: r.ticker, asset_type: r.asset_type })}>
      <div className="jc-head">
        <span className="ticker">{r.ticker}</span>
        {r.name && <span className="jc-name">{r.name}</span>}
        {r.sector && <span className="sector-tag">{r.sector}</span>}
        <span className={`jc-status ${r.is_open ? 'open' : 'closed'}`}>{r.is_open ? 'open' : 'closed'}</span>
        <span className="jc-pnl">
          {r.is_open
            ? (r.unrealized_pnl != null && <span className={pnlClass(r.unrealized_pnl)}>{fmtMoney(r.unrealized_pnl, cur)} unreal.</span>)
            : <span className={pnlClass(r.realized_pnl)}>{fmtMoney(r.realized_pnl, cur)} real.</span>}
        </span>
      </div>
      {r.thesis && <p className="jc-thesis">{r.thesis}</p>}
      <div className="jc-meta">
        {r.strategy && <span>{r.strategy}</span>}
        <span>Entry {r.entry_date || '—'} @ {fmtMoney(r.avg_cost, cur)}</span>
        {!r.is_open && <span>Exit {r.exit_date || r.last_sell_date || '—'} · {r.exit_reason || 'no reason logged'}</span>}
        {r.conviction != null && <span>Conviction {r.conviction}/5</span>}
        {r.time_horizon && <span>{r.time_horizon}</span>}
      </div>
      {!r.is_open && r.post_mortem && (
        <p className="jc-postmortem"><span className="mono">Post-mortem</span>{r.post_mortem}</p>
      )}
      {r.thesis_history && r.thesis_history.length > 1 && (
        <>
          <button className="link-btn" onClick={(e) => { e.stopPropagation(); setShowHist((s) => !s); }}>
            {showHist ? 'hide' : 'show'} thesis history ({r.thesis_history.length})
          </button>
          {showHist && (
            <div className="thesis-history">
              {[...r.thesis_history].reverse().map((th, i) => (
                <div className="thesis-entry" key={i}>
                  <div className="thesis-entry-meta"><span className="tx-date">{(th.logged_at || '').slice(0, 10)}</span></div>
                  <div className="thesis-entry-text">{th.thesis}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================ HEADER ============================
function Header({ summary, tab, setTab }) {
  const cash = summary?.cash_by_currency || {};
  const cashStr = Object.keys(cash).length
    ? Object.entries(cash).map(([c, v]) => `${v.toLocaleString()} ${c}`).join('  ·  ')
    : '—';

  const doExport = async () => {
    try {
      const r = await axios.get(`${API}/export`);
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `financier-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Export failed. Is the backend running?');
    }
  };

  const doImport = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    if (!window.confirm('Importing will REPLACE all current data with the backup. Continue?')) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dump = JSON.parse(reader.result);
        await axios.post(`${API}/import`, dump);
        alert('Backup restored. Reloading…');
        window.location.reload();
      } catch (err) {
        alert('Import failed: ' + (err.response?.data?.error || 'invalid file'));
      }
    };
    reader.readAsText(file);
  };

  return (
    <header className="app-header">
      <div className="header-top">
        <div className="logo"><span className="logo-mark" aria-hidden="true"></span>Financier<span className="app-version">v{APP_VERSION}</span></div>
        <div className="header-right">
          <div className="data-actions">
            <button className="data-btn" onClick={doExport} title="Download a JSON backup of all your data">Export</button>
            <label className="data-btn" title="Restore from a JSON backup (replaces current data)">
              Import
              <input type="file" accept="application/json,.json" onChange={doImport} style={{ display: 'none' }} />
            </label>
          </div>
          <nav className="nav">
            <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
            <button className={tab === 'investing' ? 'active' : ''} onClick={() => setTab('investing')}>Investing</button>
            <button className={tab === 'banking' ? 'active' : ''} onClick={() => setTab('banking')}>Banking</button>
            <button className={tab === 'journal' ? 'active' : ''} onClick={() => setTab('journal')}>Journal</button>
          </nav>
        </div>
      </div>
      <div className="summary-strip">
        <SummaryItem label="Equity" value={fmtMoney(summary?.equity)} />
        <SummaryItem label="Cost Basis" value={fmtMoney(summary?.cost_basis)} />
        <SummaryItem label="Cash" value={cashStr} />
        <SummaryItem label="Positions" value={summary?.position_count ?? '—'} />
        <SummaryItem
          label="Overall P&L"
          value={summary ? `${fmtMoney(summary.pnl)} (${fmtPct(summary.pnl_pct)})` : '—'}
          cls={pnlClass(summary?.pnl)}
        />
      </div>
    </header>
  );
}
function SummaryItem({ label, value, cls = '' }) {
  return (
    <div className="summary-item">
      <span className="mono">{label}</span>
      <span className={`value ${cls}`}>{value}</span>
    </div>
  );
}

// ============================ PORTFOLIO (Investing → Stocks) ============================
function Portfolio({ holdings, loading, pnlMode, onTogglePnl, onAdd, onMemo, onTx, onDelete, onSynced }) {
  const pnlHeader = pnlMode === 'money' ? 'P&L $' : 'P&L %';
  const [invSub, setInvSub] = useState('stocks'); // stocks | bonds
  const [showIbkr, setShowIbkr] = useState(false);
  const [showT212, setShowT212] = useState(false);
  const [sortKey, setSortKey] = useState('ticker');
  const [sortDir, setSortDir] = useState('asc');
  const [typeFilter, setTypeFilter] = useState('all'); // all | stock | etf
  const [sectorFilter, setSectorFilter] = useState('all');

  const sectors = ['all', ...Array.from(new Set(holdings.map((h) => h.sector).filter(Boolean)))];

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const arrow = (key) => sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const filtered = holdings
    .filter((h) => typeFilter === 'all' || h.asset_type === typeFilter)
    .filter((h) => sectorFilter === 'all' || h.sector === sectorFilter);
  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    let av, bv;
    switch (sortKey) {
      case 'ticker': av = a.ticker; bv = b.ticker; break;
      case 'type': av = a.asset_type; bv = b.asset_type; break;
      case 'sector': av = a.sector || ''; bv = b.sector || ''; break;
      case 'shares': av = a.total_shares; bv = b.total_shares; break;
      case 'avg_cost': av = a.avg_cost; bv = b.avg_cost; break;
      case 'price': av = a.current_price ?? -Infinity; bv = b.current_price ?? -Infinity; break;
      case 'value': av = a.market_value ?? -Infinity; bv = b.market_value ?? -Infinity; break;
      case 'pnl': av = (pnlMode === 'money' ? a.pnl : a.pnl_pct) ?? -Infinity; bv = (pnlMode === 'money' ? b.pnl : b.pnl_pct) ?? -Infinity; break;
      default: av = a.ticker; bv = b.ticker;
    }
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  return (
    <>
      <div className="section-head">
        <div className="section-titles">
          <h2>Investing</h2>
          <div className="subnav">
            <button className={`subnav-item ${invSub === 'stocks' ? 'active' : ''}`} onClick={() => setInvSub('stocks')}>Stocks &amp; funds</button>
            <button className={`subnav-item ${invSub === 'bonds' ? 'active' : ''}`} onClick={() => setInvSub('bonds')}>Bonds</button>
            <button className="subnav-item soon" disabled>Crypto</button>
            <button className="subnav-item soon" disabled>Polymarket</button>
          </div>
        </div>
        {invSub === 'stocks' && (
          <div className="head-actions">
            <button className="csv-btn" onClick={() => setShowIbkr(true)}>Import from IBKR</button>
            <button className="csv-btn" onClick={() => setShowT212(true)}>Import from Trading212</button>
            <button className="btn-primary" onClick={onAdd}>+ Add stock position</button>
          </div>
        )}
      </div>

      {invSub === 'bonds' ? <BondsView /> : (
      <>
      {!loading && holdings.length > 0 && (
        <div className="filter-bar">
          <label className="mono">Type</label>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="stock">Stock</option>
            <option value="etf">ETF</option>
          </select>
          <label className="mono">Sector</label>
          <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}>
            {sectors.map((s) => <option key={s} value={s}>{s === 'all' ? 'All' : s}</option>)}
          </select>
          <span className="filter-count">{sorted.length} of {holdings.length}</span>
          <button className="csv-btn" onClick={() => exportCsv('financier-stocks', [
            ['Ticker', (h) => h.ticker],
            ['Type', (h) => h.asset_type === 'etf' ? 'ETF' : 'Stock'],
            ['Sector', (h) => h.sector || ''],
            ['Shares', (h) => h.total_shares],
            ['Avg Cost', (h) => h.avg_cost],
            ['Price', (h) => h.current_price],
            ['Currency', (h) => h.quote_currency || h.currency],
            ['Value', (h) => h.market_value],
            ['P&L', (h) => h.pnl],
            ['P&L %', (h) => h.pnl_pct],
            ['Target', (h) => h.target_price],
            ['Stop', (h) => h.stop_loss],
            ['Thesis', (h) => h.thesis],
          ], sorted)}>Export CSV</button>
        </div>
      )}

      {loading ? (
        <div className="loading">Loading positions…</div>
      ) : holdings.length === 0 ? (
        <div className="empty">No open positions. Add your first to get started.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left sortable" onClick={() => toggleSort('ticker')}>Ticker{arrow('ticker')}</th>
                <th className="left sortable" onClick={() => toggleSort('type')}>Type{arrow('type')}</th>
                <th className="left sortable" onClick={() => toggleSort('sector')}>Sector{arrow('sector')}</th>
                <th className="sortable" onClick={() => toggleSort('shares')}>Shares{arrow('shares')}</th>
                <th className="sortable" onClick={() => toggleSort('avg_cost')}>Avg Cost{arrow('avg_cost')}</th>
                <th className="sortable" onClick={() => toggleSort('price')}>Price{arrow('price')}</th>
                <th className="sortable" onClick={() => toggleSort('value')}>Value{arrow('value')}</th>
                <th className="sortable" onClick={() => toggleSort('pnl')}>
                  <span className="pnl-toggle-wrap" onClick={(e) => { e.stopPropagation(); onTogglePnl(); }}>
                    {pnlHeader} <span className="pnl-switch">{pnlMode === 'money' ? '$/%' : '%/$'}</span>
                  </span>{arrow('pnl')}
                </th>
                <th>Target</th>
                <th>Stop</th>
                <th className="left">Thesis</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((h) => (
                <tr key={h.id}>
                  <td className="left"><span className="ticker">{h.ticker}</span></td>
                  <td className="left"><span className={`type-badge ${h.asset_type}`}>{h.asset_type === 'etf' ? 'ETF' : 'Stock'}</span></td>
                  <td className="left"><span className="sector-tag">{h.sector || '—'}</span></td>
                  <td className="num">{fmtNum(h.total_shares, h.total_shares % 1 === 0 ? 0 : 2)}</td>
                  <td className="num">{fmtMoney(h.avg_cost)}</td>
                  <td className="num">{fmtMoney(h.current_price)}</td>
                  <td className="num">{fmtMoney(h.market_value)}</td>
                  <td className={`num ${pnlClass(pnlMode === 'money' ? h.pnl : h.pnl_pct)}`}>
                    {pnlMode === 'money' ? fmtMoney(h.pnl) : fmtPct(h.pnl_pct)}
                  </td>
                  <td>{h.target_price != null
                    ? <span className="target-val">{fmtMoney(h.target_price)}</span>
                    : <span className="unset">—</span>}</td>
                  <td>{h.stop_loss != null
                    ? <span className="stop-val">{fmtMoney(h.stop_loss)}</span>
                    : <span className="unset">—</span>}</td>
                  <td className="left thesis-cell" title={h.thesis || ''}>{h.thesis || '—'}</td>
                  <td className="row-actions">
                    <button className="action-btn" onClick={() => onMemo(h)}>Memo</button>
                    <button className="link-btn" onClick={() => onTx(h)}>transactions →</button>
                    <button className="del" onClick={() => onDelete(h.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
      {showIbkr && <IbkrModal onClose={() => setShowIbkr(false)} onSynced={() => { setShowIbkr(false); onSynced(); }} />}
      {showT212 && <T212Modal onClose={() => setShowT212(false)} onSynced={() => { setShowT212(false); onSynced(); }} />}
    </>
  );
}

// ============================ IBKR IMPORT ============================
function IbkrModal({ onClose, onSynced }) {
  // Remember the Flex token + Query ID locally — this is a private single-user app on
  // your own machine, so there's no need to re-type them every import.
  const [token, setToken] = useState(() => localStorage.getItem('financier.ibkr.token') || '');
  const [queryId, setQueryId] = useState(() => localStorage.getItem('financier.ibkr.queryId') || '');
  // Saved credential profiles, one per IBKR account (so several accounts are a dropdown).
  const [accounts, setAccounts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('financier.ibkr.accounts') || '[]'); } catch { return []; }
  });
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]); // per-position { selected, ticker, thesis, ...p }
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  const [result, setResult] = useState(null);

  const doPreview = async () => {
    setErr(''); setWarn(''); setResult(null); setLoading(true);
    try {
      const r = await axios.post(`${API}/ibkr/preview`, { token: token.trim(), query_id: queryId.trim() }, { timeout: 60000 });
      // Persist the credentials once they've successfully fetched a statement.
      localStorage.setItem('financier.ibkr.token', token.trim());
      localStorage.setItem('financier.ibkr.queryId', queryId.trim());
      // Save/refresh this account in the saved-accounts list (labelled by IBKR account id).
      const acctId = r.data.account_id || `…${token.trim().slice(-4)}`;
      setAccounts((prev) => {
        const next = [...prev.filter((a) => a.id !== acctId), { id: acctId, token: token.trim(), queryId: queryId.trim() }];
        localStorage.setItem('financier.ibkr.accounts', JSON.stringify(next));
        return next;
      });
      // Seed editable rows. The Yahoo ticker defaults to the backend's exchange-based
      // guess, overridden by any correction you've made before (remembered per symbol).
      const map = JSON.parse(localStorage.getItem('financier.ibkr.map') || '{}');
      setRows(r.data.positions.map((p) => ({
        ...p,
        ticker: (map[p.symbol.toUpperCase()] || p.yahoo_symbol || p.symbol).toUpperCase(),
        thesis: '',
        selected: !!p.is_new,
      })));
      setPreview(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not reach IBKR. Check your token and query ID.');
    } finally { setLoading(false); }
  };

  const updateRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.selected);
  const newChosen = chosen.filter((r) => r.is_new);
  // New rows need a ticker + thesis; already-held rows are just a history rebuild.
  const canImport = chosen.length > 0 && newChosen.every((r) => r.ticker.trim() && r.thesis.trim());

  const doImport = async (skipVerify) => {
    setErr(''); setWarn('');
    // Remember any ticker corrections so the next import pre-fills them.
    const map = JSON.parse(localStorage.getItem('financier.ibkr.map') || '{}');
    newChosen.forEach((r) => { map[r.symbol.toUpperCase()] = r.ticker.trim().toUpperCase(); });
    localStorage.setItem('financier.ibkr.map', JSON.stringify(map));

    // Verify each NEW ticker resolves to a Yahoo price; warn (don't block) if some don't.
    if (!skipVerify) {
      setLoading(true);
      const bad = [];
      for (const r of newChosen) {
        try { await axios.get(`${API}/price/${encodeURIComponent(r.ticker.trim().toUpperCase())}`); }
        catch { bad.push(r.ticker.trim().toUpperCase()); }
      }
      setLoading(false);
      if (bad.length) {
        setWarn(`No Yahoo price for: ${bad.join(', ')}. Non-US listings need an exchange suffix (e.g. 2DG.MU, EQQQ.L). Fix the ticker, or import anyway.`);
        return;
      }
    }

    setLoading(true);
    try {
      const selections = chosen.map((r) => ({ symbol: r.symbol, ticker: r.ticker.trim().toUpperCase(), thesis: r.thesis.trim() }));
      const r = await axios.post(`${API}/ibkr/sync`, { token: token.trim(), query_id: queryId.trim(), selections }, { timeout: 60000 });
      setResult(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Import failed.');
    } finally { setLoading(false); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-ibkr" onClick={(e) => e.stopPropagation()}>
        <h3>Import from IBKR</h3>
        <p className="sub">Uses IBKR's Flex Web Service. Preview your positions, pick which to import, and write a one-line thesis for each. Nothing existing is overwritten.</p>

        {!result && (
          <>
            {accounts.length > 0 && (
              <div className="field">
                <label>Account</label>
                <select
                  value={accounts.find((a) => a.token === token && a.queryId === queryId)?.id || ''}
                  onChange={(e) => {
                    const a = accounts.find((x) => x.id === e.target.value);
                    if (a) { setToken(a.token); setQueryId(a.queryId); } else { setToken(''); setQueryId(''); }
                    setPreview(null); setRows([]); setErr(''); setWarn('');
                  }}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
                  <option value="">+ New account…</option>
                </select>
              </div>
            )}
            <div className="field">
              <label>Flex token</label>
              <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="from IBKR → Reports → Flex Web Service" />
            </div>
            <div className="field">
              <label>Query ID</label>
              <input value={queryId} onChange={(e) => setQueryId(e.target.value)} placeholder="the Activity Flex Query ID" />
            </div>
          </>
        )}

        {err && <div className="error-msg">{err}</div>}

        {preview && !result && (
          <div className="ibkr-preview">
            <div className="divider-label">{preview.count} positions · {rows.filter((r) => r.is_new).length} new · choose what to import</div>
            <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th className="left">IBKR</th>
                    <th className="left">Ticker (Yahoo)</th>
                    <th className="left">Thesis <span className="req-star">*</span></th>
                    <th>Qty</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.symbol} style={{ opacity: r.is_new || r.selected ? 1 : 0.55 }}>
                      <td>
                        <input type="checkbox" checked={r.selected}
                          onChange={(e) => updateRow(i, { selected: e.target.checked })} />
                      </td>
                      <td className="left">
                        <span className="ticker" style={{ fontSize: '0.82rem' }}>{r.symbol}</span>
                        {r.listing_exchange && <span className="acct-ref">{r.listing_exchange}</span>}
                      </td>
                      <td className="left">
                        {r.is_new ? (
                          <>
                            <input value={r.ticker} list={`sfx-${i}`}
                              onChange={(e) => updateRow(i, { ticker: e.target.value.toUpperCase() })} />
                            <datalist id={`sfx-${i}`}>
                              {YAHOO_SUFFIXES.map((s) => <option key={s} value={`${r.symbol.toUpperCase()}${s}`} />)}
                            </datalist>
                          </>
                        ) : <span className="muted-hint">{r.ticker}</span>}
                      </td>
                      <td className="left">
                        {r.is_new
                          ? <input value={r.thesis} placeholder="one line — required" disabled={!r.selected}
                              onChange={(e) => updateRow(i, { thesis: e.target.value })} />
                          : <span className="muted-hint">{r.selected ? 'rebuild trades' : 'held'}</span>}
                      </td>
                      <td className="num">{r.quantity}</td>
                      <td className="num">{r.cost_price != null ? r.cost_price : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="ov-note">Non-US tickers need a Yahoo suffix (e.g. 2DG.MU, EQQQ.L) — the guess comes from the IBKR listing exchange, and your fix is remembered. Tick an already-held position to rebuild its transaction history from IBKR trades.</p>
          </div>
        )}

        {result && (
          <div className="ibkr-result">
            <div className="divider-label">Done</div>
            <p>
              Added <strong>{result.added}</strong> position{result.added === 1 ? '' : 's'}
              {result.resynced ? `, rebuilt ${result.resynced} from trades` : ''}.
              {result.skipped?.length ? ` Skipped ${result.skipped.length}.` : ''}
            </p>
            {result.errors?.length > 0 && <p className="error-msg">{result.errors.join(' · ')}</p>}
            <p className="ov-note">Each buy/sell is built from your IBKR trade history. Shares bought before the query window show as one "opening" entry at average cost.</p>
          </div>
        )}

        {warn && (
          <div className="warn-msg">
            <p>{warn}</p>
            <div className="warn-actions">
              <button className="btn-ghost" onClick={() => setWarn('')}>Go back &amp; fix</button>
              <button className="btn-warn" onClick={() => doImport(true)} disabled={loading}>Import anyway</button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          {!result && <button className="btn-ghost" onClick={onClose}>Cancel</button>}
          {!preview && !result && <button className="btn-primary" onClick={doPreview} disabled={loading || !token.trim() || !queryId.trim()}>{loading ? 'Fetching…' : 'Preview'}</button>}
          {preview && !result && <button className="btn-primary" onClick={() => doImport(false)} disabled={loading || !canImport}>{loading ? 'Working…' : `Import ${chosen.length} selected`}</button>}
          {result && <button className="btn-primary" onClick={onSynced}>Done</button>}
        </div>
      </div>
    </div>
  );
}

// ============================ TRADING212 IMPORT ============================
function T212Modal({ onClose, onSynced }) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('financier.t212.apiKey') || '');
  const [env, setEnv] = useState(() => localStorage.getItem('financier.t212.env') || 'live');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  const [result, setResult] = useState(null);

  const doPreview = async () => {
    setErr(''); setWarn(''); setResult(null); setLoading(true);
    try {
      const r = await axios.post(`${API}/t212/preview`, { api_key: apiKey.trim(), environment: env }, { timeout: 60000 });
      localStorage.setItem('financier.t212.apiKey', apiKey.trim());
      localStorage.setItem('financier.t212.env', env);
      const map = JSON.parse(localStorage.getItem('financier.t212.map') || '{}');
      setRows(r.data.positions.map((p) => ({
        ...p,
        ticker: (map[p.symbol.toUpperCase()] || p.yahoo_symbol || p.symbol).toUpperCase(),
        thesis: '',
        selected: !!p.is_new,
      })));
      setPreview(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not reach Trading212. Check your API key and account type.');
    } finally { setLoading(false); }
  };

  const updateRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.selected);
  const newChosen = chosen.filter((r) => r.is_new);
  const canImport = chosen.length > 0 && newChosen.every((r) => r.ticker.trim() && r.thesis.trim());

  const doImport = async (skipVerify) => {
    setErr(''); setWarn('');
    const map = JSON.parse(localStorage.getItem('financier.t212.map') || '{}');
    newChosen.forEach((r) => { map[r.symbol.toUpperCase()] = r.ticker.trim().toUpperCase(); });
    localStorage.setItem('financier.t212.map', JSON.stringify(map));

    if (!skipVerify) {
      setLoading(true);
      const bad = [];
      for (const r of newChosen) {
        try { await axios.get(`${API}/price/${encodeURIComponent(r.ticker.trim().toUpperCase())}`); }
        catch { bad.push(r.ticker.trim().toUpperCase()); }
      }
      setLoading(false);
      if (bad.length) {
        setWarn(`No Yahoo price for: ${bad.join(', ')}. Non-US listings need an exchange suffix (e.g. VUSA.L). Fix the ticker, or import anyway.`);
        return;
      }
    }

    setLoading(true);
    try {
      const selections = chosen.map((r) => ({ symbol: r.symbol, ticker: r.ticker.trim().toUpperCase(), thesis: r.thesis.trim() }));
      const r = await axios.post(`${API}/t212/sync`, { api_key: apiKey.trim(), environment: env, selections }, { timeout: 60000 });
      setResult(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Import failed.');
    } finally { setLoading(false); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-ibkr" onClick={(e) => e.stopPropagation()}>
        <h3>Import from Trading212</h3>
        <p className="sub">Uses your Trading212 API key (read-only). Preview your positions, pick which to import, and write a one-line thesis for each. Nothing existing is overwritten.</p>

        {!result && (
          <>
            <div className="field">
              <label>Account</label>
              <select value={env} onChange={(e) => { setEnv(e.target.value); setPreview(null); setRows([]); }}>
                <option value="live">Live (real money)</option>
                <option value="demo">Practice</option>
              </select>
            </div>
            <div className="field">
              <label>API key</label>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="from Trading212 → Settings → API (Beta)" />
            </div>
          </>
        )}

        {err && <div className="error-msg">{err}</div>}

        {preview && !result && (
          <div className="ibkr-preview">
            <div className="divider-label">{preview.count} positions · {rows.filter((r) => r.is_new).length} new · choose what to import</div>
            <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th className="left">T212</th>
                    <th className="left">Ticker (Yahoo)</th>
                    <th className="left">Thesis <span className="req-star">*</span></th>
                    <th>Qty</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.symbol} style={{ opacity: r.is_new || r.selected ? 1 : 0.55 }}>
                      <td>
                        <input type="checkbox" checked={r.selected}
                          onChange={(e) => updateRow(i, { selected: e.target.checked })} />
                      </td>
                      <td className="left">
                        <span className="ticker" style={{ fontSize: '0.82rem' }}>{r.symbol}</span>
                        {r.name && <span className="acct-ref">{r.name}</span>}
                      </td>
                      <td className="left">
                        {r.is_new ? (
                          <>
                            <input value={r.ticker} list={`t212sfx-${i}`}
                              onChange={(e) => updateRow(i, { ticker: e.target.value.toUpperCase() })} />
                            <datalist id={`t212sfx-${i}`}>
                              {YAHOO_SUFFIXES.map((s) => <option key={s} value={`${r.symbol.toUpperCase()}${s}`} />)}
                            </datalist>
                          </>
                        ) : <span className="muted-hint">{r.ticker}</span>}
                      </td>
                      <td className="left">
                        {r.is_new
                          ? <input value={r.thesis} placeholder="one line — required" disabled={!r.selected}
                              onChange={(e) => updateRow(i, { thesis: e.target.value })} />
                          : <span className="muted-hint">{r.selected ? 'rebuild' : 'held'}</span>}
                      </td>
                      <td className="num">{r.quantity}</td>
                      <td className="num">{r.cost_price != null ? r.cost_price : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="ov-note">Non-US tickers need a Yahoo suffix (e.g. VUSA.L) — the guess comes from the position's currency, so correct it if needed and your fix is remembered. Tick an already-held position to rebuild it from Trading212.</p>
          </div>
        )}

        {result && (
          <div className="ibkr-result">
            <div className="divider-label">Done</div>
            <p>
              Added <strong>{result.added}</strong> position{result.added === 1 ? '' : 's'}
              {result.resynced ? `, rebuilt ${result.resynced}` : ''}.
              {result.skipped?.length ? ` Skipped ${result.skipped.length}.` : ''}
            </p>
            {result.errors?.length > 0 && <p className="error-msg">{result.errors.join(' · ')}</p>}
            <p className="ov-note">Imported at Trading212's average cost as a single buy. (Per-trade history from Trading212 can come later.)</p>
          </div>
        )}

        {warn && (
          <div className="warn-msg">
            <p>{warn}</p>
            <div className="warn-actions">
              <button className="btn-ghost" onClick={() => setWarn('')}>Go back &amp; fix</button>
              <button className="btn-warn" onClick={() => doImport(true)} disabled={loading}>Import anyway</button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          {!result && <button className="btn-ghost" onClick={onClose}>Cancel</button>}
          {!preview && !result && <button className="btn-primary" onClick={doPreview} disabled={loading || !apiKey.trim()}>{loading ? 'Fetching…' : 'Preview'}</button>}
          {preview && !result && <button className="btn-primary" onClick={() => doImport(false)} disabled={loading || !canImport}>{loading ? 'Working…' : `Import ${chosen.length} selected`}</button>}
          {result && <button className="btn-primary" onClick={onSynced}>Done</button>}
        </div>
      </div>
    </div>
  );
}

// ============================ BONDS (Investing → Bonds) ============================
const BOND_TYPES = [
  { value: 'gilt', label: 'Gilt (UK govt)' },
  { value: 'treasury', label: 'Treasury (US govt)' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'other', label: 'Other' },
];
const FREQUENCIES = [{ value: 1, label: 'Annual' }, { value: 2, label: 'Semi-annual' }, { value: 4, label: 'Quarterly' }];

function BondsView() {
  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async (isRefresh) => {
    if (!isRefresh) setLoading(true);
    try { const r = await axios.get(`${API}/bonds`); setBonds(r.data); }
    catch { setBonds([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const del = async (id) => {
    if (!window.confirm('Delete this bond?')) return;
    await axios.delete(`${API}/bonds/${id}`);
    load(true);
  };

  const cur = (c) => ({ GBP: '£', USD: '$', CNY: '¥', EUR: '€' }[c] || '');
  const money = (n, c) => n == null ? '—' : `${cur(c)}${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <>
      <div className="bonds-actionbar">
        {bonds.length > 0 && (
          <button className="csv-btn" onClick={() => exportCsv('financier-bonds', [
            ['Name', (b) => b.name],
            ['Issuer', (b) => b.issuer || ''],
            ['Type', (b) => b.bond_type || ''],
            ['Currency', (b) => b.currency],
            ['Face Value', (b) => b.face_value],
            ['Quantity', (b) => b.quantity],
            ['Coupon %', (b) => b.coupon_rate],
            ['Frequency/yr', (b) => b.frequency],
            ['Buy Price', (b) => b.purchase_price],
            ['Cost', (b) => b.total_cost],
            ['Annual Income', (b) => b.annual_income],
            ['Current Yield %', (b) => b.current_yield],
            ['HTM Return %', (b) => b.htm_total_return_pct],
            ['Years to Maturity', (b) => b.years_to_maturity],
            ['Maturity', (b) => b.maturity_date],
          ], bonds)}>Export CSV</button>
        )}
        <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add bond</button>
      </div>

      {loading ? (
        <div className="loading">Loading bonds…</div>
      ) : bonds.length === 0 ? (
        <div className="empty">No bonds yet. Add a gilt, treasury, or corporate bond you hold.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left">Bond</th>
                <th className="left">Type</th>
                <th>Coupon</th>
                <th>Qty</th>
                <th>Buy price</th>
                <th>Cost</th>
                <th>Annual income</th>
                <th title="Annual coupon ÷ current price">Curr. yield</th>
                <th title="Total return if held to maturity: remaining coupons + redemption gain/loss, as % of cost">HTM return</th>
                <th>Matures</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bonds.map((b) => (
                <tr key={b.id}>
                  <td className="left"><span className="ticker" style={{ fontSize: '0.9rem' }}>{b.name}</span>{b.issuer && <span className="acct-ref">{b.issuer}</span>}</td>
                  <td className="left"><span className="sector-tag">{(BOND_TYPES.find((t) => t.value === b.bond_type) || {}).label || b.bond_type || '—'}</span></td>
                  <td className="num">{b.coupon_rate}%</td>
                  <td className="num">{fmtNum(b.quantity, b.quantity % 1 === 0 ? 0 : 2)}</td>
                  <td className="num">{money(b.purchase_price, b.currency)}</td>
                  <td className="num">{money(b.total_cost, b.currency)}</td>
                  <td className="num">{money(b.annual_income, b.currency)}</td>
                  <td className="num">{b.current_yield != null ? `${b.current_yield}%` : '—'}</td>
                  <td className={`num ${b.htm_total_return_pct != null ? pnlClass(b.htm_total_return_pct) : ''}`}>
                    {b.htm_total_return_pct != null ? `${b.htm_total_return_pct}%` : '—'}
                    {b.years_to_maturity != null && b.years_to_maturity > 0 && <span className="saver-note"> /{b.years_to_maturity}y</span>}
                  </td>
                  <td className="num">{b.maturity_date}</td>
                  <td className="row-actions">
                    <button className="edit-btn" onClick={() => setEditing(b)} title="Edit">✎</button>
                    <button className="del" onClick={() => del(b.id)} title="Delete">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <BondModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(true); }} />}
      {editing && <BondModal existing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(true); }} />}
    </>
  );
}

function BondModal({ existing, onClose, onSaved }) {
  const isEdit = !!existing;
  const [f, setF] = useState(existing ? {
    name: existing.name || '', issuer: existing.issuer || '', bond_type: existing.bond_type || 'gilt',
    currency: existing.currency || 'GBP', face_value: existing.face_value ?? 100, quantity: existing.quantity ?? '',
    coupon_rate: existing.coupon_rate ?? '', frequency: existing.frequency ?? 2,
    purchase_price: existing.purchase_price ?? '', purchase_date: existing.purchase_date || new Date().toISOString().slice(0, 10),
    maturity_date: existing.maturity_date || '', current_price: existing.current_price ?? '', notes: existing.notes || '',
  } : {
    name: '', issuer: '', bond_type: 'gilt', currency: 'GBP', face_value: 100, quantity: '',
    coupon_rate: '', frequency: 2, purchase_price: '', purchase_date: new Date().toISOString().slice(0, 10),
    maturity_date: '', current_price: '', notes: '',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setVal = (k) => (v) => setF({ ...f, [k]: v });

  const submit = async () => {
    setErr('');
    if (!f.name.trim()) { setErr('Enter a bond name.'); return; }
    if (f.coupon_rate === '' || f.purchase_price === '' || !f.maturity_date || f.face_value === '') {
      setErr('Face value, coupon, buy price and maturity are required.'); return;
    }
    const payload = {
      name: f.name.trim(), issuer: f.issuer.trim() || null, bond_type: f.bond_type,
      currency: f.currency,
      face_value: parseFloat(f.face_value),
      quantity: f.quantity === '' ? 1 : parseFloat(f.quantity),
      coupon_rate: parseFloat(f.coupon_rate),
      frequency: parseInt(f.frequency, 10),
      purchase_price: parseFloat(f.purchase_price),
      purchase_date: f.purchase_date || null,
      maturity_date: f.maturity_date,
      current_price: f.current_price === '' ? null : parseFloat(f.current_price),
      notes: f.notes.trim() || null,
    };
    try {
      if (isEdit) await axios.patch(`${API}/bonds/${existing.id}`, payload);
      else await axios.post(`${API}/bonds`, payload);
      onSaved();
    } catch (e) { setErr(e.response?.data?.error || 'Could not save bond.'); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? 'Edit bond' : 'Add bond'}</h3>
        <p className="sub">Coupon is the annual rate as a % of face value. Buy price is per bond (e.g. 96.50 for a £100 bond bought below par).</p>

        <div className="field-row">
          <div className="field">
            <label>Name</label>
            <input value={f.name} onChange={set('name')} placeholder="UK Treasury 4.25% 2032" autoFocus />
          </div>
          <div className="field">
            <label>Issuer</label>
            <input value={f.issuer} onChange={set('issuer')} placeholder="UK Government" />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Type</label>
            <select value={f.bond_type} onChange={set('bond_type')}>
              {BOND_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Currency</label>
            <SearchSelect value={f.currency} onChange={setVal('currency')} options={CURRENCIES} placeholder="Search currency…" />
          </div>
          <div className="field">
            <label>Coupon frequency</label>
            <select value={f.frequency} onChange={set('frequency')}>
              {FREQUENCIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </div>
        </div>

        <div className="divider-label">Terms</div>
        <div className="field-row">
          <div className="field">
            <label>Face value</label>
            <input type="number" step="0.01" value={f.face_value} onChange={set('face_value')} placeholder="100" />
          </div>
          <div className="field">
            <label>Coupon %</label>
            <input type="number" step="0.01" value={f.coupon_rate} onChange={set('coupon_rate')} placeholder="4.25" />
          </div>
          <div className="field">
            <label>Maturity</label>
            <input type="date" value={f.maturity_date} onChange={set('maturity_date')} />
          </div>
        </div>

        <div className="divider-label">Your position</div>
        <div className="field-row">
          <div className="field">
            <label>Quantity</label>
            <input type="number" step="any" value={f.quantity} onChange={set('quantity')} placeholder="100" />
          </div>
          <div className="field">
            <label>Buy price (per bond)</label>
            <input type="number" step="0.01" value={f.purchase_price} onChange={set('purchase_price')} placeholder="96.50" />
          </div>
          <div className="field">
            <label>Buy date</label>
            <input type="date" value={f.purchase_date} onChange={set('purchase_date')} />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>Current price <span className="muted-hint">(optional, manual)</span></label>
            <input type="number" step="0.01" value={f.current_price} onChange={set('current_price')} placeholder="leave blank if not tracking" />
          </div>
          <div className="field">
            <label>Notes</label>
            <input value={f.notes} onChange={set('notes')} />
          </div>
        </div>

        {err && <div className="error-msg">{err}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit}>{isEdit ? 'Save changes' : 'Add bond'}</button>
        </div>
      </div>
    </div>
  );
}

// ============================ ADD POSITION MODAL ============================
// Visual strategy picker: highlighted preset stickers + your remembered customs + a
// "type your own" option. `value` is the strategy you INTEND (stated); the AI review
// will later identify the strategy your behaviour actually reflects.
function StrategyPicker({ value, onChange, used = [] }) {
  const presetLabels = STRATEGY_PRESETS.map((p) => p.label);
  const customUsed = (used || []).filter((u) => u && !presetLabels.includes(u));
  const inputVal = (value && !presetLabels.includes(value) && !customUsed.includes(value)) ? value : '';
  const [customOpen, setCustomOpen] = useState(!!inputVal);
  return (
    <div className="strategy-picker">
      {STRATEGY_PRESETS.map((p) => (
        <button type="button" key={p.label} title={p.desc}
          className={`strategy-chip ${value === p.label ? 'active' : ''}`}
          onClick={() => { setCustomOpen(false); onChange(p.label); }}>
          <span className="sc-icon" aria-hidden="true">{p.icon}</span>
          <span className="sc-label">{p.label}</span>
          <span className="sc-desc">{p.desc}</span>
        </button>
      ))}
      {customUsed.map((u) => (
        <button type="button" key={u}
          className={`strategy-chip ${value === u ? 'active' : ''}`}
          onClick={() => { setCustomOpen(false); onChange(u); }}>
          <span className="sc-icon" aria-hidden="true">🏷️</span>
          <span className="sc-label">{u}</span>
          <span className="sc-desc">your custom strategy</span>
        </button>
      ))}
      <button type="button"
        className={`strategy-chip ${customOpen || inputVal ? 'active' : ''}`}
        onClick={() => setCustomOpen(true)}>
        <span className="sc-icon" aria-hidden="true">＋</span>
        <span className="sc-label">Custom</span>
        <span className="sc-desc">type your own</span>
      </button>
      {(customOpen || inputVal) && (
        <input className="strategy-custom-input" value={inputVal}
          onChange={(e) => onChange(e.target.value)} placeholder="Name your strategy" autoFocus />
      )}
    </div>
  );
}

function AddPositionModal({ onClose, onSaved }) {
  const [f, setF] = useState({
    ticker: '', name: '', asset_type: 'stock', currency: 'USD',
    date: new Date().toISOString().slice(0, 10), price: '', shares: '',
    thesis: '', sector: 'TMT', catalysts: '', target_price: '', stop_loss: '', conviction: '',
    time_horizon: '', tracks: '', expense_ratio: '', strategy: '',
  });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [matches, setMatches] = useState([]);
  const [activeField, setActiveField] = useState(null); // 'ticker' | 'name' | null
  const [verified, setVerified] = useState(false); // true once a search result is picked
  const [warn, setWarn] = useState(''); // unverified-ticker warning text
  const [usedStrategies, setUsedStrategies] = useState([]);
  useEffect(() => { axios.get(`${API}/strategies`).then((r) => setUsedStrategies(r.data || [])).catch(() => {}); }, []);
  // Editing the ticker by hand invalidates any prior verification.
  const set = (k) => (e) => {
    if (k === 'ticker') setVerified(false);
    setF({ ...f, [k]: e.target.value });
  };

  // Bidirectional lookup: typing in EITHER ticker or company searches the same
  // endpoint, and the dropdown appears under whichever field is active.
  // Yahoo's search matches "Apple" → AAPL and "AAPL" → Apple equally.
  const query = activeField === 'ticker' ? f.ticker : activeField === 'name' ? f.name : '';
  useEffect(() => {
    const q = query.trim();
    if (!activeField || q.length < 1) { setMatches([]); return; }
    const timer = setTimeout(async () => {
      try {
        const r = await axios.get(`${API}/search/${encodeURIComponent(q)}`);
        setMatches(r.data);
      } catch { setMatches([]); }
    }, 220);
    return () => clearTimeout(timer);
  }, [query, activeField]);

  const pickMatch = (m) => {
    // Picking a result fills BOTH fields plus the type, no matter which field was typed in.
    setF((prev) => ({ ...prev, ticker: m.symbol, name: m.name || '' }));
    setActiveField(null);
    setMatches([]);
    setVerified(true);
    setWarn('');
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const isEtf = f.asset_type === 'etf';
      const payload = {
        ticker: f.ticker.trim().toUpperCase(),
        name: f.name.trim() || null,
        asset_type: f.asset_type,
        currency: f.currency,
        date: f.date,
        price: parseFloat(f.price),
        shares: parseFloat(f.shares),
        thesis: f.thesis.trim(),
        sector: isEtf ? null : f.sector,
        catalysts: isEtf ? null : (f.catalysts.trim() || null),
        target_price: f.target_price === '' ? null : parseFloat(f.target_price),
        stop_loss: f.stop_loss === '' ? null : parseFloat(f.stop_loss),
        conviction: f.conviction === '' ? null : parseInt(f.conviction, 10),
        time_horizon: f.time_horizon || null,
        tracks: isEtf ? (f.tracks.trim() || null) : null,
        expense_ratio: isEtf && f.expense_ratio !== '' ? parseFloat(f.expense_ratio) : null,
        strategy: f.strategy.trim() || null,
      };
      await axios.post(`${API}/holdings`, payload);
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save position.');
      setSaving(false);
    }
  };

  const submit = async () => {
    setErr('');
    setWarn('');
    if (!f.ticker || !f.date || f.price === '' || f.shares === '') {
      setErr('Ticker, date, price and shares are required.');
      return;
    }
    if (!f.thesis.trim()) {
      setErr('A one-line thesis is required — note why you own this.');
      return;
    }
    // If the ticker wasn't picked from search, verify it resolves to a real
    // price on Yahoo before saving. If it doesn't, warn instead of saving.
    if (!verified) {
      setSaving(true);
      try {
        await axios.get(`${API}/price/${encodeURIComponent(f.ticker.trim().toUpperCase())}`);
        // Resolved fine — treat as verified and save.
        setSaving(false);
      } catch {
        setSaving(false);
        setWarn(`"${f.ticker.trim().toUpperCase()}" didn't return a price from Yahoo — it may be mistyped (for London listings try adding ".L", e.g. EQQQ.L). Save it anyway?`);
        return;
      }
    }
    doSave();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add {f.asset_type === 'etf' ? 'fund' : 'stock'} position</h3>
        <p className="sub">Creates the holding, its first buy, and a memo together.</p>

        <div className="type-switch">
          <button className={f.asset_type === 'stock' ? 'active' : ''} onClick={() => setF({ ...f, asset_type: 'stock' })}>Stock</button>
          <button className={f.asset_type === 'etf' ? 'active' : ''} onClick={() => setF({ ...f, asset_type: 'etf' })}>ETF / Fund</button>
        </div>

        <div className="field-row">
          <div className="field" style={{ position: 'relative' }}>
            <label>Ticker</label>
            <input
              value={f.ticker}
              onChange={(e) => { set('ticker')(e); setActiveField('ticker'); }}
              onFocus={() => setActiveField('ticker')}
              onBlur={() => setTimeout(() => setActiveField((a) => (a === 'ticker' ? null : a)), 150)}
              autoComplete="off"
              autoFocus
            />
            {activeField === 'ticker' && matches.length > 0 && (
              <ul className="autocomplete">
                {matches.map((m) => (
                  <li key={m.symbol} onMouseDown={() => pickMatch(m)}>
                    <span className="ac-symbol">{m.symbol}</span>
                    <span className="ac-name">{m.name}</span>
                    <span className="ac-meta">{m.type === 'etf' ? 'ETF' : m.exchange}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="field" style={{ position: 'relative' }}>
            <label>Company</label>
            <input
              value={f.name}
              onChange={(e) => { set('name')(e); setActiveField('name'); }}
              onFocus={() => setActiveField('name')}
              onBlur={() => setTimeout(() => setActiveField((a) => (a === 'name' ? null : a)), 150)}
              autoComplete="off"
            />
            {activeField === 'name' && matches.length > 0 && (
              <ul className="autocomplete">
                {matches.map((m) => (
                  <li key={m.symbol} onMouseDown={() => pickMatch(m)}>
                    <span className="ac-symbol">{m.symbol}</span>
                    <span className="ac-name">{m.name}</span>
                    <span className="ac-meta">{m.type === 'etf' ? 'ETF' : m.exchange}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Term</label>
            <select value={f.time_horizon} onChange={set('time_horizon')}>
              <option value="">—</option>
              {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Currency</label>
            <select value={f.currency} onChange={set('currency')}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {f.asset_type === 'etf' ? (
            <div className="field">
              <label>Tracks</label>
              <input value={f.tracks} onChange={set('tracks')} placeholder="S&P 500, MSCI World…" />
            </div>
          ) : (
            <div className="field">
              <label>Sector</label>
              <select value={f.sector} onChange={set('sector')}>
                {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="field">
          <label>Strategy <span className="muted-hint">(how you intend to play it)</span></label>
          <StrategyPicker value={f.strategy} onChange={(v) => setF({ ...f, strategy: v })} used={usedStrategies} />
        </div>

        <div className="divider-label">First buy</div>
        <div className="field-row">
          <div className="field">
            <label>Date</label>
            <input type="date" value={f.date} onChange={set('date')} />
          </div>
          <div className="field">
            <label>Price</label>
            <input type="number" step="0.01" value={f.price} onChange={set('price')} />
          </div>
          <div className="field">
            <label>Shares</label>
            <input type="number" step="any" value={f.shares} onChange={set('shares')} />
          </div>
        </div>

        <div className="divider-label">Thesis <span className="req">required</span></div>
        <div className="field">
          <label>Thesis — one line<span className="req-star">*</span></label>
          <textarea value={f.thesis} onChange={set('thesis')} placeholder="Why you own this, and what the market is missing" />
        </div>
        {f.asset_type === 'etf' ? (
          <div className="field">
            <label>Expense ratio %</label>
            <input type="number" step="0.01" value={f.expense_ratio} onChange={set('expense_ratio')} placeholder="0.07" />
          </div>
        ) : (
          <div className="field">
            <label>Catalysts</label>
            <textarea value={f.catalysts} onChange={set('catalysts')} />
          </div>
        )}
        <div className="field-row">
          <div className="field">
            <label>Target price</label>
            <input type="number" step="0.01" value={f.target_price} onChange={set('target_price')} />
          </div>
          <div className="field">
            <label>Stop loss</label>
            <input type="number" step="0.01" value={f.stop_loss} onChange={set('stop_loss')} />
          </div>
          {f.asset_type !== 'etf' && (
            <div className="field">
              <label>Conviction 1–5</label>
              <input type="number" min="1" max="5" value={f.conviction} onChange={set('conviction')} />
            </div>
          )}
        </div>

        {err && <div className="error-msg">{err}</div>}
        {warn && (
          <div className="warn-msg">
            <p>{warn}</p>
            <div className="warn-actions">
              <button className="btn-ghost" onClick={() => setWarn('')}>Go back &amp; fix</button>
              <button className="btn-warn" onClick={() => { setWarn(''); doSave(); }} disabled={saving}>Save anyway</button>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Checking…' : `Add ${f.asset_type === 'etf' ? 'fund' : 'stock'} position`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================ TRANSACTIONS DRAWER ============================
function TransactionsDrawer({ holding, onClose }) {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [tx, setTx] = useState({
    type: 'buy', date: new Date().toISOString().slice(0, 10), price: '', shares: '', notes: '',
  });
  const [err, setErr] = useState('');
  const [closing, setClosing] = useState(null);          // { date, price } when a sell zeroed the position
  const [exit, setExit] = useState({ reason: 'TakeProfit', note: '' });

  const load = useCallback(async () => {
    const r = await axios.get(`${API}/holdings/${holding.id}/transactions`);
    setData(r.data);
  }, [holding.id]);
  useEffect(() => { load(); }, [load]);

  const addTx = async () => {
    setErr('');
    if (tx.price === '' || tx.shares === '') { setErr('Price and shares are required.'); return; }
    try {
      const r = await axios.post(`${API}/holdings/${holding.id}/transactions`, {
        type: tx.type, date: tx.date,
        price: parseFloat(tx.price), shares: parseFloat(tx.shares),
        notes: tx.notes.trim() || null,
      });
      const justClosed = tx.type === 'sell' && r.data.is_open === 0;
      const sellInfo = { date: tx.date, price: tx.price };
      setAdding(false);
      setTx({ ...tx, price: '', shares: '', notes: '' });
      await load();
      if (justClosed) setClosing(sellInfo); // ask why the position was closed
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not add transaction.');
    }
  };

  const saveExit = async () => {
    try {
      await axios.patch(`${API}/holdings/${holding.id}/memo`, {
        exit_reason: exit.reason,
        exit_date: closing.date,
        exit_price: closing.price === '' ? null : parseFloat(closing.price),
        post_mortem: exit.note.trim() || null,
      });
    } catch { /* non-fatal — the sell is already recorded */ }
    setClosing(null);
    onClose();
  };

  const delTx = async (id) => {
    await axios.delete(`${API}/transactions/${id}`);
    load();
  };

  const set = (k) => (e) => setTx({ ...tx, [k]: e.target.value });

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <h3>{holding.ticker}</h3>
          <button className="btn-ghost" onClick={onClose}>close</button>
        </div>
        <span className="mono">Transactions</span>

        {data && (
          <div className="drawer-summary">
            <div>
              <span className="mono">Total shares</span>
              <div className="value">{fmtNum(data.total_shares, data.total_shares % 1 === 0 ? 0 : 2)}</div>
            </div>
            <div>
              <span className="mono">Weighted avg cost</span>
              <div className="value">{fmtMoney(data.avg_cost)}</div>
            </div>
          </div>
        )}

        {!adding && (
          <button className="btn-ghost" onClick={() => setAdding(true)} style={{ marginBottom: 12 }}>
            + add transaction
          </button>
        )}

        {adding && (
          <div className="modal" style={{ padding: 16, marginBottom: 14 }}>
            <div className="field-row">
              <div className="field">
                <label>Type</label>
                <select value={tx.type} onChange={set('type')}>
                  <option value="buy">buy</option>
                  <option value="sell">sell</option>
                </select>
              </div>
              <div className="field">
                <label>Date</label>
                <input type="date" value={tx.date} onChange={set('date')} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Price</label>
                <input type="number" step="0.01" value={tx.price} onChange={set('price')} />
              </div>
              <div className="field">
                <label>Shares</label>
                <input type="number" step="any" value={tx.shares} onChange={set('shares')} />
              </div>
            </div>
            <div className="field">
              <label>Notes</label>
              <input value={tx.notes} onChange={set('notes')} />
            </div>
            {err && <div className="error-msg">{err}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button>
              <button className="btn-primary" onClick={addTx}>Add</button>
            </div>
          </div>
        )}

        {closing && (
          <div className="modal" style={{ padding: 16, marginBottom: 14, borderColor: 'var(--brick)' }}>
            <div className="divider-label">Position closed — why did you sell?</div>
            <p className="sub" style={{ marginBottom: 14 }}>Recorded to your Journal so the rationale is kept.</p>
            <div className="field">
              <label>Exit reason</label>
              <select value={exit.reason} onChange={(e) => setExit({ ...exit, reason: e.target.value })}>
                {EXIT_REASONS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Post-mortem <span className="muted-hint">(what happened / what you learned)</span></label>
              <textarea value={exit.note} onChange={(e) => setExit({ ...exit, note: e.target.value })}
                placeholder="e.g. Sold AXT as it approached my average cost — thesis weakening." />
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => { setClosing(null); onClose(); }}>Skip</button>
              <button className="btn-primary" onClick={saveExit}>Save to journal</button>
            </div>
          </div>
        )}

        {data?.transactions.map((t) => (
          <div className="tx-row" key={t.id}>
            <span className={`tx-type ${t.type}`}>{t.type}</span>
            <span className="tx-date">{t.date}</span>
            <span className="tx-detail">
              {fmtNum(t.shares, t.shares % 1 === 0 ? 0 : 2)} @ {fmtMoney(t.price)}<br />
              <span className="mono">{fmtMoney(t.subtotal)}</span>
            </span>
            <button className="tx-del" onClick={() => delTx(t.id)}>✕</button>
          </div>
        ))}
      </aside>
    </>
  );
}

// ============================ MEMO PAGE ============================
function MemoPage({ holding, onBack }) {
  const [memo, setMemo] = useState(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [usedStrategies, setUsedStrategies] = useState([]);
  useEffect(() => { axios.get(`${API}/strategies`).then((r) => setUsedStrategies(r.data || [])).catch(() => {}); }, []);

  const loadHistory = useCallback(() => {
    axios.get(`${API}/holdings/${holding.id}/thesis-history`)
      .then((r) => setHistory(r.data))
      .catch(() => setHistory([]));
  }, [holding.id]);

  useEffect(() => {
    axios.get(`${API}/holdings/${holding.id}/memo`).then((r) => setMemo(r.data));
    loadHistory();
  }, [holding.id, loadHistory]);

  if (!memo) return <div className="loading">Loading memo…</div>;
  const set = (k) => (e) => setMemo({ ...memo, [k]: e.target.value });

  const save = async () => {
    setSaveErr('');
    if (!memo.thesis || !memo.thesis.trim()) {
      setSaveErr('A one-line thesis is required — it cannot be left blank.');
      return;
    }
    setSaving(true);
    const { id, holding_id, updated_at, ...fields } = memo;
    // normalise numerics: empty string -> null
    ['target_price', 'stop_loss', 'exit_price', 'position_size_pct', 'expense_ratio'].forEach((k) => {
      if (fields[k] === '') fields[k] = null; else if (fields[k] != null) fields[k] = parseFloat(fields[k]);
    });
    if (fields.conviction === '') fields.conviction = null;
    else if (fields.conviction != null) fields.conviction = parseInt(fields.conviction, 10);
    try {
      const r = await axios.patch(`${API}/holdings/${holding.id}/memo`, fields);
      setMemo(r.data);
      loadHistory(); // a thesis change appends a new history entry
    } catch (e) {
      setSaveErr(e.response?.data?.error || 'Could not save memo.');
    } finally {
      setSaving(false);
    }
  };

  const Field = ({ label, k, type = 'text', area, options, custom }) => (
    <div className="field">
      <label>{label}</label>
      {custom ? (
        <>
          <input list={`dl-${k}`} value={memo[k] ?? ''} onChange={set(k)} autoComplete="off" />
          <datalist id={`dl-${k}`}>{(options || []).map((o) => <option key={o} value={o} />)}</datalist>
        </>
      ) : options ? (
        <select value={memo[k] ?? ''} onChange={set(k)}>
          <option value="">—</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : area ? (
        <textarea value={memo[k] ?? ''} onChange={set(k)} />
      ) : (
        <input type={type} value={memo[k] ?? ''} onChange={set(k)} step={type === 'number' ? 'any' : undefined} />
      )}
    </div>
  );

  return (
    <div className="memo-page">
      <div className="memo-head">
        <button className="btn-ghost" onClick={onBack}>← back</button>
        <h2>{holding.ticker} <span className="sector-tag">{memo.sector}</span></h2>
      </div>

      <div className="memo-phase">Entry</div>
      <Field label="Thesis (required)" k="thesis" area />
      <div className="thesis-history-bar">
        <button className="link-btn" onClick={() => setShowHistory((s) => !s)}>
          {showHistory ? 'hide thesis history' : `thesis history (${history.length})`}
        </button>
      </div>
      {showHistory && (
        <div className="thesis-history">
          {history.length === 0 ? (
            <p className="unset">No history yet.</p>
          ) : history.map((h, i) => (
            <div className="thesis-entry" key={h.id}>
              <div className="thesis-entry-meta">
                <span className="mono">{(h.logged_at || '').slice(0, 10)}</span>
                {i === 0 && <span className="thesis-current">current</span>}
              </div>
              <p className="thesis-entry-text">{h.thesis}</p>
            </div>
          ))}
        </div>
      )}
      {holding.asset_type === 'etf' ? (
        <>
          <Field label="Tracks" k="tracks" />
          <Field label="Expense ratio %" k="expense_ratio" type="number" />
        </>
      ) : (
        <>
          <Field label="Sector" k="sector" options={SECTORS} />
          <Field label="Catalysts" k="catalysts" area />
        </>
      )}
      <div className="field">
        <label>Strategy <span className="muted-hint">(what you intend — AI review will flag what your behaviour actually shows)</span></label>
        <StrategyPicker value={memo.strategy || ''} onChange={(v) => setMemo({ ...memo, strategy: v })} used={usedStrategies} />
      </div>
      <div className="field-row">
        <Field label="Target price" k="target_price" type="number" />
        <Field label="Stop loss" k="stop_loss" type="number" />
      </div>
      <div className="field-row">
        <Field label="Term" k="time_horizon" options={TERMS} />
        <Field label="Conviction 1–5" k="conviction" type="number" />
        <Field label="Position size %" k="position_size_pct" type="number" />
      </div>

      <div className="memo-phase">Context</div>
      <Field label="Macro context" k="macro_context" area />
      <Field label="Sector view" k="sector_view" area />
      <Field label="Risk factors" k="risk_factors" area />
      <Field label="Variant perception (your edge)" k="variant_perception" area />

      <div className="memo-phase">Review</div>
      <Field label="Thesis intact" k="thesis_intact" options={['Yes', 'Partially', 'No']} />
      <Field label="Catalyst status" k="catalyst_status" area />

      <div className="memo-phase">Exit</div>
      <div className="field-row">
        <Field label="Exit date" k="exit_date" type="date" />
        <Field label="Exit price" k="exit_price" type="number" />
        <Field label="Exit reason" k="exit_reason" options={EXIT_REASONS} />
      </div>
      <Field label="Post-mortem" k="post_mortem" area />

      {saveErr && <div className="error-msg">{saveErr}</div>}
      <div className="modal-actions">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save memo'}
        </button>
      </div>
    </div>
  );
}

// ============================ CASH TAB ============================
// ============================ BUDGET (Banking → Cash) ============================
const EXPENSE_CATEGORIES = ['Food', 'Transport', 'Shopping', 'Entertainment', 'Living', 'Other'];
const WALLETS = ['Monzo', 'Revolut', 'Starling', 'WeChat', 'Alipay', 'Cash', 'Other'];
const CAT_COLORS = { Food: '#c8431f', Transport: '#234e9c', Shopping: '#e8a32c', Entertainment: '#1d6e3a', Living: '#8b6020', Other: '#7a7268' };

function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function BudgetTab() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [budgetInput, setBudgetInput] = useState('');
  const [baseCur, setBaseCur] = useState('GBP');
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async (isRefresh) => {
    if (!isRefresh) setLoading(true);
    try {
      const r = await axios.get(`${API}/expenses?month=${month}`);
      setData(r.data);
      setBudgetInput(String(r.data.monthly_budget || ''));
      setBaseCur(r.data.base_currency || 'GBP');
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch) => {
    await axios.patch(`${API}/budget/settings`, patch);
    load(true);
  };
  const delExpense = async (id) => {
    await axios.delete(`${API}/expenses/${id}`);
    load(true);
  };

  const sym = (c) => ({ GBP: '£', USD: '$', CNY: '¥', EUR: '€', HKD: 'HK$', JPY: '¥' }[c] || (c + ' '));
  const fmtBase = (n) => n == null ? '—' : `${sym(baseCur)}${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  const budget = data?.monthly_budget || 0;
  const spent = data?.spent || 0;
  const remaining = data?.remaining ?? 0;
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const over = budget > 0 && spent > budget;

  // ---- Analysis data ----
  // Pie: category totals (already in base currency from backend).
  const pieData = (data?.category_totals || []).map((c) => ({ name: c.category, value: c.total }));

  // Burn-down: ideal line goes from budget → 0 across the month; actual = budget − cumulative spend.
  const [yy, mm] = month.split('-').map(Number);
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const spendByDay = {};
  (data?.expenses || []).forEach((e) => {
    if (e.base_amount == null) return;
    const d = Number(e.date.slice(8, 10));
    spendByDay[d] = (spendByDay[d] || 0) + e.base_amount;
  });
  const today = new Date();
  const isCurrentMonth = today.toISOString().slice(0, 7) === month;
  const todayDay = isCurrentMonth ? today.getDate() : daysInMonth;
  let cumulative = 0;
  const burnData = [];
  for (let d = 1; d <= daysInMonth; d++) {
    cumulative += (spendByDay[d] || 0);
    burnData.push({
      day: d,
      ideal: budget > 0 ? Math.round((budget - (budget * d) / daysInMonth) * 100) / 100 : 0,
      actual: d <= todayDay ? Math.round((budget - cumulative) * 100) / 100 : null,
    });
  }
  const hasBudget = budget > 0;

  return (
    <>
      <div className="budget-monthbar">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="month-picker" />
        <span className="budget-month">{monthLabel(month)}</span>
        <div style={{ flex: 1 }} />
        <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add expense</button>
      </div>

      <div className="budget-setbar">
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Monthly budget</label>
          <input
            type="number" step="1" value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            onBlur={() => saveSettings({ monthly_budget: budgetInput === '' ? 0 : parseFloat(budgetInput) })}
          />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Base currency</label>
          <SearchSelect value={baseCur} options={CURRENCIES} placeholder="Search currency…"
            onChange={(v) => { setBaseCur(v); saveSettings({ base_currency: v }); }} />
        </div>
      </div>

      {loading ? <div className="loading">Loading…</div> : (
        <>
          <div className="budget-overview">
            <div className="bo-stat"><span className="mono">Budget</span><span className="bo-val">{fmtBase(budget)}</span></div>
            <div className="bo-stat"><span className="mono">Spent</span><span className="bo-val">{fmtBase(spent)}</span></div>
            <div className="bo-stat"><span className="mono">Remaining</span><span className={`bo-val ${over ? 'neg' : 'pos'}`}>{fmtBase(remaining)}</span></div>
          </div>
          <div className="budget-bar-track">
            <div className={`budget-bar-fill ${over ? 'over' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          {over && <p className="ov-note" style={{ color: 'var(--negative)' }}>Over budget by {fmtBase(spent - budget)}.</p>}

          {data?.category_totals?.length > 0 && (
            <>
              <div className="divider-label">By category</div>
              <div className="cat-breakdown">
                {data.category_totals.map((c) => (
                  <div className="cat-row" key={c.category}>
                    <span className="cat-dot" style={{ background: CAT_COLORS[c.category] || '#7a7268' }} />
                    <span className="cat-name">{c.category}</span>
                    <span className="cat-bar-track">
                      <span className="cat-bar-fill" style={{ width: `${spent > 0 ? (c.total / spent) * 100 : 0}%`, background: CAT_COLORS[c.category] || '#7a7268' }} />
                    </span>
                    <span className="cat-val">{fmtBase(c.total)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="divider-label divider-with-action">
            <span>Expenses</span>
            {data?.expenses?.length > 0 && (
              <button className="csv-btn" onClick={() => exportCsv(`financier-expenses-${month}`, [
                ['Date', (e) => e.date],
                ['Category', (e) => e.category],
                ['Wallet', (e) => e.wallet || ''],
                ['Note', (e) => e.note || ''],
                ['Amount', (e) => e.amount],
                ['Currency', (e) => e.currency],
                [`In ${baseCur}`, (e) => e.base_amount],
              ], data.expenses)}>Export CSV</button>
            )}
          </div>
          {!data?.expenses?.length ? (
            <div className="empty">No expenses logged this month.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="left">Date</th>
                    <th className="left">Category</th>
                    <th className="left">Wallet</th>
                    <th className="left">Note</th>
                    <th>Amount</th>
                    <th>In {baseCur}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.expenses.map((e) => (
                    <tr key={e.id}>
                      <td className="left num">{e.date}</td>
                      <td className="left"><span className="cat-dot" style={{ background: CAT_COLORS[e.category] || '#7a7268', display: 'inline-block', marginRight: 6 }} />{e.category}</td>
                      <td className="left sector-tag">{e.wallet || '—'}</td>
                      <td className="left thesis-cell" title={e.note || ''}>{e.note || '—'}</td>
                      <td className="num">{sym(e.currency)}{e.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="num">{e.base_amount != null ? fmtBase(e.base_amount) : '—'}</td>
                      <td className="row-actions"><button className="del" onClick={() => delExpense(e.id)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data?.rates && Object.keys(data.rates).some((c) => c !== baseCur) && (
            <p className="ov-note">Converted at live rates: {Object.entries(data.rates).filter(([c]) => c !== baseCur).map(([c, r]) => `1 ${c} = ${r != null ? r.toFixed(4) : '?'} ${baseCur}`).join(' · ')}</p>
          )}

          <div className="divider-label">Overview &amp; analysis</div>
          <div className="overview-grid">
            <div className="ov-card">
              <span className="mono ov-card-label">Spending by category</span>
              {pieData.length === 0 ? (
                <div className="empty">Nothing spent yet this month.</div>
              ) : (
                <div className="pie-wrap">
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} innerRadius={50}>
                        {pieData.map((s) => <Cell key={s.name} fill={CAT_COLORS[s.name] || '#7a7268'} />)}
                      </Pie>
                      <Tooltip formatter={(v, n) => [fmtBase(v), n]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pie-legend">
                    {pieData.map((s) => (
                      <div className="legend-row" key={s.name}>
                        <span className="legend-dot" style={{ background: CAT_COLORS[s.name] || '#7a7268' }} />
                        <span className="legend-label">{s.name}</span>
                        <span className="legend-val">{fmtBase(s.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="ov-card">
              <span className="mono ov-card-label">Budget burn-down · {baseCur}</span>
              {!hasBudget ? (
                <div className="empty">Set a monthly budget to see the burn-down.</div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={burnData} margin={{ top: 10, right: 16, bottom: 0, left: 8 }}>
                      <CartesianGrid stroke="#d4cdc0" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="day" tick={{ fontSize: 11, fontFamily: 'DM Mono, monospace' }} stroke="#7a7268" minTickGap={20} />
                      <YAxis tick={{ fontSize: 11, fontFamily: 'DM Mono, monospace' }} stroke="#7a7268" width={56} tickFormatter={(v) => `${sym(baseCur)}${v}`} />
                      <Tooltip formatter={(v, n) => [fmtBase(v), n === 'ideal' ? 'On-track' : 'Your balance']} labelFormatter={(d) => `Day ${d}`} labelStyle={{ fontFamily: 'DM Mono, monospace', fontSize: 12 }} />
                      <Line type="monotone" dataKey="ideal" stroke="#8a7f68" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                      <Line type="monotone" dataKey="actual" stroke={over ? '#a83030' : '#1d6e3a'} strokeWidth={2} dot={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                  <p className="ov-note">Dashed line = on-track pace (budget spread evenly). Solid line = your remaining balance. Above the dashed line means you're spending slower than budget; below means faster.</p>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {showAdd && <AddExpenseModal baseCur={baseCur} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(true); }} />}
    </>
  );
}

function AddExpenseModal({ baseCur, onClose, onSaved }) {
  const [f, setF] = useState({
    date: new Date().toISOString().slice(0, 10), amount: '', currency: baseCur,
    category: 'Food', wallet: 'Monzo', note: '',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async () => {
    setErr('');
    if (f.amount === '' || isNaN(parseFloat(f.amount))) { setErr('Enter an amount.'); return; }
    try {
      await axios.post(`${API}/expenses`, {
        date: f.date, amount: parseFloat(f.amount), currency: f.currency,
        category: f.category, wallet: f.wallet || null, note: f.note.trim() || null,
      });
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save expense.');
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add expense</h3>
        <div className="field-row">
          <div className="field">
            <label>Date</label>
            <input type="date" value={f.date} onChange={set('date')} autoFocus />
          </div>
          <div className="field">
            <label>Amount</label>
            <input type="number" step="0.01" value={f.amount} onChange={set('amount')} />
          </div>
          <div className="field">
            <label>Currency</label>
            <select value={f.currency} onChange={set('currency')}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>Category</label>
            <select value={f.category} onChange={set('category')}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Wallet</label>
            <select value={f.wallet} onChange={set('wallet')}>
              {WALLETS.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Note</label>
          <input value={f.note} onChange={set('note')} placeholder="e.g. lunch with friends" />
        </div>
        {err && <div className="error-msg">{err}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit}>Add expense</button>
        </div>
      </div>
    </div>
  );
}

// ============================ ACCOUNTS (Banking → Accounts) ============================
function CashTab() {
  const [sub, setSub] = useState('accounts'); // accounts | cash
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null); // account being edited
  const [sortKey, setSortKey] = useState('bank');
  const [sortDir, setSortDir] = useState('asc');
  const [catFilter, setCatFilter] = useState('all'); // all | current | savings
  const [curFilter, setCurFilter] = useState('all');

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const arrow = (key) => sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const sortRows = (rows) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const bal = (a) => (a.is_monthly_saver && a.accrued_balance != null ? a.accrued_balance : a.balance) ?? -Infinity;
    return [...rows].sort((a, b) => {
      let av, bv;
      switch (sortKey) {
        case 'bank': av = a.bank || ''; bv = b.bank || ''; break;
        case 'product': av = a.product || ''; bv = b.product || ''; break;
        case 'type': av = accountTypeLabel(a); bv = accountTypeLabel(b); break;
        case 'balance': av = bal(a); bv = bal(b); break;
        case 'rate': av = a.your_rate ?? -Infinity; bv = b.your_rate ?? -Infinity; break;
        case 'matures': av = a.maturity_date || ''; bv = b.maturity_date || ''; break;
        default: av = a.bank || ''; bv = b.bank || '';
      }
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  };
  const allRows = Object.values(grouped).flat();
  const currencies = ['all', ...Array.from(new Set(allRows.map((a) => a.currency)))];

  const load = useCallback(async (isRefresh) => {
    if (!isRefresh) setLoading(true);
    const r = await axios.get(`${API}/cash`);
    setGrouped(r.data);
    setLoading(false);
  }, []);
  useEffect(() => { if (sub === 'accounts') load(); }, [load, sub]);

  const del = async (id) => {
    if (!window.confirm('Delete this account?')) return;
    await axios.delete(`${API}/cash/${id}`);
    load(true);
  };

  return (
    <>
      <div className="section-head">
        <div className="section-titles">
          <h2>Banking</h2>
          <div className="subnav">
            <button className={`subnav-item ${sub === 'accounts' ? 'active' : ''}`} onClick={() => setSub('accounts')}>Accounts</button>
            <button className={`subnav-item ${sub === 'cash' ? 'active' : ''}`} onClick={() => setSub('cash')}>Cash</button>
          </div>
        </div>
        {sub === 'accounts' && <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add account</button>}
      </div>

      {sub === 'cash' ? <BudgetTab /> : (
      <>
      {!loading && Object.keys(grouped).length > 0 && (
        <div className="filter-bar">
          <label className="mono">Category</label>
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="current">Current</option>
            <option value="savings">Savings</option>
          </select>
          <label className="mono">Currency</label>
          <select value={curFilter} onChange={(e) => setCurFilter(e.target.value)}>
            {currencies.map((c) => <option key={c} value={c}>{c === 'all' ? 'All' : c}</option>)}
          </select>
          <button className="csv-btn" style={{ marginLeft: 'auto' }} onClick={() => exportCsv('financier-bank-accounts', [
            ['Bank', (a) => a.bank || a.account_name],
            ['Product', (a) => a.product || ''],
            ['Account Ref', (a) => a.account_ref || ''],
            ['Country', (a) => a.country],
            ['Currency', (a) => a.currency],
            ['Type', (a) => accountTypeLabel(a) + (a.is_monthly_saver ? ' · monthly' : '')],
            ['Balance', (a) => (a.is_monthly_saver && a.accrued_balance != null) ? a.accrued_balance : a.balance],
            ['Rate %', (a) => a.your_rate],
            ['Term', (a) => a.term || ''],
            ['Matures', (a) => a.maturity_date || ''],
            ['Updated', (a) => (a.last_updated || '').slice(0, 10)],
          ], allRows)}>Export CSV</button>
        </div>
      )}
      {loading ? (
        <div className="loading">Loading accounts…</div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="empty">No accounts yet. Add a bank, savings, or fixed-term account.</div>
      ) : (
        Object.keys(grouped).sort().map((country) => {
          const rows = sortRows(grouped[country]
            .filter((a) => catFilter === 'all' || a.category === catFilter)
            .filter((a) => curFilter === 'all' || a.currency === curFilter));
          if (rows.length === 0) return null;
          return (
          <div className="cash-group" key={country}>
            <h3>
              <span><span className="flag">{COUNTRY_FLAGS[country] || '🏦'}</span> {country}</span>
              <span className="region-total">{(() => {
                const sym = (c) => ({ GBP: '£', USD: '$', CNY: '¥', EUR: '€', HKD: 'HK$', JPY: '¥' }[c] || (c + ' '));
                const byCur = {};
                for (const a of rows) {
                  const v = (a.is_monthly_saver && a.accrued_balance != null) ? a.accrued_balance : a.balance;
                  byCur[a.currency] = (byCur[a.currency] || 0) + (v || 0);
                }
                return Object.entries(byCur)
                  .map(([c, t]) => `${sym(c)}${t.toLocaleString(undefined, { maximumFractionDigits: 0 })}`)
                  .join('  ·  ');
              })()}</span>
            </h3>
            <div className="table-wrap">
              <table className="accounts-table">
                <thead>
                  <tr>
                    <th className="left sortable" onClick={() => toggleSort('bank')}>Bank{arrow('bank')}</th>
                    <th className="left sortable" onClick={() => toggleSort('product')}>Product{arrow('product')}</th>
                    <th className="left sortable" onClick={() => toggleSort('type')}>Type{arrow('type')}</th>
                    <th className="sortable" onClick={() => toggleSort('balance')}>Balance{arrow('balance')}</th>
                    <th className="sortable" onClick={() => toggleSort('rate')}>Rate{arrow('rate')}</th>
                    <th>Term</th>
                    <th className="sortable" onClick={() => toggleSort('matures')}>Matures{arrow('matures')}</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td className="left">
                        {a.bank || a.account_name}
                        {a.account_ref && <span className="acct-ref">{a.account_ref}</span>}
                      </td>
                      <td className="left thesis-cell" title={a.product || ''}>{a.product || '—'}</td>
                      <td className="left"><span className="sector-tag">{accountTypeLabel(a)}{a.is_monthly_saver ? ' · monthly' : ''}</span></td>
                      <td className="num">
                        {a.is_monthly_saver && a.accrued_balance != null ? (
                          <span title={`${a.payments_made} × ${fmtMoney(a.monthly_amount, a.currency)} paid in`}>
                            {fmtMoney(a.accrued_balance, a.currency)}
                            <span className="saver-note"> ({a.payments_made}×)</span>
                          </span>
                        ) : fmtMoney(a.balance, a.currency)}
                      </td>
                      <td className="num">{a.your_rate != null ? `${a.your_rate}%` : '—'}</td>
                      <td className="num">{a.term || '—'}</td>
                      <td className="num">{a.maturity_date || '—'}</td>
                      <td className="num">{(a.last_updated || '').slice(0, 10)}</td>
                      <td className="row-actions">
                        <button className="edit-btn" onClick={() => setEditing(a)} title="Edit">✎</button>
                        <button className="del" onClick={() => del(a.id)} title="Delete">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          );
        })
      )}

      {showAdd && <AddCashModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(true); }} />}
      {editing && <AddCashModal existing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(true); }} />}
      </>
      )}
    </>
  );
}

function AddCashModal({ existing, onClose, onSaved }) {
  const isEdit = !!existing;
  const [f, setF] = useState(existing ? {
    bank: existing.bank || 'HSBC', product: existing.product || '', account_name: existing.account_name || '',
    country: existing.country || 'United Kingdom', currency: existing.currency || 'GBP',
    category: existing.category || 'current', access_type: existing.access_type || 'easy_access',
    is_isa: !!existing.is_isa, is_monthly_saver: !!existing.is_monthly_saver,
    monthly_amount: existing.monthly_amount ?? '', term: existing.term || '',
    account_ref: existing.account_ref || '',
    balance: existing.balance ?? '', your_rate: existing.your_rate ?? '',
    start_date: existing.start_date || new Date().toISOString().slice(0, 10),
    maturity_date: existing.maturity_date || '', notes: existing.notes || '',
  } : {
    bank: 'HSBC', product: '', account_name: '', country: 'United Kingdom', currency: 'GBP',
    category: 'current', access_type: 'easy_access', is_isa: false, is_monthly_saver: false,
    monthly_amount: '', term: '', balance: '', your_rate: '',
    account_ref: '',
    start_date: new Date().toISOString().slice(0, 10),
    maturity_date: '', notes: '',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setVal = (k) => (v) => setF({ ...f, [k]: v });

  // Term + start date auto-fill maturity. Only fixed-rate savings have a term.
  const isFixed = f.category === 'savings' && f.access_type === 'fixed';
  const isSavings = f.category === 'savings';
  const setTerm = (e) => {
    const term = e.target.value;
    const def = ACCOUNT_TERMS.find((t) => t.value === term);
    const maturity = def && def.months != null ? addMonths(f.start_date, def.months) : '';
    setF({ ...f, term, maturity_date: maturity });
  };
  const setStartDate = (e) => {
    const start_date = e.target.value;
    const def = ACCOUNT_TERMS.find((t) => t.value === f.term);
    const maturity = def && def.months != null ? addMonths(start_date, def.months) : f.maturity_date;
    setF({ ...f, start_date, maturity_date: maturity });
  };
  const setCategory = (e) => {
    const category = e.target.value;
    setF({ ...f, category, ...(category === 'current' ? { access_type: '', term: '', maturity_date: '', is_monthly_saver: false } : { access_type: 'easy_access' }) });
  };
  const setAccess = (e) => {
    const access_type = e.target.value;
    setF({ ...f, access_type, ...(access_type === 'easy_access' ? { term: '', maturity_date: '' } : {}) });
  };

  const submit = async () => {
    setErr('');
    const account_name = f.account_name.trim()
      || [f.bank, f.product.trim()].filter(Boolean).join(' — ')
      || f.bank;
    if (!account_name) { setErr('Pick a bank and product, or enter an account name.'); return; }
    const payload = {
      bank: f.bank,
      product: f.product.trim() || null,
      account_name,
      country: f.country,
      currency: f.currency,
      category: f.category,
      access_type: isSavings ? f.access_type : null,
      is_isa: f.is_isa ? 1 : 0,
      is_monthly_saver: isSavings && f.is_monthly_saver ? 1 : 0,
      monthly_amount: isSavings && f.is_monthly_saver && f.monthly_amount !== '' ? parseFloat(f.monthly_amount) : null,
      account_ref: f.account_ref.trim() || null,
      term: isFixed ? (f.term || null) : null,
      balance: f.balance === '' ? 0 : parseFloat(f.balance),
      your_rate: f.your_rate === '' ? null : parseFloat(f.your_rate),
      start_date: f.start_date || null,
      maturity_date: isFixed ? (f.maturity_date || null) : null,
      notes: f.notes.trim() || null,
    };
    try {
      if (isEdit) await axios.patch(`${API}/cash/${existing.id}`, payload);
      else await axios.post(`${API}/cash`, payload);
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save account.');
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? 'Edit account' : 'Add account'}</h3>
        <p className="sub">Pick the bank and product; maturity fills in from the term.</p>

        <div className="field-row">
          <div className="field">
            <label>Bank</label>
            <SearchSelect value={f.bank} onChange={setVal('bank')} options={BANKS} placeholder="Search or type bank…" allowCustom />
          </div>
          <div className="field">
            <label>Product</label>
            <input value={f.product} onChange={set('product')} placeholder="1-Year Fixed Rate Bond" />
          </div>
        </div>

        <div className="field">
          <label>Account ref <span className="muted-hint">(optional)</span></label>
          <input value={f.account_ref} onChange={set('account_ref')} placeholder="Sort code + account no, card number, IBAN…" />
        </div>

        <div className="field-row">
          <div className="field">
            <label>Country/Region</label>
            <SearchSelect value={f.country} onChange={setVal('country')} options={COUNTRIES} placeholder="Search country…" />
          </div>
          <div className="field">
            <label>Currency</label>
            <SearchSelect value={f.currency} onChange={setVal('currency')} options={CURRENCIES} placeholder="Search currency…" />
          </div>
        </div>

        <div className="divider-label">Account type</div>
        <div className="field-row">
          <div className="field">
            <label>Category</label>
            <select value={f.category} onChange={setCategory}>
              <option value="current">Current</option>
              <option value="savings">Savings</option>
            </select>
          </div>
          {isSavings && (
            <div className="field">
              <label>Access</label>
              <select value={f.access_type} onChange={setAccess}>
                {ACCESS_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label>Tax wrapper</label>
            <label className="checkbox-row">
              <input type="checkbox" checked={f.is_isa} onChange={(e) => setF({ ...f, is_isa: e.target.checked })} />
              <span>ISA (tax-free)</span>
            </label>
          </div>
        </div>

        {isSavings && (
          <div className="field-row">
            <div className="field">
              <label>Regular saver</label>
              <label className="checkbox-row">
                <input type="checkbox" checked={f.is_monthly_saver} onChange={(e) => setF({ ...f, is_monthly_saver: e.target.checked })} />
                <span>Pay in monthly</span>
              </label>
            </div>
            {f.is_monthly_saver && (
              <div className="field">
                <label>Monthly amount</label>
                <input type="number" step="0.01" value={f.monthly_amount} onChange={set('monthly_amount')} placeholder="400" />
              </div>
            )}
            {f.is_monthly_saver && (
              <div className="field">
                <label>First payment</label>
                <input type="date" value={f.start_date} onChange={set('start_date')} />
              </div>
            )}
          </div>
        )}

        <div className="divider-label">Rate{isFixed ? ' & term' : ''}</div>
        <div className="field-row">
          {isFixed && (
            <div className="field">
              <label>Term</label>
              <select value={f.term} onChange={setTerm}>
                {ACCOUNT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label>Rate %</label>
            <input type="number" step="0.01" value={f.your_rate} onChange={set('your_rate')} />
          </div>
          {!f.is_monthly_saver && (
            <div className="field">
              <label>Balance</label>
              <input type="number" step="0.01" value={f.balance} onChange={set('balance')} />
            </div>
          )}
        </div>

        {isFixed && (
          <div className="field-row">
            <div className="field">
              <label>Start date</label>
              <input type="date" value={f.start_date} onChange={setStartDate} />
            </div>
            <div className="field">
              <label>Maturity <span className="auto-tag">auto</span></label>
              <input
                type="date"
                value={f.maturity_date}
                onChange={set('maturity_date')}
                disabled={!!f.term}
                title="Calculated from start date + term"
              />
            </div>
          </div>
        )}

        {err && <div className="error-msg">{err}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit}>{isEdit ? 'Save changes' : 'Add account'}</button>
        </div>
      </div>
    </div>
  );
}
