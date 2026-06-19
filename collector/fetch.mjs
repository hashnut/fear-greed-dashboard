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
    series,
    errors,
  };

  writeFileSync(OUT_PATH, JSON.stringify(out));
  log(`wrote ${OUT_PATH} (${series.length} rows, ${indicators.length} indicators, ${sigs.buys.length} buys, ${sigs.sells.length} sells)`);
  if (errors.length) { log("completed WITH errors:", errors.join("; ")); process.exitCode = 2; }
}

main().catch((e) => { log("FATAL:", e.stack || e.message); process.exit(1); });
