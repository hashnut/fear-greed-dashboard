#!/usr/bin/env node
// Fear & Greed (overall + 7 components) + VOO/TQQQ collector.
// - CNN graphdata gives the overall index as a normalized 0-100 score, and
//   each of the 7 components as their RAW underlying value (S&P level, VIX,
//   put/call ratio, ...) plus a per-point rating category. We store the raw
//   values (best for judging timing vs price) and auto-detect each
//   component's direction (does a higher value mean greed or fear?) from the
//   correlation between value and rating.
// - Yahoo Finance for VOO / TQQQ daily prices.
// Zero dependencies: Node's built-in global fetch (Node 18+).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(__dirname, "config.json");
const OUT_PATH = join(ROOT, "docs", "data.json");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://edition.cnn.com/",
};

// Components: front-end key -> {label, cnn source key, direction}.
// "direction" = does a HIGHER raw value mean greed or fear? Hardcoded from
// CNN's published methodology — the per-point `rating` in the component
// history is unreliable (contradicts the value), so we do not use it.
// "momentum" is derived from S&P 500 vs its 125-day moving average.
const COMPONENTS = [
  { key: "momentum",   label: "모멘텀 (S&P 125일선 대비, %)", direction: "greedUp" }, // computed
  { key: "strength",   label: "주가 강도 (52주 신고가/신저가)", cnn: "stock_price_strength", direction: "greedUp" },
  { key: "breadth",    label: "주가 폭 (거래량)",               cnn: "stock_price_breadth",  direction: "greedUp" },
  { key: "putcall",    label: "풋/콜 옵션 비율",                cnn: "put_call_options",     direction: "fearUp" },
  { key: "volatility", label: "시장 변동성 (VIX)",              cnn: "market_volatility_vix", direction: "fearUp" },
  { key: "safehaven",  label: "안전자산 수요 (주식-채권 20일)", cnn: "safe_haven_demand",    direction: "greedUp" },
  { key: "junkbond",   label: "정크본드 수요 (수익률 스프레드)", cnn: "junk_bond_demand",     direction: "fearUp" },
];
const COMPONENT_KEYS = COMPONENTS.map((c) => c.key);
const ALL_KEYS = ["fng", ...COMPONENT_KEYS]; // fng = overall normalized 0-100

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const sig = (x) => (x == null || Number.isNaN(x) ? null : Number(x.toPrecision(6)));
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---- CNN Fear & Greed (overall + components) --------------------------
async function fetchCnn(startDate) {
  const url = `https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${startDate}`;
  const j = await getJson(url, BROWSER_HEADERS);

  // overall (normalized 0-100)
  const fngHist = {};
  for (const p of j.fear_and_greed_historical.data) {
    fngHist[isoDate(p.x)] = { score: round1(p.y), rating: p.rating };
  }
  const c = j.fear_and_greed;
  const fngCurrent = {
    score: round1(c.score), rating: c.rating, timestamp: c.timestamp,
    previousClose: round1(c.previous_close), week: round1(c.previous_1_week),
    month: round1(c.previous_1_month), year: round1(c.previous_1_year),
  };

  // components (raw values). The current 0-100 score/rating (top-level) is
  // reliable; we keep it for display. Per-point history ratings are ignored.
  const comp = {}; // key -> { value:{date:raw}, currentScore, currentRating }
  for (const def of COMPONENTS) {
    if (def.key === "momentum") {
      // momentum = % of S&P 500 above its 125-day moving average
      const sp = j.market_momentum_sp500, ma = j.market_momentum_sp125;
      const maByDate = {};
      for (const p of ma.data) maByDate[isoDate(p.x)] = p.y;
      const value = {};
      for (const p of sp.data) { const d = isoDate(p.x); if (maByDate[d]) value[d] = sig(((p.y / maByDate[d]) - 1) * 100); }
      comp.momentum = { value, currentScore: round1(sp.score), currentRating: sp.rating };
    } else {
      const src = j[def.cnn];
      const value = {};
      for (const p of src.data) value[isoDate(p.x)] = sig(p.y);
      comp[def.key] = { value, currentScore: round1(src.score), currentRating: src.rating };
    }
  }
  return { fngHist, fngCurrent, comp };
}

// ---- Yahoo Finance prices ---------------------------------------------
async function fetchPrices(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;
  const j = await getJson(url, BROWSER_HEADERS);
  const r = j.chart.result[0];
  const ts = r.timestamp || [];
  const close = r.indicators.quote[0].close || [];
  const out = {};
  for (let i = 0; i < ts.length; i++) {
    if (close[i] == null) continue;
    out[isoDate(ts[i] * 1000)] = round2(close[i]);
  }
  return { prices: out, last: round2(r.meta.regularMarketPrice) };
}

// ---- Previous store (accumulation / fallback) -------------------------
function loadPrevious() {
  if (!existsSync(OUT_PATH)) return null;
  try { return JSON.parse(readFileSync(OUT_PATH, "utf8")); }
  catch (e) { log("WARN bad data.json:", e.message); return null; }
}
function seriesToMaps(prev) {
  const maps = { voo: {}, tqqq: {} };
  for (const k of ALL_KEYS) maps[k] = {};
  const fngRating = {};
  if (prev?.series) {
    for (const row of prev.series) {
      if (row.voo != null) maps.voo[row.date] = row.voo;
      if (row.tqqq != null) maps.tqqq[row.date] = row.tqqq;
      if (row.fng != null) { maps.fng[row.date] = row.fng; if (row.rating) fngRating[row.date] = row.rating; }
      for (const k of COMPONENT_KEYS) if (row[k] != null) maps[k][row.date] = row[k];
    }
  }
  return { maps, fngRating };
}

// ---- Signals (overall index) ------------------------------------------
function computeSignals(series, cfg) {
  const buys = [], sells = [];
  let prevFng = null, greedStreak = 0;
  for (const row of series) {
    const f = row.fng;
    if (f == null) continue;
    if (prevFng != null && prevFng > cfg.buyThreshold && f <= cfg.buyThreshold)
      buys.push({ date: row.date, fng: f, voo: row.voo, tqqq: row.tqqq });
    if (f >= cfg.sellThreshold) {
      greedStreak++;
      if (greedStreak === cfg.sellSustainDays)
        sells.push({ date: row.date, fng: f, voo: row.voo, tqqq: row.tqqq, streak: greedStreak });
    } else greedStreak = 0;
    prevFng = f;
  }
  return { buys, sells, currentGreedStreak: greedStreak };
}

// ---- Backtest (overall-index strategy vs buy & hold) ------------------
function backtest(series, key, buys, sells, initial) {
  const buyDates = new Set(buys.map((b) => b.date));
  const sellDates = new Set(sells.map((s) => s.date));
  let lastPrice = null; const points = [];
  for (const row of series) {
    if (row[key] != null) lastPrice = row[key];
    if (lastPrice != null) points.push({ date: row.date, price: lastPrice });
  }
  if (points.length < 2) return null;
  const firstPrice = points[0].price, lastPx = points[points.length - 1].price;
  const maxDrawdown = (curve) => {
    let peak = -Infinity, mdd = 0;
    for (const v of curve) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > mdd) mdd = dd; }
    return round1(mdd * 100);
  };
  let cash = initial, shares = 0, trades = 0, daysInMarket = 0; const stratCurve = [];
  for (const p of points) {
    if (buyDates.has(p.date) && cash > 0) { shares = cash / p.price; cash = 0; trades++; }
    else if (sellDates.has(p.date) && shares > 0) { cash = shares * p.price; shares = 0; trades++; }
    if (shares > 0) daysInMarket++;
    stratCurve.push(cash + shares * p.price);
  }
  const stratFinal = cash + shares * lastPx;
  const bhShares = initial / firstPrice, bhFinal = bhShares * lastPx;
  const bhCurve = points.map((p) => bhShares * p.price);
  const years = (new Date(points[points.length - 1].date) - new Date(points[0].date)) / (365.25 * 864e5);
  const cagr = (f) => (years > 0 ? (Math.pow(f / initial, 1 / years) - 1) * 100 : 0);
  return {
    from: points[0].date, to: points[points.length - 1].date, years: round2(years),
    strategy: { final: round2(stratFinal), returnPct: round1((stratFinal / initial - 1) * 100),
      cagrPct: round1(cagr(stratFinal)), maxDrawdownPct: maxDrawdown(stratCurve), trades,
      timeInMarketPct: round1((daysInMarket / points.length) * 100) },
    buyHold: { final: round2(bhFinal), returnPct: round1((bhFinal / initial - 1) * 100),
      cagrPct: round1(cagr(bhFinal)), maxDrawdownPct: maxDrawdown(bhCurve) },
  };
}

// ---- Indicator meaningfulness: fear-oriented value vs forward returns --
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 20) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function computeAnalysis(series) {
  const HOR = [{ k: "w", label: "1주", days: 5 }, { k: "m", label: "1달", days: 21 }, { k: "q", label: "3달", days: 63 }];
  const dir = { fng: "greedUp" };
  for (const c of COMPONENTS) dir[c.key] = c.direction;

  const valMap = {};
  for (const k of ALL_KEYS) valMap[k] = {};
  for (const row of series) for (const k of ALL_KEYS) if (row[k] != null) valMap[k][row.date] = row[k];

  // trading-day sequences per asset (price-only, ordered)
  const seq = { voo: series.filter((r) => r.voo != null), tqqq: series.filter((r) => r.tqqq != null) };

  const rows = [];
  for (const k of ALL_KEYS) {
    const sign = dir[k] === "fearUp" ? 1 : -1; // orient so higher = more FEAR
    const corr = {}; const nObs = {};
    for (const asset of ["voo", "tqqq"]) {
      corr[asset] = {}; nObs[asset] = {};
      const s = seq[asset];
      for (const h of HOR) {
        const xs = [], ys = [];
        for (let i = 0; i + h.days < s.length; i++) {
          const v = valMap[k][s[i].date];
          if (v == null) continue;
          xs.push(sign * v);
          ys.push(s[i + h.days][asset] / s[i][asset] - 1);
        }
        const r = pearson(xs, ys);
        corr[asset][h.k] = r == null ? null : round2(r);
        nObs[asset][h.k] = xs.length;
      }
    }
    const all = [];
    for (const a of ["voo", "tqqq"]) for (const h of HOR) if (corr[a][h.k] != null) all.push(corr[a][h.k]);
    const composite = all.length ? round2(all.reduce((x, y) => x + y, 0) / all.length) : null;
    rows.push({ key: k, composite, corr, n: nObs.voo?.m ?? null });
  }
  rows.sort((a, b) => (b.composite ?? -9) - (a.composite ?? -9));
  return {
    horizons: HOR,
    rows,
    note: "공포 방향으로 정렬한 지표값 vs 이후 수익률의 상관계수. 양수 = 공포일수록 이후 상승(역발상 매수가 유리했던 지표).",
  };
}

// ---- Strategy comparison: percentile signals per indicator + combo -----
// Orient each indicator to "fear" (sign), rank within a trailing window, then
// buy on entering extreme fear and sell when greed persists. No look-ahead:
// the percentile only uses values up to and including the current day.
const dirOf = (key) => (key === "fng" ? "greedUp" : COMPONENTS.find((c) => c.key === key)?.direction);
const fearSign = (key) => (dirOf(key) === "fearUp" ? 1 : -1);
const MIN_WIN = 60; // need this many trailing points before trusting a percentile
const calmarOf = (s) => (s && s.maxDrawdownPct > 0 ? round2(s.returnPct / s.maxDrawdownPct) : null);
const indLabel = (key) =>
  key === "fng" ? "공포·탐욕 종합" : key === "combo" ? "복합" : (COMPONENTS.find((c) => c.key === key)?.label ?? key);

function pctSeries(series, key) {
  // returns array aligned to series: percentile of fear-oriented value within trailing window
  const sign = fearSign(key);
  const out = new Array(series.length).fill(null);
  const win = [];
  return { compute(W) {
    win.length = 0;
    for (let i = 0; i < series.length; i++) {
      const raw = series[i][key];
      if (raw == null) { out[i] = null; continue; }
      const v = sign * raw;
      win.push(v); if (win.length > W) win.shift();
      if (win.length < MIN_WIN) { out[i] = null; continue; }
      let le = 0; for (const w of win) if (w <= v) le++;
      out[i] = le / win.length;
    }
    return out;
  } };
}

function signalsFromPct(series, pct, p) {
  const buys = [], sells = [];
  let prev = null, greedStreak = 0;
  for (let i = 0; i < series.length; i++) {
    const x = pct[i];
    if (x == null) continue;
    if (prev != null && prev < p.buyPercentile && x >= p.buyPercentile) buys.push({ date: series[i].date });
    if (x <= p.sellPercentile) { greedStreak++; if (greedStreak === p.sellSustainDays) sells.push({ date: series[i].date }); }
    else greedStreak = 0;
    prev = x;
  }
  return { buys, sells };
}

function comboSignals(series, pcts, p) {
  const buys = [], sells = [];
  let prevFear = 0, greedStreak = 0;
  for (let i = 0; i < series.length; i++) {
    let fear = 0, greed = 0, avail = 0;
    for (const arr of pcts) { const x = arr[i]; if (x == null) continue; avail++; if (x >= p.buyPercentile) fear++; if (x <= p.sellPercentile) greed++; }
    if (avail) {
      if (prevFear < p.comboMinFear && fear >= p.comboMinFear) buys.push({ date: series[i].date });
      if (greed >= p.comboMinGreed) { greedStreak++; if (greedStreak === p.sellSustainDays) sells.push({ date: series[i].date }); }
      else greedStreak = 0;
      prevFear = fear;
    }
  }
  return { buys, sells };
}

function computeStrategyTest(series, cfg, fixedSigs, pctMap) {
  const p = cfg.strategyTest;
  const initial = cfg.backtest.initialCash;
  const labelOf = (key) => (key === "fng" ? "공포·탐욕 종합 (백분위)" : COMPONENTS.find((c) => c.key === key)?.label);
  const calmar = calmarOf;

  const make = (label, key, sig) => {
    const v = backtest(series, "voo", sig.buys, sig.sells, initial);
    const t = backtest(series, "tqqq", sig.buys, sig.sells, initial);
    if (!v || !t) return null;
    const pick = (s) => ({ returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, calmar: calmar(s), trades: s.trades, timeInMarketPct: s.timeInMarketPct });
    return { label, key, voo: pick(v.strategy), tqqq: pick(t.strategy) };
  };

  const rows = [];
  // buy & hold reference
  {
    const v = backtest(series, "voo", [], [], initial), t = backtest(series, "tqqq", [], [], initial);
    const bh = (b) => ({ returnPct: b.returnPct, maxDrawdownPct: b.maxDrawdownPct, calmar: calmar(b), trades: 1, timeInMarketPct: 100 });
    rows.push({ label: "단순보유 (Buy&Hold)", key: "buyhold", voo: bh(v.buyHold), tqqq: bh(t.buyHold) });
  }
  // existing overall-index fixed-threshold strategy (25/70)
  rows.push(make(`공포·탐욕 종합 (고정 ${cfg.buyThreshold}/${cfg.sellThreshold})`, "fng_fixed", fixedSigs));
  // each indicator via percentile
  for (const k of ALL_KEYS) rows.push(make(labelOf(k), k, signalsFromPct(series, pctMap[k], p)));
  // combo
  rows.push(make(`복합 (${p.comboKeys.join("+")}, ${p.comboMinFear}개↑ 공포)`, "combo",
    comboSignals(series, p.comboKeys.map((k) => pctMap[k]), p)));

  const out = rows.filter(Boolean);
  out.sort((a, b) => (b.voo.calmar ?? -99) - (a.voo.calmar ?? -99));
  return {
    params: p,
    note: `각 지표를 공포 방향으로 정렬해 과거 ${p.trailingWindow}일 대비 백분위로 신호 생성. 공포 상위 ${Math.round((1 - p.buyPercentile) * 100)}% 진입 시 매수, 탐욕 하위 ${Math.round(p.sellPercentile * 100)}%가 ${p.sellSustainDays}일 지속 시 매도. 수익÷MDD(Calmar)가 높을수록 '덜 물리고 잘 번' 전략.`,
    rows: out,
  };
}

// ---- Threshold sensitivity: is the edge robust across cutoffs? ---------
function comboPctArray(series, pctMap, keys) {
  return series.map((_, i) => {
    let sum = 0, n = 0;
    for (const k of keys) { const x = pctMap[k][i]; if (x != null) { sum += x; n++; } }
    return n ? sum / n : null;
  });
}

function computeSensitivity(series, cfg, pctMap) {
  const grid = [0.10, 0.15, 0.20, 0.25, 0.30]; // buy when in the most-fearful top X%
  const p0 = cfg.strategyTest;
  const targets = ["safehaven", "combo", "fng"];
  const rows = [];
  for (const key of targets) {
    const voo = [], tqqq = [];
    for (const X of grid) {
      const p = { buyPercentile: 1 - X, sellPercentile: X, sellSustainDays: p0.sellSustainDays,
        comboMinFear: p0.comboMinFear, comboMinGreed: p0.comboMinGreed };
      const sig = key === "combo"
        ? comboSignals(series, p0.comboKeys.map((k) => pctMap[k]), p)
        : signalsFromPct(series, pctMap[key], p);
      const v = backtest(series, "voo", sig.buys, sig.sells, cfg.backtest.initialCash);
      const t = backtest(series, "tqqq", sig.buys, sig.sells, cfg.backtest.initialCash);
      voo.push(v ? calmarOf(v.strategy) : null);
      tqqq.push(t ? calmarOf(t.strategy) : null);
    }
    rows.push({ key, label: indLabel(key), voo, tqqq });
  }
  return { grid, rows, note: "셀 = VOO Calmar (괄호 = TQQQ). 임계값(공포 상위 X%)을 바꿔도 값이 고르게 높으면 견고한 신호, 특정 칸만 튀면 운빨." };
}

// ---- Scaled buying: position size ∝ fear depth (vs all-in) -------------
function backtestScaled(series, asset, pctArr, lo, hi, initial) {
  const wf = (pct) => Math.max(0, Math.min(1, (pct - lo) / (hi - lo)));
  let cash = initial, shares = 0, lastPrice = null, prevW = null, trades = 0, expSum = 0, expN = 0;
  const curve = [];
  for (let i = 0; i < series.length; i++) {
    if (series[i][asset] != null) lastPrice = series[i][asset];
    if (lastPrice == null) continue;
    const pct = pctArr[i];
    if (pct != null) {
      const wTarget = wf(pct);
      if (prevW == null || Math.abs(wTarget - prevW) > 0.05) {
        const equity = cash + shares * lastPrice;
        const desired = (equity * wTarget) / lastPrice;
        cash -= (desired - shares) * lastPrice; shares = desired; prevW = wTarget; trades++;
      }
    }
    const eq = cash + shares * lastPrice;
    if (eq > 0) { expSum += (shares * lastPrice) / eq; expN++; }
    curve.push(eq);
  }
  if (curve.length < 2) return null;
  const final = curve[curve.length - 1];
  let peak = -Infinity, mdd = 0;
  for (const v of curve) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > mdd) mdd = dd; }
  const ret = (final / initial - 1) * 100, mddPct = round1(mdd * 100);
  return { returnPct: round1(ret), maxDrawdownPct: mddPct, calmar: mddPct > 0 ? round2(ret / mddPct) : null,
    avgExposurePct: round1((expSum / expN) * 100), trades };
}

function computeScaled(series, cfg, pctMap) {
  const p = cfg.strategyTest;
  const lo = p.scaledLoFear ?? 0.4, hi = p.scaledHiFear ?? 0.9;
  const initial = cfg.backtest.initialCash;
  const targets = ["safehaven", "combo", "fng"];
  const rows = [];
  for (const key of targets) {
    const arr = key === "combo" ? comboPctArray(series, pctMap, p.comboKeys) : pctMap[key];
    // all-in (percentile) reference
    const sig = key === "combo"
      ? comboSignals(series, p.comboKeys.map((k) => pctMap[k]), p)
      : signalsFromPct(series, pctMap[key], p);
    const av = backtest(series, "voo", sig.buys, sig.sells, initial);
    const at = backtest(series, "tqqq", sig.buys, sig.sells, initial);
    const pickAllin = (b) => ({ returnPct: b.returnPct, maxDrawdownPct: b.maxDrawdownPct, calmar: calmarOf(b), avgExposurePct: b.timeInMarketPct });
    rows.push({
      key, label: indLabel(key),
      allin: { voo: pickAllin(av.strategy), tqqq: pickAllin(at.strategy) },
      scaled: { voo: backtestScaled(series, "voo", arr, lo, hi, initial), tqqq: backtestScaled(series, "tqqq", arr, lo, hi, initial) },
    });
  }
  return { lo, hi, rows,
    note: `분할매수: 공포 백분위가 ${Math.round(lo * 100)}% 미만이면 현금, ${Math.round(hi * 100)}%↑면 100% 투자, 그 사이는 비례 배분(매일 리밸런싱). '전량'은 같은 신호로 올인/올아웃.` };
}

// ---- Dollar-cost averaging: plain vs "save reserve, buy the fear" ------
function irrAnnual(flows) { // flows: [{t: monthIndex, amt}], solve monthly rate
  const npv = (r) => flows.reduce((s, f) => s + f.amt / Math.pow(1 + r, f.t), 0);
  let lo = -0.95, hi = 2.0;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; const v = npv(mid); if (Math.abs(v) < 0.01) { lo = hi = mid; break; } if (npv(lo) * v < 0) hi = mid; else lo = mid; }
  const m = (lo + hi) / 2;
  return round1((Math.pow(1 + m, 12) - 1) * 100);
}

function dcaBacktest(series, asset, monthlyC, fearPct, buyP, saveFrac) {
  let shares = 0, reserve = 0, contributed = 0, lastPrice = null, mIdx = -1;
  let prevMonth = null;
  const curve = [], flows = [];
  for (let i = 0; i < series.length; i++) {
    const px = series[i][asset];
    if (px == null) continue;
    lastPrice = px;
    const ym = series[i].date.slice(0, 7);
    if (ym !== prevMonth) { // new month → contribute fixed amount
      prevMonth = ym; mIdx++;
      contributed += monthlyC; flows.push({ t: mIdx, amt: -monthlyC });
      if (!fearPct) shares += monthlyC / px;
      else { shares += (monthlyC * (1 - saveFrac)) / px; reserve += monthlyC * saveFrac; }
    }
    if (fearPct) { const p = fearPct[i]; if (p != null && p >= buyP && reserve > 0) { shares += reserve / px; reserve = 0; } }
    curve.push(shares * px + reserve);
  }
  if (curve.length < 2 || contributed === 0) return null;
  const finalVal = shares * lastPrice + reserve;
  flows.push({ t: mIdx, amt: finalVal });
  let peak = -Infinity, mdd = 0;
  for (const v of curve) { if (v > peak) peak = v; if (peak > 0) { const dd = (peak - v) / peak; if (dd > mdd) mdd = dd; } }
  return {
    contributed: Math.round(contributed), finalValue: Math.round(finalVal),
    gainPct: round1(((finalVal - contributed) / contributed) * 100),
    irrPct: irrAnnual(flows), maxDrawdownPct: round1(mdd * 100),
    leftoverCashPct: round1((reserve / finalVal) * 100), months: mIdx + 1,
  };
}

function computeDCA(series, cfg, pctMap) {
  const d = cfg.dca || { monthly: 1000, saveFraction: 0.4, dipPercentile: 0.15 };
  const buyP = 1 - d.dipPercentile;
  const comboArr = comboPctArray(series, pctMap, cfg.strategyTest.comboKeys);
  const sources = [
    { key: "plain", label: "순수 적립식 (매달 같은 금액)", arr: null },
    { key: "fng", label: "적립식 + 공포매수 (종합지수)", arr: pctMap.fng },
    { key: "safehaven", label: "적립식 + 공포매수 (안전자산)", arr: pctMap.safehaven },
    { key: "combo", label: "적립식 + 공포매수 (복합)", arr: comboArr },
  ];
  const rows = sources.map((s) => ({
    key: s.key, label: s.label,
    voo: dcaBacktest(series, "voo", d.monthly, s.arr, buyP, d.saveFraction),
    tqqq: dcaBacktest(series, "tqqq", d.monthly, s.arr, buyP, d.saveFraction),
  })).filter((r) => r.voo && r.tqqq);
  return {
    monthly: d.monthly, saveFraction: d.saveFraction, dipPercentile: d.dipPercentile,
    months: rows[0]?.voo.months ?? 0, contributed: rows[0]?.voo.contributed ?? 0,
    rows,
    note: `매달 $${d.monthly}씩 ${rows[0]?.voo.months ?? 0}개월 투입(총 $${(rows[0]?.voo.contributed ?? 0).toLocaleString()}, 모든 방식 동일). '공포매수'는 매달 ${Math.round(d.saveFraction * 100)}%를 현금으로 모아뒀다가, 공포 상위 ${Math.round(d.dipPercentile * 100)}%에 들어가면 그 현금을 한 번에 투입.`,
  };
}

// ---- Walk-forward: optimize on past, apply to unseen future -----------
function computeWalkForward(series, cfg, pctMap) {
  const initial = cfg.backtest.initialCash;
  const p0 = cfg.strategyTest;
  const grid = [0.10, 0.15, 0.20, 0.25, 0.30];
  const N = series.length;
  const minTrain = 504, chunk = 126; // ~2y warm-up, re-optimize every ~6 months
  if (N < minTrain + chunk) return null;
  const candidates = ["safehaven", "combo", "fng", "putcall", "momentum"];

  const pp = (X) => ({ buyPercentile: 1 - X, sellPercentile: X, sellSustainDays: p0.sellSustainDays,
    comboMinFear: p0.comboMinFear, comboMinGreed: p0.comboMinGreed });
  const gen = (key, a, b, X) => {
    const sl = series.slice(a, b);
    return key === "combo"
      ? comboSignals(sl, p0.comboKeys.map((k) => pctMap[k].slice(a, b)), pp(X))
      : signalsFromPct(sl, pctMap[key].slice(a, b), pp(X));
  };
  const evalRange = (key, a, b, X, asset) => {
    const sl = series.slice(a, b), s = gen(key, a, b, X);
    const bt = backtest(sl, asset, s.buys, s.sells, initial);
    return bt ? bt.strategy : null;
  };
  const bestX = (key, a, b, asset) => { // optimize threshold on [a,b) by Calmar
    let bx = 0.15, bc = -Infinity;
    for (const X of grid) { const s = evalRange(key, a, b, X, asset); const c = s ? calmarOf(s) : null; if (c != null && c > bc) { bc = c; bx = X; } }
    return { X: bx, cal: bc === -Infinity ? null : round2(bc) };
  };
  const metrics = (s) => (s ? { returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct, calmar: calmarOf(s), trades: s.trades } : null);

  const slO = series.slice(minTrain, N); // out-of-sample evaluation span
  const bh = (b) => ({ returnPct: b.returnPct, maxDrawdownPct: b.maxDrawdownPct, calmar: calmarOf(b) });
  const benchmark = { voo: bh(backtest(slO, "voo", [], [], initial).buyHold), tqqq: bh(backtest(slO, "tqqq", [], [], initial).buyHold) };

  // per-indicator: optimize threshold each fold, apply to next unseen chunk
  const perIndicator = [];
  for (const key of candidates) {
    const buys = [], sells = [];
    for (let t0 = minTrain; t0 < N; t0 += chunk) {
      const t1 = Math.min(t0 + chunk, N);
      const opt = bestX(key, 0, t0, "voo");
      const s = gen(key, t0, t1, opt.X);
      buys.push(...s.buys); sells.push(...s.sells);
    }
    const v = backtest(slO, "voo", buys, sells, initial).strategy;
    const t = backtest(slO, "tqqq", buys, sells, initial).strategy;
    perIndicator.push({ key, label: indLabel(key), isCalmar: bestX(key, 0, N, "voo").cal, oosVoo: metrics(v), oosTqqq: metrics(t) });
  }
  perIndicator.sort((a, b) => (b.oosVoo?.calmar ?? -99) - (a.oosVoo?.calmar ?? -99));

  // auto-pick: each fold choose the indicator with best training Calmar, apply unseen
  const buysA = [], sellsA = [], picks = [];
  for (let t0 = minTrain; t0 < N; t0 += chunk) {
    const t1 = Math.min(t0 + chunk, N);
    let best = null;
    for (const key of candidates) { const o = bestX(key, 0, t0, "voo"); if (o.cal != null && (best == null || o.cal > best.cal)) best = { key, X: o.X, cal: o.cal }; }
    if (!best) best = { key: "fng", X: 0.15 };
    picks.push({ from: series[t0].date, key: best.key, label: indLabel(best.key), X: best.X });
    const s = gen(best.key, t0, t1, best.X); buysA.push(...s.buys); sellsA.push(...s.sells);
  }
  const av = backtest(slO, "voo", buysA, sellsA, initial).strategy;
  const at = backtest(slO, "tqqq", buysA, sellsA, initial).strategy;

  return {
    oosFrom: series[minTrain].date, oosTo: series[N - 1].date, trainYears: round2(minTrain / 252),
    benchmark, perIndicator, autoPick: { voo: metrics(av), tqqq: metrics(at), picks },
    note: `학습 구간에서 임계값(공포 상위 X%)을 최적화한 뒤, 한 번도 보지 않은 다음 구간에 적용. 검증(OOS)은 ${series[minTrain].date}부터(앞 ~2년은 학습용). '자동선택'은 매 구간 학습 1등 지표를 골라 적용 — 지표 선택 과정 자체를 검증.`,
  };
}

function buildStatus(cur, sig, cfg) {
  if (!cur) return { level: "unknown", text: "데이터 없음" };
  const s = cur.score;
  if (s <= cfg.buyThreshold) return { level: "buy", text: `공포 구간 (지수 ${s}) — 매수 후보` };
  if (s >= cfg.sellThreshold) {
    const d = sig.currentGreedStreak;
    if (d >= cfg.sellSustainDays) return { level: "sell", text: `탐욕 ${d}일 지속 (지수 ${s}) — 분할 매도 검토` };
    return { level: "greed", text: `탐욕 구간 (지수 ${s}, ${d}일째) — 매도 신호까지 ${cfg.sellSustainDays - d}일` };
  }
  return { level: "neutral", text: `중립 (지수 ${s}) — 관망` };
}

// ---- Main --------------------------------------------------------------
async function main() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const prev = loadPrevious();
  const { maps, fngRating } = seriesToMaps(prev);

  let fngCurrent = prev?.fngCurrent ?? null;
  let compCurrent = {}; // key -> {currentScore, currentRating}
  if (prev?.indicators) for (const ind of prev.indicators)
    if (ind.key !== "fng") compCurrent[ind.key] = { currentScore: ind.currentScore, currentRating: ind.currentRating };
  const errors = [];

  // 1) CNN overall + components
  try {
    const r = await fetchCnn(cfg.historyStartDate);
    for (const [d, o] of Object.entries(r.fngHist)) { maps.fng[d] = o.score; fngRating[d] = o.rating; }
    fngCurrent = r.fngCurrent;
    for (const k of COMPONENT_KEYS) {
      Object.assign(maps[k], r.comp[k].value);
      compCurrent[k] = { currentScore: r.comp[k].currentScore, currentRating: r.comp[k].currentRating };
    }
    log(`CNN ok: fng=${fngCurrent.score} (${fngCurrent.rating}); components=${COMPONENT_KEYS.length}`);
  } catch (e) { errors.push(`cnn: ${e.message}`); log("ERROR CNN:", e.message, "- keeping previous"); }

  // 2) Prices
  for (const [k, sym] of Object.entries(cfg.tickers)) {
    try {
      const { prices, last } = await fetchPrices(sym, cfg.priceRange);
      Object.assign(maps[k], prices);
      log(`${sym} ok: ${Object.keys(prices).length} days, last=${last}`);
    } catch (e) { errors.push(`${sym}: ${e.message}`); log(`ERROR ${sym}:`, e.message, "- keeping previous"); }
  }

  // 3) Unified series
  const allDates = new Set();
  for (const k of [...ALL_KEYS, "voo", "tqqq"]) for (const d of Object.keys(maps[k])) allDates.add(d);
  const series = [...allDates].sort().map((date) => {
    const row = { date, fng: maps.fng[date] ?? null, rating: fngRating[date] ?? null,
      voo: maps.voo[date] ?? null, tqqq: maps.tqqq[date] ?? null };
    for (const k of COMPONENT_KEYS) row[k] = maps[k][date] ?? null;
    return row;
  });

  // 4) Signals + backtest (overall index)
  const sigs = computeSignals(series, cfg);

  // trailing-window fear percentiles per indicator (reused by strategy analyses)
  const pctMap = {};
  for (const k of ALL_KEYS) pctMap[k] = pctSeries(series, k).compute(cfg.strategyTest.trailingWindow);
  const bt = { voo: backtest(series, "voo", sigs.buys, sigs.sells, cfg.backtest.initialCash),
               tqqq: backtest(series, "tqqq", sigs.buys, sigs.sells, cfg.backtest.initialCash) };

  // 5) Indicator metadata (for the selector)
  const indicators = [{ key: "fng", label: "공포·탐욕 지수 (종합)", normalized: true, direction: "greedUp",
    currentScore: fngCurrent?.score ?? null, currentRating: fngCurrent?.rating ?? null }];
  for (const def of COMPONENTS) {
    indicators.push({
      key: def.key, label: def.label, normalized: false,
      direction: def.direction,
      currentValue: series.filter((r) => r[def.key] != null).at(-1)?.[def.key] ?? null,
      currentScore: compCurrent[def.key]?.currentScore ?? null,
      currentRating: compCurrent[def.key]?.currentRating ?? null,
    });
  }

  const out = {
    updated: new Date().toISOString(),
    config: { buyThreshold: cfg.buyThreshold, sellThreshold: cfg.sellThreshold,
      sellSustainDays: cfg.sellSustainDays, initialCash: cfg.backtest.initialCash },
    fngCurrent,
    lastPrices: { voo: series.filter((r) => r.voo != null).at(-1)?.voo ?? null,
      tqqq: series.filter((r) => r.tqqq != null).at(-1)?.tqqq ?? null },
    status: buildStatus(fngCurrent, sigs, cfg),
    indicators,
    signals: { buys: sigs.buys, sells: sigs.sells },
    backtest: bt,
    analysis: computeAnalysis(series),
    strategyTest: computeStrategyTest(series, cfg, sigs, pctMap),
    sensitivity: computeSensitivity(series, cfg, pctMap),
    scaled: computeScaled(series, cfg, pctMap),
    walkForward: computeWalkForward(series, cfg, pctMap),
    dca: computeDCA(series, cfg, pctMap),
    series,
    errors,
  };

  writeFileSync(OUT_PATH, JSON.stringify(out));
  log(`wrote ${OUT_PATH} (${series.length} rows, ${indicators.length} indicators, ${sigs.buys.length} buys, ${sigs.sells.length} sells)`);
  if (errors.length) { log("completed WITH errors:", errors.join("; ")); process.exitCode = 2; }
}

main().catch((e) => { log("FATAL:", e.stack || e.message); process.exit(1); });
