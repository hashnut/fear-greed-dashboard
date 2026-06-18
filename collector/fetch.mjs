#!/usr/bin/env node
// Fear & Greed + VOO/TQQQ collector.
// - Fetches CNN Fear & Greed index history + current snapshot
// - Fetches VOO / TQQQ daily prices from Yahoo Finance
// - Merges into an accumulated store (docs/data.json), computes buy/sell
//   signals and a simple backtest, and writes the file the website reads.
//
// Zero dependencies: uses Node's built-in global fetch (Node 18+).

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

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---- CNN Fear & Greed --------------------------------------------------
async function fetchFearGreed(startDate) {
  const url = `https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${startDate}`;
  const j = await getJson(url, BROWSER_HEADERS);
  const hist = {};
  for (const p of j.fear_and_greed_historical.data) {
    hist[isoDate(p.x)] = { score: round1(p.y), rating: p.rating };
  }
  const c = j.fear_and_greed;
  const current = {
    score: round1(c.score),
    rating: c.rating,
    timestamp: c.timestamp,
    previousClose: round1(c.previous_close),
    week: round1(c.previous_1_week),
    month: round1(c.previous_1_month),
    year: round1(c.previous_1_year),
  };
  return { hist, current };
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
    const v = close[i];
    if (v == null) continue;
    out[isoDate(ts[i] * 1000)] = round2(v);
  }
  return { prices: out, last: round2(r.meta.regularMarketPrice) };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

// ---- Load previous store (for accumulation / fallback) ----------------
function loadPrevious() {
  if (!existsSync(OUT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OUT_PATH, "utf8"));
  } catch (e) {
    log("WARN could not parse existing data.json:", e.message);
    return null;
  }
}

function seriesToMaps(prev) {
  const fng = {}, voo = {}, tqqq = {};
  if (prev?.series) {
    for (const row of prev.series) {
      if (row.fng != null) fng[row.date] = { score: row.fng, rating: row.rating };
      if (row.voo != null) voo[row.date] = row.voo;
      if (row.tqqq != null) tqqq[row.date] = row.tqqq;
    }
  }
  return { fng, voo, tqqq };
}

// ---- Signals -----------------------------------------------------------
function computeSignals(series, cfg) {
  const buys = [];
  const sells = [];
  let prevFng = null;
  let greedStreak = 0;
  for (const row of series) {
    const f = row.fng;
    if (f == null) continue;
    // Buy: crossing down into the fear threshold
    if (prevFng != null && prevFng > cfg.buyThreshold && f <= cfg.buyThreshold) {
      buys.push({ date: row.date, fng: f, voo: row.voo, tqqq: row.tqqq });
    }
    // Sell: greed sustained for N consecutive days -> emit once when reached
    if (f >= cfg.sellThreshold) {
      greedStreak++;
      if (greedStreak === cfg.sellSustainDays) {
        sells.push({ date: row.date, fng: f, voo: row.voo, tqqq: row.tqqq, streak: greedStreak });
      }
    } else {
      greedStreak = 0;
    }
    prevFng = f;
  }
  return { buys, sells, currentGreedStreak: greedStreak };
}

// ---- Backtest ----------------------------------------------------------
// Simple all-in/all-out strategy on the signal dates, vs buy & hold.
function backtest(series, key, buys, sells, initial) {
  const buyDates = new Set(buys.map((b) => b.date));
  const sellDates = new Set(sells.map((s) => s.date));

  // forward-fill prices so a signal day never lands on a missing price
  let lastPrice = null;
  const points = [];
  for (const row of series) {
    if (row[key] != null) lastPrice = row[key];
    if (lastPrice != null) points.push({ date: row.date, price: lastPrice });
  }
  if (points.length < 2) return null;

  const firstPrice = points[0].price;
  const lastPx = points[points.length - 1].price;

  // max drawdown of an equity curve (returns positive % drop, peak-to-trough)
  const maxDrawdown = (curve) => {
    let peak = -Infinity, mdd = 0;
    for (const v of curve) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak;
      if (dd > mdd) mdd = dd;
    }
    return round1(mdd * 100);
  };

  // strategy sim (track equity curve for drawdown)
  let cash = initial, shares = 0, trades = 0, daysInMarket = 0;
  const stratCurve = [];
  for (const p of points) {
    if (buyDates.has(p.date) && cash > 0) {
      shares = cash / p.price; cash = 0; trades++;
    } else if (sellDates.has(p.date) && shares > 0) {
      cash = shares * p.price; shares = 0; trades++;
    }
    if (shares > 0) daysInMarket++;
    stratCurve.push(cash + shares * p.price);
  }
  const stratFinal = cash + shares * lastPx;

  // buy & hold
  const bhShares = initial / firstPrice;
  const bhFinal = bhShares * lastPx;
  const bhCurve = points.map((p) => bhShares * p.price);

  const years =
    (new Date(points[points.length - 1].date) - new Date(points[0].date)) /
    (365.25 * 24 * 3600 * 1000);
  const cagr = (final) => (years > 0 ? (Math.pow(final / initial, 1 / years) - 1) * 100 : 0);

  return {
    from: points[0].date,
    to: points[points.length - 1].date,
    years: round2(years),
    strategy: {
      final: round2(stratFinal),
      returnPct: round1(((stratFinal - initial) / initial) * 100),
      cagrPct: round1(cagr(stratFinal)),
      maxDrawdownPct: maxDrawdown(stratCurve),
      trades,
      timeInMarketPct: round1((daysInMarket / points.length) * 100),
    },
    buyHold: {
      final: round2(bhFinal),
      returnPct: round1(((bhFinal - initial) / initial) * 100),
      cagrPct: round1(cagr(bhFinal)),
      maxDrawdownPct: maxDrawdown(bhCurve),
    },
  };
}

// ---- Main --------------------------------------------------------------
async function main() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const prev = loadPrevious();
  const maps = seriesToMaps(prev);

  let fngCurrent = prev?.fngCurrent ?? null;
  const errors = [];

  // 1) Fear & Greed (merge into accumulated map; keep old on failure)
  try {
    const fg = await fetchFearGreed(cfg.historyStartDate);
    Object.assign(maps.fng, fg.hist);
    fngCurrent = fg.current;
    log(`F&G ok: ${Object.keys(fg.hist).length} days, current=${fg.current.score} (${fg.current.rating})`);
  } catch (e) {
    errors.push(`fng: ${e.message}`);
    log("ERROR fetching F&G:", e.message, "- keeping previous data");
  }

  // 2) Prices (full refresh; keep old on failure)
  for (const [k, sym] of Object.entries(cfg.tickers)) {
    try {
      const { prices, last } = await fetchPrices(sym, cfg.priceRange);
      Object.assign(maps[k], prices);
      log(`${sym} ok: ${Object.keys(prices).length} days, last=${last}`);
    } catch (e) {
      errors.push(`${sym}: ${e.message}`);
      log(`ERROR fetching ${sym}:`, e.message, "- keeping previous data");
    }
  }

  // 3) Build unified, date-sorted series
  const allDates = new Set([
    ...Object.keys(maps.fng),
    ...Object.keys(maps.voo),
    ...Object.keys(maps.tqqq),
  ]);
  const series = [...allDates]
    .sort()
    .map((date) => ({
      date,
      fng: maps.fng[date]?.score ?? null,
      rating: maps.fng[date]?.rating ?? null,
      voo: maps.voo[date] ?? null,
      tqqq: maps.tqqq[date] ?? null,
    }));

  // 4) Signals + backtest
  const sig = computeSignals(series, cfg);
  const bt = {
    voo: backtest(series, "voo", sig.buys, sig.sells, cfg.backtest.initialCash),
    tqqq: backtest(series, "tqqq", sig.buys, sig.sells, cfg.backtest.initialCash),
  };

  // 5) Current status banner
  const status = buildStatus(fngCurrent, sig, cfg);

  const out = {
    updated: new Date().toISOString(),
    config: {
      buyThreshold: cfg.buyThreshold,
      sellThreshold: cfg.sellThreshold,
      sellSustainDays: cfg.sellSustainDays,
      initialCash: cfg.backtest.initialCash,
    },
    fngCurrent,
    lastPrices: {
      voo: series.filter((r) => r.voo != null).at(-1)?.voo ?? null,
      tqqq: series.filter((r) => r.tqqq != null).at(-1)?.tqqq ?? null,
    },
    status,
    signals: { buys: sig.buys, sells: sig.sells },
    backtest: bt,
    series,
    errors,
  };

  writeFileSync(OUT_PATH, JSON.stringify(out));
  log(`wrote ${OUT_PATH} (${series.length} rows, ${sig.buys.length} buys, ${sig.sells.length} sells)`);
  if (errors.length) {
    log("completed WITH errors:", errors.join("; "));
    process.exitCode = 2; // non-fatal: file still written from cache
  }
}

function buildStatus(cur, sig, cfg) {
  if (!cur) return { level: "unknown", text: "데이터 없음" };
  const s = cur.score;
  if (s <= cfg.buyThreshold)
    return { level: "buy", text: `공포 구간 (지수 ${s}) — 매수 후보` };
  if (s >= cfg.sellThreshold) {
    const d = sig.currentGreedStreak;
    if (d >= cfg.sellSustainDays)
      return { level: "sell", text: `탐욕 ${d}일 지속 (지수 ${s}) — 분할 매도 검토` };
    return { level: "greed", text: `탐욕 구간 (지수 ${s}, ${d}일째) — 매도 신호까지 ${cfg.sellSustainDays - d}일` };
  }
  return { level: "neutral", text: `중립 (지수 ${s}) — 관망` };
}

main().catch((e) => {
  log("FATAL:", e.stack || e.message);
  process.exit(1);
});
