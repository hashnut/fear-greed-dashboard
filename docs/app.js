/* Renders the dashboard from data.json. */
const COLORS = {
  voo: "#5b8def", tqqq: "#c779e0", fng: "#f0b429",
  buy: "#2ecc71", sell: "#e74c3c", grid: "rgba(255,255,255,0.06)",
  fearZone: "rgba(46,204,113,0.10)", greedZone: "rgba(231,76,60,0.10)",
};

let DATA = null;
const charts = {};
let currentDays = 365;

const $ = (id) => document.getElementById(id);
const fmtNum = (n, d = 0) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (n) => (n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(1) + "%");
const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");

init();

async function init() {
  try {
    const res = await fetch("data.json?_=" + Date.now()); // bust cache so phone sees fresh data
    DATA = await res.json();
  } catch (e) {
    $("status").textContent = "데이터를 불러오지 못했습니다: " + e.message;
    return;
  }
  renderHeader();
  renderBacktest();
  buildChart("chartVoo", "voo", "VOO", COLORS.voo);
  buildChart("chartTqqq", "tqqq", "TQQQ", COLORS.tqqq);
  applyRange(currentDays);

  $("ranges").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    document.querySelectorAll("#ranges button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    currentDays = Number(b.dataset.days);
    applyRange(currentDays);
  });
}

function renderHeader() {
  const c = DATA.fngCurrent || {};
  const cfg = DATA.config;
  const upd = new Date(DATA.updated);
  $("updated").textContent = "업데이트: " + upd.toLocaleString("ko-KR");

  const st = DATA.status || { level: "unknown", text: "—" };
  $("status").textContent = st.text;
  $("status").className = "card status " + st.level;

  $("fngScore").textContent = c.score ?? "--";
  $("fngRating").textContent = ratingKo(c.rating);
  $("fngFill").style.left = (c.score ?? 0) + "%";
  $("pWeek").textContent = fmtNum(c.week);
  $("pMonth").textContent = fmtNum(c.month);
  $("pYear").textContent = fmtNum(c.year);
  $("pVoo").textContent = "$" + fmtNum(DATA.lastPrices?.voo, 2);
  $("pTqqq").textContent = "$" + fmtNum(DATA.lastPrices?.tqqq, 2);

  $("thresholds").textContent =
    `규칙: 공포 ≤ ${cfg.buyThreshold} 매수 후보 · 탐욕 ≥ ${cfg.sellThreshold} 가 ${cfg.sellSustainDays}일 지속 시 매도 검토`;
  if (DATA.errors?.length) $("updated").textContent += "  ⚠ 수집 경고 있음";
}

function ratingKo(r) {
  return ({
    "extreme fear": "극도의 공포", fear: "공포", neutral: "중립",
    greed: "탐욕", "extreme greed": "극도의 탐욕",
  })[r] || (r ?? "—");
}

function buildChart(canvasId, priceKey, label, color) {
  const ctx = $(canvasId).getContext("2d");
  const cfg = DATA.config;
  charts[canvasId] = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label, yAxisID: "price", borderColor: color, backgroundColor: color,
          borderWidth: 2, pointRadius: 0, tension: 0.1, spanGaps: true, data: [], order: 2,
        },
        {
          label: "공포·탐욕", yAxisID: "fng", borderColor: COLORS.fng, backgroundColor: COLORS.fng,
          borderWidth: 1.5, pointRadius: 0, tension: 0.1, spanGaps: true, data: [], order: 3,
        },
        {
          label: "매수신호", yAxisID: "price", type: "scatter", data: [],
          borderColor: COLORS.buy, backgroundColor: COLORS.buy, pointStyle: "triangle",
          pointRadius: 7, pointHoverRadius: 9, order: 1,
        },
        {
          label: "매도신호", yAxisID: "price", type: "scatter", data: [],
          borderColor: COLORS.sell, backgroundColor: COLORS.sell,
          pointStyle: "triangle", rotation: 180, pointRadius: 7, pointHoverRadius: 9, order: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      stacked: false,
      scales: {
        x: { type: "time", time: { tooltipFormat: "yyyy-MM-dd" },
             grid: { color: COLORS.grid }, ticks: { color: "#9aa0aa", maxRotation: 0, autoSkipPadding: 24 } },
        price: { position: "left", grid: { color: COLORS.grid },
                 ticks: { color: color, callback: (v) => "$" + v } },
        fng: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false },
               ticks: { color: COLORS.fng, stepSize: 25 } },
      },
      plugins: {
        legend: { labels: { color: "#e8eaed", boxWidth: 12, usePointStyle: true } },
        tooltip: { callbacks: {
          label: (i) => {
            if (i.dataset.yAxisID === "fng") return `공포·탐욕: ${i.parsed.y}`;
            const v = i.parsed.y;
            return `${i.dataset.label}: ${v == null ? "—" : "$" + v.toFixed(2)}`;
          },
        } },
        annotation: {
          annotations: {
            fearBox: { type: "box", yScaleID: "fng", yMin: 0, yMax: cfg.buyThreshold,
                       backgroundColor: COLORS.fearZone, borderWidth: 0 },
            greedBox: { type: "box", yScaleID: "fng", yMin: cfg.sellThreshold, yMax: 100,
                        backgroundColor: COLORS.greedZone, borderWidth: 0 },
            buyLine: { type: "line", yScaleID: "fng", yMin: cfg.buyThreshold, yMax: cfg.buyThreshold,
                       borderColor: "rgba(46,204,113,0.5)", borderWidth: 1, borderDash: [4, 4] },
            sellLine: { type: "line", yScaleID: "fng", yMin: cfg.sellThreshold, yMax: cfg.sellThreshold,
                        borderColor: "rgba(231,76,60,0.5)", borderWidth: 1, borderDash: [4, 4] },
          },
        },
      },
    },
  });
}

function applyRange(days) {
  const series = DATA.series;
  let rows = series;
  if (days > 0) {
    const lastDate = new Date(series[series.length - 1].date);
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - days);
    const cutStr = cutoff.toISOString().slice(0, 10);
    rows = series.filter((r) => r.date >= cutStr);
  }
  for (const [canvasId, priceKey] of [["chartVoo", "voo"], ["chartTqqq", "tqqq"]]) {
    const ch = charts[canvasId];
    ch.data.datasets[0].data = rows.filter((r) => r[priceKey] != null).map((r) => ({ x: r.date, y: r[priceKey] }));
    ch.data.datasets[1].data = rows.filter((r) => r.fng != null).map((r) => ({ x: r.date, y: r.fng }));
    const first = rows[0]?.date, last = rows[rows.length - 1]?.date;
    ch.data.datasets[2].data = DATA.signals.buys
      .filter((b) => b[priceKey] != null && b.date >= first && b.date <= last)
      .map((b) => ({ x: b.date, y: b[priceKey] }));
    ch.data.datasets[3].data = DATA.signals.sells
      .filter((s) => s[priceKey] != null && s.date >= first && s.date <= last)
      .map((s) => ({ x: s.date, y: s[priceKey] }));
    ch.update("none");
  }
}

function renderBacktest() {
  const bt = DATA.backtest, cfg = DATA.config;
  $("btRange").textContent = bt.voo ? `(${bt.voo.from} ~ ${bt.voo.to}, ${bt.voo.years}년)` : "";
  $("btRule").textContent =
    `초기자금 $${fmtNum(cfg.initialCash)} · 공포(≤${cfg.buyThreshold}) 진입 시 전액 매수, ` +
    `탐욕(≥${cfg.sellThreshold}) ${cfg.sellSustainDays}일 지속 시 전액 매도. "전략" vs 단순 보유(Buy&Hold) 비교.`;
  const box = $("backtest");
  box.innerHTML = "";
  for (const [key, name] of [["voo", "VOO"], ["tqqq", "TQQQ"]]) {
    const b = bt[key];
    if (!b) continue;
    const t = document.createElement("div");
    t.innerHTML = `<div class="bt-title">${name}</div>
      <table><thead><tr><th></th><th>최종자산</th><th>수익률</th><th>연복리</th><th>최대낙폭</th><th>매매</th><th>투자비중</th></tr></thead>
      <tbody>
        <tr><td>전략</td><td>$${fmtNum(b.strategy.final)}</td>
          <td class="${cls(b.strategy.returnPct)}">${pct(b.strategy.returnPct)}</td>
          <td class="${cls(b.strategy.cagrPct)}">${pct(b.strategy.cagrPct)}</td>
          <td class="neg">-${b.strategy.maxDrawdownPct}%</td>
          <td>${b.strategy.trades}</td><td>${b.strategy.timeInMarketPct}%</td></tr>
        <tr><td>단순보유</td><td>$${fmtNum(b.buyHold.final)}</td>
          <td class="${cls(b.buyHold.returnPct)}">${pct(b.buyHold.returnPct)}</td>
          <td class="${cls(b.buyHold.cagrPct)}">${pct(b.buyHold.cagrPct)}</td>
          <td class="neg">-${b.buyHold.maxDrawdownPct}%</td>
          <td>1</td><td>100%</td></tr>
      </tbody></table>`;
    box.appendChild(t);
  }
}
