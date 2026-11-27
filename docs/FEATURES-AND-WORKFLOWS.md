# Financier — 现有功能与 Workflow（v2.13.0 基线）

> 快照日期：2026-11-27。用途：重新开发前的「现状底稿」。内容以代码为准，不以旧文档为准。
> 版本状态：本文件随 v2.13.0 基线一起提交，对应 git tag `v2.13.0`。
> 历史记录见 [archive/DEVLOG-v2.0.0-v2.13.0.md](archive/DEVLOG-v2.0.0-v2.13.0.md)。

## 目录

1. [产品概览](#1-产品概览)
2. [页面功能](#2-页面功能)
3. [用户 Workflow](#3-用户-workflow)
4. [系统 Workflow（后台自动发生的事）](#4-系统-workflow后台自动发生的事)
5. [计算与业务规则](#5-计算与业务规则)
6. [数据模型](#6-数据模型)
7. [API 清单](#7-api-清单)
8. [技术架构、外部依赖、配置](#8-技术架构外部依赖配置)
9. [已知问题与缺口](#9-已知问题与缺口)
10. [重做前要定的事](#10-重做前要定的事)

---

## 1. 产品概览

Financier 是一个**本地优先、单用户**的个人理财与市场观察工具。数据存在自己机器的 SQLite 里，不上云。

两半性质不同：

| 半区 | 页面 | 数据怎么来 |
|---|---|---|
| **记账**（ledger） | Overview、Investing、Banking、Journal | 主要靠手填；价格和汇率自动 |
| **观察**（signals） | Signals | 全部自动抓取，零输入 |

现有代码体现的设计原则（重做时决定留不留）：

- 持仓数字（均价、盈亏、收益率）**从交易流水实时计算，从不存储**。
- 每个持仓**必须写一句 thesis**；thesis 改动保留历史。
- 券商导入**先预览、再勾选、再写入**。
- Ticker 查不到价格时**警告但不阻止**。
- 指标的局限直接写在界面上。
- 红绿色只表示真实盈亏；市场情绪用砖红 / 钴蓝。

### 手动 vs 自动

| 功能 | 手动输入 | 自动部分 |
|---|---|---|
| 股票 / ETF | 建仓、买卖、memo（或券商导入 + thesis） | 价格、盈亏 |
| 债券 | 全部，含当前价格 | 收益率等指标 |
| 银行账户 | 余额、利率、期限 | 到期日推算、regular saver 累计 |
| 预算支出 | 每一笔 | 汇率换算、图表 |
| Journal | 无（读持仓和 memo） | 汇总统计、AI 复盘（点击触发） |
| Signals | 无 | 全部 |

---

## 2. 页面功能

### 2.0 全局外壳

- **登录页**：只在设置了密码时出现。
- **顶部导航**：`Overview`（默认页）· `Signals` · `Investing` · `Banking` · `Journal`。
- **顶部按钮**：`Export`（下载 JSON 备份）、`Import`（用备份覆盖全部数据，有确认框）、`Lock`（登出）。
- **版本号**显示在 logo 旁。
- **汇总条**：Equity、Cost Basis、Overall P&L（都换算为 USD）、Cash（按币种分别列出，不换算）、Positions。
- 页面状态不进 URL，刷新回到 Overview。
- 手机宽度（≤640px）下表格横向滚动，导航和表单堆叠。

### 2.1 Overview

- 周期：`1D / WTD / MTD / 1M / 3M / YTD`。
- 指标切换：`Value`（组合市值）/ `Performance`（盈亏百分比，相对窗口第一天归零）。
- 净资产：基准货币可选 `GBP / USD / CNY / EUR`（默认 GBP，不保存），拆成 Investing 和 Bank accounts。
- 配置环形图：每只持仓一块，银行存款按币种一块。
- 走势图：按历史交易**回推**每一天的持股数 × 当日收盘价。历史短于所选周期时给出提示。
- 汇率拿不到时提示总额可能不完整。
- **不包含债券。**

### 2.2 Signals

顶部有 `Refresh` 按钮和「多久前更新」。子页：`Fear & greed`、`Risk`、`Rates`、`Macro`、`Venture map`。

#### Fear & greed

- 0–100 分数（0 极度恐慌，100 极度贪婪），附 30 天前、一年前对比。
- 分区：<20 Extreme fear，<40 Fear，<60 Neutral，<80 Greed，其余 Extreme greed。
- 「What is driving it」：各分量得分条和原始值。
- 历史曲线：`3M / 1Y / 3Y / ALL`。

| 分量 | 数据 | 方向（数值高 =） | 打分 |
|---|---|---|---|
| Equity volatility | VIX | 恐慌 | 过去 365 天百分位 |
| Vol term structure | VIX ÷ VIX3M | 恐慌 | 同上 |
| Credit spreads | 高收益债利差 | 恐慌 | 同上 |
| Financial stress | St. Louis Fed STLFSI4（周频） | 恐慌 | 同上 |
| Market momentum | S&P 500 对 125 日均线偏离 | 贪婪 | 同上 |
| Safe-haven demand | 20 日股票回报 − 估算债券回报 | 贪婪 | 同上 |
| Crypto risk appetite | alternative.me 指数 | 贪婪 | 直接用原值 |

合成规则：以有 VIX 数据的日期为轴；周频分量向前填充；窗口内观测少于 30 个的分量不参与；少于 4 个分量的日期不出分；其余简单平均。

#### Risk / Rates / Macro

每个指标一张卡：当前值、30 天变化、90 天 sparkline、一句解释、数据日期。点开看 `3M / 1Y / 3Y / ALL` 历史。

| 组 | key | 指标 | 来源（FRED series） |
|---|---|---|---|
| risk | vix | VIX | VIXCLS |
| risk | vix3m | VIX 3-month | VXVCLS |
| risk | vix_term | Vol term structure | 派生 |
| risk | vxn | Nasdaq vol | VXNCLS |
| risk | hy_oas | High-yield spread | BAMLH0A0HYM2 |
| risk | ig_oas | Investment-grade spread | BAMLC0A0CM |
| risk | stlfsi | Financial stress index | STLFSI4 |
| risk | nfci | Financial conditions | NFCI |
| risk | spx_momentum | Market momentum | 派生 |
| risk | safe_haven | Safe-haven demand | 派生 |
| risk | crypto_fng | Crypto Fear & Greed | alternative.me |
| rates | dgs3mo / dgs2 / dgs10 | 3M / 2Y / 10Y Treasury | DGS3MO / DGS2 / DGS10 |
| rates | t10y2y | 10y − 2y curve | T10Y2Y |
| rates | t10yie | 10y breakeven inflation | T10YIE |
| macro | sp500 / nasdaq | S&P 500 / Nasdaq | SP500 / NASDAQCOM |
| macro | dxy | Dollar index | DTWEXBGS |
| macro | wti | WTI crude | DCOILWTICO |
| macro | cpi_yoy | US CPI 同比 | 派生自 cpi_index |
| macro | cpi_index | US CPI 指数 | CPIAUCSL |
| macro | unrate | US 失业率 | UNRATE |
| macro | umcsent | 消费者信心 | UMCSENT |
| macro | recession_prob | 衰退概率 | RECPROUSM156N |
| macro | gbpusd / usdcny | 汇率 | DEXUSUK / DEXCHUS |

历史从 2015-01-01 起。两个利差序列 FRED 只给约 3 年。FRED 数据通常滞后几天。

#### Venture map

数据：YC 公开公司目录（yc-oss.github.io）。

- 顶部四个数：公司总数、最新 AI 占比、最新 batch 规模、非美占比。
- AI 占比折线（标签覆盖率低的 batch 画空心点）。
- 行业构成堆叠面积图（前 6 大行业 + Other，每个 batch 归一到 100%）。
- Batch 规模柱状图；非美占比折线。
- Cohort 表：公司数、AI、招聘中、非美、英国、被收购/上市、停业、平均团队人数。附「年龄偏差」警告：这些是今天的快照，不能跨 batch 当趋势读。
- 2025 年以来的细分赛道 Top 12；2024 年以来的国家 Top 10。

限制：只是一个加速器的样本，偏早期、偏美国、偏软件；不含融资额和估值。

### 2.3 Investing

子页：`Stocks & funds`、`Bonds`；`Crypto`、`Polymarket` 是禁用的占位按钮。

#### Stocks & funds

- 表格列：Ticker、Type、Sector、Shares、Avg Cost、Price、Value、P&L（`$` / `%` 切换）、Target、Stop、Thesis。
- 每行操作：`Memo`、`transactions →`、删除（有确认，级联删交易和 memo）。
- 筛选：类型、行业；列排序；`Export CSV`。
- 只显示**未清仓**持仓。
- Target / Stop 只是展示，**没有任何提醒**。

#### 新增持仓弹窗

- Stock / ETF 切换。
- Ticker 与 Company 双向自动补全（Yahoo 搜索）。
- 字段：Term（Short/Medium/Long）、Currency（默认 USD）、Sector（股票）或 Tracks（ETF）。
- Strategy 选择器：`Macro-dip ETF`、`Industry growth`、`Technical`、`Sentiment`、`Income`、`Other`，可自定义，用过的会记住。
- 首笔买入：日期、价格、股数。
- **Thesis 必填**；Catalysts（股票）或 Expense ratio（ETF）；Target、Stop、Conviction 1–5（股票）。
- Sector 选项：TMT、Healthcare、Energy、Consumer、Financials、Industrials、Other。

#### 交易抽屉

- 汇总：总股数、加权均价。
- 新增 buy / sell：日期、价格、股数、备注。
- 删除单笔（无确认）；**不能编辑**。
- 卖到 0 股时弹出「为什么卖」：Exit reason（TakeProfit / StopLoss / ThesisBroken / BetterOpp / Other）+ post-mortem，可跳过。

#### Memo 页

顶部是价格走势图（`1M / 3M / 6M / 1Y / ALL`，ALL = 从第一笔交易起），▲ 买点、▼ 卖点按成交价标出。

| 阶段 | 字段 |
|---|---|
| Entry | Thesis（必填，带历史）、Sector + Catalysts（股票）或 Tracks + Expense ratio（ETF）、Strategy、Target、Stop、Term、Conviction、Position size % |
| Context | Macro context、Sector view、Risk factors、Variant perception |
| Review | Thesis intact（Yes/Partially/No）、Catalyst status |
| Exit | Exit date、Exit price、Exit reason、Post-mortem |

手动点 `Save memo` 保存。

#### IBKR 导入

- 输入 Flex token 和 Query ID；成功后按账户 ID 保存，可多账户下拉切换。
- `Preview` 列出持仓：勾选框、IBKR 代码和交易所、Yahoo ticker（可改，带后缀建议，修改会记住）、thesis（新持仓必填）、数量、成本。
- 已持有的可勾选「重建交易历史」（保留 memo）。
- 导入前逐个验证 ticker 有价格。
- 按 Trades 逐笔还原；早于查询期的股数合成一笔「opening position」。
- Flex Query 要求：含 Open Positions 和 Trades（带 Trade Price），期间建议 Last 365 Calendar Days。

#### Trading212 导入

- 选 Live 或 Practice，输入只读 API key。
- 流程同上，但只按均价导入**一笔**买入（没有逐笔历史）。
- 记录中（2026-09-30）：尚未用真实账户跑通，等 T212 开通 API。

#### Bonds

- 录入：名称、发行人、类型（Gilt / Treasury / Corporate / Other）、币种、付息频率、面值、票息、到期日、数量、买入价、买入日、当前价（手动，可空）、备注。
- 表格：Coupon、Qty、Buy price、Cost、Annual income、Current yield、Hold-to-maturity return、Matures。
- 编辑、删除、CSV 导出。

### 2.4 Banking

#### Accounts

- 按国家分组（带国旗和各币种小计）。
- 列：Bank（附账号备注）、Product、Type、Balance、Rate、Term、Matures、Updated。
- 筛选类别和币种；排序；编辑、删除；CSV。
- 新增 / 编辑字段：
  - Bank（预置英、中、美等银行，可自定义）、Product、Account ref
  - Country、Currency
  - Category（Current / Savings）、Access（Easy-access / Fixed-rate）、ISA
  - Regular saver：每月金额、首次付款日
  - Term（固定利率：1/2/3/5 年，到期日自动算）、Rate、Balance、Start date

#### Cash（月预算）

- 选月份；设置月预算和基准货币（预算只有一个值，所有月份共用）。
- Budget / Spent / Remaining 和进度条，超支提示。
- 分类汇总条、分类环形图、预算 burn-down 图（理想线 vs 实际）。
- 记一笔：日期、金额、币种、分类（Food / Transport / Shopping / Entertainment / Living / Other）、钱包（Monzo / Revolut / Starling / WeChat / Alipay / Cash / Other）、备注。
- 支出可删除、**不能编辑**；CSV 导出。
- 记支出**不会**改变账户余额。

### 2.5 Journal

- 所有持仓（Open / Closed）的决策日记卡片：thesis、strategy、入场、出场、盈亏、conviction、term、post-mortem、thesis 历史。
- 点卡片进入该持仓的 Memo 页。
- `Review decisions (AI)`：对照理由和实际行为做复盘。
- `Style profile (AI)`：投资风格画像。
- `Copy data (JSON)` / `Download JSON`：导出 AI 看到的同一份结构化数据。
- `Set AI key`：Anthropic key 存在浏览器本地；也可用环境变量。模型写死为 `claude-opus-4-8`。
- AI 只在点击时调用，会把整份 journal 发给 Anthropic。

---

## 3. 用户 Workflow

### W1 启动

| 方式 | 步骤 | 数据库位置 | 登录 |
|---|---|---|---|
| 桌面 App | 打开 `Financier.app`（未签名，首次需右键 → Open） | `~/Library/Application Support/Financier/tracker.db` | 无 |
| 命令行 | `cd server && npm start` → `http://127.0.0.1:8000` | `~/asset-tracker/tracker.db` | 设了密码才有 |
| 手机访问 | Mac 和手机装 Tailscale → `npm run share` → 手机打开 Mac 的 tailnet 地址 | 同命令行 | 强制密码；Mac 需保持唤醒 |
| 开发模式 | 后端 `npm start` + `cd web && npm run dev` → `:5173` | 同命令行 | 同命令行 |

**注意：桌面版和命令行版是两个独立数据库。**

首次安装：`server/` 和 `web/` 各 `npm install`，`web/` 里 `npm run build`，复制 `server/.env.example` 为 `.env`。

### W2 登录 / 登出

打开页面 → 输密码 → 30 天内免登 → `Lock` 登出。连续输错 8 次锁 60 秒。会话过期时任意请求 401，自动回登录页。

### W3 手动建仓

`Investing` → `+ Add stock position` → 搜索 ticker → 填首笔买入 → 写 thesis → 保存（ticker 未经搜索选中且查不到价时先警告）→ 一次生成 holding、transaction、memo、thesis 历史。

### W4 券商导入

`Investing` → `Import from IBKR / Trading212` → 填凭证 → `Preview` → 勾选、改 ticker、写 thesis → `Import` → 结果页显示新增 / 重建数量 → `Done`。

### W5 加仓、卖出、清仓复盘

`transactions →` → `+ add transaction` → 均价和持股实时重算 → 若清仓，填 exit reason 和 post-mortem → 持仓从 Investing 列表消失，进入 Journal 的 Closed。

### W6 维护投资逻辑

`Memo` → 看价格图和自己的买卖点 → 更新字段（尤其 Review 阶段）→ `Save memo` → thesis 改动自动进历史 → `← back`。

### W7 决策复盘

`Journal` → 浏览卡片 →（首次）`Set AI key` → `Review decisions` 或 `Style profile` → 阅读；或 `Copy data (JSON)` 粘给任意 AI。

### W8 债券

`Investing` → `Bonds` → `+ Add bond` → 之后需手动更新当前价。

### W9 维护银行账户

`Banking` → `+ Add account` → 之后余额变化靠 `✎` 逐个手改。Regular saver 按月自动累计；固定利率账户自动算到期日。

### W10 记账

`Banking` → `Cash` → 设预算和基准货币 → `+ Add expense` 逐笔记 → 看进度和 burn-down。

### W11 看市场

`Signals` → 看总分和驱动分量 → 切子页 → 点指标看历史 → 需要最新数据时点 `Refresh`。

### W12 备份、恢复、清空

- 备份：`Export` → `financier-backup-YYYY-MM-DD.json`。
- 恢复：`Import` → 确认 → 全量覆盖 → 页面刷新。
- 清空：停服务 → `scripts/wipe-data.sh`（只清命令行版数据库，且不完整，见第 9 节）。

### W13 开发与发版

1. 改 `server/server.js`、`server/schema.sql`、`web/src/App.jsx`、`web/src/App.css`。
2. 新列加到 `migrate()` 的 `ensureColumn`；新表直接加进 `schema.sql`。
3. 前端改动后 `cd web && npm run build`，否则服务的是旧页面。
4. 桌面版：`cd desktop && npm run dist:mac`（脚本会先跑 `prepare.js` 复制 server 和 UI）。首次需 `npx electron-rebuild -f -w better-sqlite3`。
5. 版本号：`APP_VERSION`（App.jsx）和 `desktop/package.json`；写 devlog。版本规则：MAJOR 大改或破坏兼容，MINOR 新功能，PATCH 修 bug。
6. 提交并推到 GitHub（公开仓库）。`.db`、`.env`、备份 JSON 已被 gitignore。

---

## 4. 系统 Workflow（后台自动发生的事）

| 时机 | 行为 |
|---|---|
| 启动 | 执行 `schema.sql`（`CREATE IF NOT EXISTS`）→ 补缺失列 → 生成会话密钥（首次）→ 写入指标目录 |
| 启动 2 秒后 | 后台刷新过期的 Signals 数据 |
| 查价格 | 15 分钟缓存；抓取失败回退旧缓存（标记 stale） |
| 查汇率 | 1 小时缓存；失败回退旧缓存 |
| 打开 Signals | 空库：等首次抓取完成。有数据：立即返回，过期则后台刷新 |
| Signals 刷新 | FRED + 加密指数 TTL 12 小时（4 并发）→ 算派生序列 → 算合成指数；YC 目录 TTL 24 小时，整表替换（约 11 MB） |
| 部分源失败 | 其余照常入库；失败数过半则不记为成功，下次重试 |
| 对外请求 | 优先级：`IBKR_FLEX_PROXY` / `HTTPS_PROXY` → macOS 系统代理（缓存 30 秒）→ 直连 IPv4。用于中国大陆网络环境 |

---

## 5. 计算与业务规则

重做时这部分最值得原样保留，多数是踩过 bug 才定下来的。

**持仓（移动平均成本法）**
- 买入：`cost += price × shares`。
- 卖出：按当前均价扣减，剩余均价不变；`realized += (卖价 − 均价) × shares`。
- 按日期、再按 id 排序回放。股数 ≤ 0.0000001 视为清仓。
- 同一个函数驱动持仓表、抽屉、Journal、Overview 回推。

**券商导入的 opening price**
- 最终均价是开仓价 X 的线性函数：分别代入 X=0 和 X=1 回放，反解出 X。对任意买卖顺序精确。
- 开仓股数在期内被全部卖光时无解，退回近似值。

**币种**
- Yahoo 和 T212 的 GBp/GBX 一律 ÷100 转 GBP。
- 价格查询失败时 currency 返回 null（不能默认 USD）。

**Regular saver**
- 已付期数 = 月份差 + 1；本月扣款日未到则 −1；不超过期限月数。
- 账户价值 = 期数 × 月额，**替代**手填余额（不能相加）。只算本金，不算利息。

**债券**
- 年收入 = 票息% × 面值 × 数量。
- Current yield = 年收入 ÷（当前价或买入价 × 数量）。
- Yield on cost = 年收入 ÷ 总成本。
- HTM 总回报 = 年收入 × 剩余年数 +（面值 − 买入价）× 数量，占成本百分比（单利、未年化、忽略应计利息）。

**日期**
- 「今天」「本月」一律用本地日历日，不用 UTC。市场交易日时间戳例外。

**Journal 汇总（喂给 AI 的数字全部由代码算）**
- 按 strategy：持仓数、开/平、已实现盈亏、平均持有天数、胜率。
- 按 exit reason、按 conviction 分组；总已实现 / 未实现盈亏。

**Venture 的 AI 判定**
- tags 命中，**或**一句话简介 / 公司名命中（`AI`、LLM、machine learning、agentic、copilot 等）。
- 标签覆盖率 < 60% 的 batch 标为低可信。

---

## 6. 数据模型

| 表 | 内容 | 主要字段 | 进备份 |
|---|---|---|---|
| holdings | 持仓身份 | ticker（唯一）、name、asset_type、currency、is_open | ✓ |
| transactions | 交易流水 | holding_id、type、date、price、shares、notes | ✓ |
| memos | 投资逻辑（1:1） | thesis、sector、strategy、catalysts、target_price、stop_loss、time_horizon、conviction、position_size_pct、macro_context、sector_view、risk_factors、variant_perception、tracks、expense_ratio、thesis_intact、catalyst_status、exit_*、post_mortem | ✓ |
| thesis_history | thesis 版本 | holding_id、thesis、logged_at | ✓ |
| cash_accounts | 银行账户 | account_name、bank、product、country、currency、category、access_type、is_isa、is_monthly_saver、monthly_amount、account_ref、term、balance、your_rate、start_date、maturity_date、notes | ✓ |
| bonds | 债券 | 见 2.3 | ✓ |
| budget_settings | 单行 | monthly_budget、base_currency | ✓ |
| expenses | 支出 | date、amount、currency、category、wallet、note | ✓ |
| price_cache / fx_cache | 缓存 | | |
| reference_rates | 央行利率 | | |
| app_meta | 会话密钥、刷新时间、指数分解 | | |
| signal_metrics | 指标目录（代码写入） | key、label、grp、source、source_id、unit、decimals、blurb | |
| signal_values | 指标历史（永久保留） | metric_key、date、value | |
| venture_companies | YC 公司 | batch、industry、subindustry、country、team_size、status、stage、is_hiring、is_ai、tags、one_liner | |

**浏览器 localStorage**（明文，不在备份里）：`financier.ibkr.{token,queryId,accounts,map}`、`financier.t212.{apiKey,env,map}`、`financier.anthropic.key`。

---

## 7. API 清单

共 48 个路由。除 `auth/login`、`auth/status` 外，设了密码时都需要会话 cookie。

| 模块 | 路由 |
|---|---|
| Auth | `GET /api/auth/status` · `POST /api/auth/login` · `POST /api/auth/logout` |
| Holdings | `GET, POST /api/holdings` · `DELETE /api/holdings/:id` |
| Transactions | `GET, POST /api/holdings/:id/transactions` · `DELETE /api/transactions/:id` |
| Memo | `GET, PATCH /api/holdings/:id/memo` · `GET /api/holdings/:id/thesis-history` · `GET /api/holdings/:id/chart` · `GET /api/strategies` |
| Journal | `GET /api/journal` · `GET /api/journal/payload` · `POST /api/journal/review` |
| Cash | `GET, POST /api/cash` · `PATCH, DELETE /api/cash/:id` · `POST /api/cash/refresh-rates`※ · `GET /api/cash/maturing`※ |
| Bonds | `GET, POST /api/bonds` · `PATCH, DELETE /api/bonds/:id` |
| Budget | `GET, PATCH /api/budget/settings` · `GET, POST /api/expenses` · `DELETE /api/expenses/:id` |
| Market | `GET /api/search/:query` · `GET /api/price/:ticker` · `GET /api/fx`※ |
| Overview | `GET /api/summary` · `GET /api/overview/allocation` · `GET /api/overview/timeseries` |
| Backup | `GET /api/export` · `POST /api/import` |
| Brokers | `POST /api/ibkr/preview` · `POST /api/ibkr/sync` · `POST /api/t212/preview` · `POST /api/t212/sync` |
| Signals | `GET /api/signals` · `GET /api/signals/series/:key` · `POST /api/signals/refresh` · `GET /api/venture` |

※ 前端没有使用。

---

## 8. 技术架构、外部依赖、配置

```
浏览器 / Electron 窗口
        │  同源 /api
Express (server/server.js) ── SQLite (tracker.db)
        │
        └─ 外部数据源（可走代理）
```

| 层 | 技术 | 规模 |
|---|---|---|
| 后端 | Node ESM、Express 4、better-sqlite3、axios | `server.js` 约 2,370 行（单文件） |
| 数据库 | SQLite（WAL） | `schema.sql` 约 210 行 |
| 前端 | React 18、Vite 5、Recharts 2 | `App.jsx` 约 3,510 行、`App.css` 约 1,060 行 |
| 桌面 | Electron 33、electron-builder | `desktop/main.js`：同进程起服务、随机端口、单实例 |

视觉风格：Bauhaus。纸色底 `#faf6ec`，砖红 `#c8431f`、钴蓝 `#234e9c`、赭黄 `#e8a32c`，直角、细线、等宽数字（DM Mono，从 Google Fonts 加载）。

### 外部依赖

| 服务 | 用途 | 凭证 | 备注 |
|---|---|---|---|
| Yahoo Finance（非官方接口） | 价格、历史、搜索 | 无 | 会限流（429） |
| frankfurter.app | 汇率 | 无 | |
| FRED CSV | 宏观 / 市场序列 | 无 | |
| alternative.me | 加密 Fear & Greed | 无 | |
| yc-oss.github.io | YC 公司目录 | 无 | 社区维护 |
| IBKR Flex Web Service | 持仓、交易 | token + query id | |
| Trading212 API | 持仓 | API key | |
| Anthropic API | AI 复盘 | API key | 按用量计费 |
| Bank of England | 基准利率 | 无 | 接口可用，前端未用 |
| Google Fonts | 字体 | 无 | |

评估过但没用：CNN Fear & Greed（拒绝自动访问）、SEC EDGAR（要求在请求头里放联系邮箱）、Crunchbase / PitchBook / Dealroom（付费）。

### 环境变量

`FINANCIER_PASSWORD`、`FINANCIER_HOST`、`FINANCIER_PORT`、`FINANCIER_DB_PATH`、`FINANCIER_SCHEMA_PATH`、`FINANCIER_WEB_DIR`、`ANTHROPIC_API_KEY`、`IBKR_FLEX_TOKEN`、`IBKR_FLEX_QUERY_ID`、`T212_API_KEY`、`IBKR_FLEX_PROXY`、`HTTPS_PROXY`。

### 安全

HMAC 签名的 httpOnly cookie（30 天，`SameSite=Lax`，HTTPS 下加 `Secure`）；常数时间密码比较；非 loopback 地址没有密码时拒绝启动；CORS 白名单（本机、`*.ts.net`、`100.x`）。

---

## 9. 已知问题与缺口

### A. 实测确认（2026-11-27，临时数据库）

| # | 问题 | 影响 |
|---|---|---|
| A1 | **Venture map 把 2012–2014 的 batch 误标为「还在公布中」**：阈值按近年 batch 规模定，把当年本来就小的 batch 也算进去了（v2.13.0 引入） | 这些 batch 从图里消失（图从 2015 起），表格里显示为灰色 |
| A2 | **债券不计入净资产** | Overview 和汇总条低估资产 |
| A3 | **可以卖出超过持有的股数**（持 5 卖 100 → −95 股，被当作清仓） | 数据静默出错 |
| A4 | **清仓后的股票无法从界面重新买入**：重新新增返回 409「请添加交易」，但清仓持仓不在列表里 | 流程死路 |
| A5 | `scripts/curl-tests.sh` 过时（建仓不带 thesis 返回 400） | 实际上没有可用的测试 |

### B. 读代码得出（未实际运行验证）

| # | 问题 |
|---|---|
| B1 | 桌面版每次启动用随机端口，localStorage 按「地址 + 端口」隔离，因此**保存的券商 token、AI key、ticker 修正每次重开都会丢** |
| B2 | 券商「重建历史」会删除该持仓的全部交易，**包括手动录入的**（弹窗文案却说不会覆盖） |
| B3 | holdings 按 ticker 唯一、没有账户维度：两个券商账户持有同一只股票会互相覆盖 |
| B4 | 券商导入只看当前持仓，**在券商那边已清仓的股票不会同步进来** |
| B5 | 从搜索结果选股票不会自动设置币种和类型；币种填错会让 Overview 走势换算错误 |
| B6 | 汇总条换算 USD 时，汇率拿不到会按 1:1 处理，没有提示 |
| B7 | 在 Banking 改账户后，顶部 Cash 数字要等下次组合重载才更新 |
| B8 | 历史走势全程用今天的汇率；支出也按今天汇率换算 |
| B9 | 利率只展示，不参与余额计算；没有到期提醒界面 |
| B10 | 三套基准货币各管各的：汇总条固定 USD、Overview 可选、预算单独设置 |
| B11 | Memo 未保存就返回会直接丢失；删除单笔交易没有确认 |
| B12 | 交易、支出、持仓基本信息都不能编辑，只能删了重录 |
| B13 | 没设密码时 `Lock` 按钮仍在，点了出现一个任意密码都能过的登录页 |
| B14 | `wipe-data.sh` 不清债券、支出和预算设置 |

### C. 工程与文档

- 没有自动化测试；前后端各一个超大文件。
- `journalMarkdown` 和 `STRATEGIES` 定义了但没被使用。
- `README.md` 仍写「AI 功能是计划中」；写的是 Node 20.6+，但启动脚本用了更新的 `--env-file-if-exists` 参数（本机用 Node 22，20.x 未实测）。
- `PUSH_TO_GITHUB.md` 仍按「私有仓库」描述。
- `server/`、`web/` 的 `package.json` 版本号停在 2.0.0。
- 桌面包未签名；只构建过 arm64 macOS；没有应用图标。

---

## 10. 重做前要定的事

1. **主角是谁**：继续做记账工具，还是以 Signals 为首页、记账退到次要？
2. **输入成本**：目前记账半区几乎全靠手填，维护成本高。哪些功能值得保留手填，哪些砍掉？
3. **非英国账户**：Open Banking 覆盖不到，需要单独方案（例如月度批量更新）。
4. **运行形态**：桌面 App、本地网页、手机访问，保留几种？两个数据库要不要合一？
5. **指标清单**：27 张卡里真正会看的是哪些？还想追哪些趋势？
6. **旧数据**：新版本是否需要兼容现有 schema 和备份 JSON？
