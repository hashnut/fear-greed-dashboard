/* Renders the dashboard from data.json. */
const COLORS = {
  voo: "#5b8def", tqqq: "#c779e0", fng: "#f0b429",
  buy: "#2ecc71", sell: "#e74c3c", grid: "rgba(255,255,255,0.06)",
  fearZone: "rgba(46,204,113,0.10)", greedZone: "rgba(231,76,60,0.10)",
};

let DATA = null;
const charts = {};
let currentDays = 365;
let currentInd = "fng";
let IND = {}; // key -> indicator meta

const $ = (id) => document.getElementById(id);
const fmtNum = (n, d = 0) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const fmtVal = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 }));
const pct = (n) => (n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(1) + "%");
const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
const ratingKo = (r) => ({ "extreme fear": "극도의 공포", fear: "공포", neutral: "중립", greed: "탐욕", "extreme greed": "극도의 탐욕" })[r] || (r ?? "—");

init();

async function init() {
  try {
    const res = await fetch("data.json?_=" + Date.now()); // bust cache so phone sees fresh data
    DATA = await res.json();
  } catch (e) {
    $("status").textContent = "데이터를 불러오지 못했습니다: " + e.message;
    return;
  }
  for (const i of DATA.indicators) IND[i.key] = i;
  const hash = location.hash.replace("#", "");
  if (IND[hash]) currentInd = hash;
  renderHeader();
  renderAnalysis();
  renderStrategy();
  renderSensitivity();
  renderScaled();
  renderWalkForward();
  renderBacktest();
  buildIndicatorButtons();
  buildChart("chartVoo", "voo", "VOO", COLORS.voo);
  buildChart("chartTqqq", "tqqq", "TQQQ", COLORS.tqqq);
  render();

  $("ranges").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    document.querySelectorAll("#ranges button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    currentDays = Number(b.dataset.days);
    render();
  });
  $("indicators").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    document.querySelectorAll("#indicators button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    currentInd = b.dataset.key;
    history.replaceState(null, "", "#" + currentInd);
    render();
  });
}

function renderHeader() {
  const c = DATA.fngCurrent || {};
  const cfg = DATA.config;
  $("updated").textContent = "업데이트: " + new Date(DATA.updated).toLocaleString("ko-KR");
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

function buildIndicatorButtons() {
  const short = {
    fng: "종합", momentum: "모멘텀", strength: "강도", breadth: "폭",
    putcall: "풋/콜", volatility: "변동성", safehaven: "안전자산", junkbond: "정크본드",
  };
  const box = $("indicators");
  box.innerHTML = "";
  for (const i of DATA.indicators) {
    const b = document.createElement("button");
    b.dataset.key = i.key;
    b.textContent = short[i.key] || i.key;
    if (i.key === currentInd) b.classList.add("active");
    box.appendChild(b);
  }
}

function buildChart(canvasId, priceKey, label, color) {
  const ctx = $(canvasId).getContext("2d");
  const cfg = DATA.config;
  charts[canvasId] = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        { label, yAxisID: "price", borderColor: color, backgroundColor: color,
          borderWidth: 2, pointRadius: 0, tension: 0.1, spanGaps: true, data: [], order: 2 },
        { label: "지표", yAxisID: "ind", borderColor: COLORS.fng, backgroundColor: COLORS.fng,
          borderWidth: 1.5, pointRadius: 0, tension: 0.1, spanGaps: true, data: [], order: 3 },
        { label: "매수신호", yAxisID: "price", type: "scatter", data: [],
          borderColor: COLORS.buy, backgroundColor: COLORS.buy, pointStyle: "triangle", pointRadius: 7, pointHoverRadius: 9, order: 1 },
        { label: "매도신호", yAxisID: "price", type: "scatter", data: [],
          borderColor: COLORS.sell, backgroundColor: COLORS.sell, pointStyle: "triangle", rotation: 180, pointRadius: 7, pointHoverRadius: 9, order: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "time", time: { tooltipFormat: "yyyy-MM-dd" },
             grid: { color: COLORS.grid }, ticks: { color: "#9aa0aa", maxRotation: 0, autoSkipPadding: 24 } },
        price: { position: "left", grid: { color: COLORS.grid }, ticks: { color: color, callback: (v) => "$" + v } },
        ind: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: COLORS.fng, callback: (v) => fmtVal(v) } },
      },
      plugins: {
        legend: { labels: { color: "#e8eaed", boxWidth: 12, usePointStyle: true } },
        tooltip: { callbacks: {
          label: (i) => {
            if (i.dataset.yAxisID === "ind") return `${i.dataset.label}: ${fmtVal(i.parsed.y)}`;
            const v = i.parsed.y;
            return `${i.dataset.label}: ${v == null ? "—" : "$" + v.toFixed(2)}`;
          },
        } },
        annotation: { annotations: {
          fearBox: { type: "box", yScaleID: "ind", yMin: 0, yMax: cfg.buyThreshold, backgroundColor: COLORS.fearZone, borderWidth: 0, display: true },
          greedBox: { type: "box", yScaleID: "ind", yMin: cfg.sellThreshold, yMax: 100, backgroundColor: COLORS.greedZone, borderWidth: 0, display: true },
          buyLine: { type: "line", yScaleID: "ind", yMin: cfg.buyThreshold, yMax: cfg.buyThreshold, borderColor: "rgba(46,204,113,0.5)", borderWidth: 1, borderDash: [4, 4], display: true },
          sellLine: { type: "line", yScaleID: "ind", yMin: cfg.sellThreshold, yMax: cfg.sellThreshold, borderColor: "rgba(231,76,60,0.5)", borderWidth: 1, borderDash: [4, 4], display: true },
        } },
      },
    },
  });
}

function render() {
  const ind = IND[currentInd];
  const normalized = !!ind.normalized;

  // indicator info line
  const dirGreed = ind.direction === "greedUp";
  const dirTxt = dirGreed ? "값이 <span class='dir greed'>높을수록 ▲ 탐욕(과열)</span>" : "값이 <span class='dir fear'>높을수록 ▼ 공포(과매도)</span>";
  const nowVal = normalized ? `지수 <span class='now'>${ind.currentScore}</span>` : `현재값 <span class='now'>${fmtVal(ind.currentValue)}</span> · 지표점수 ${ind.currentScore}`;
  $("indInfo").innerHTML = `<b>${ind.label}</b><br>${nowVal} (${ratingKo(ind.currentRating)}) · ${dirTxt}`
    + (normalized ? "" : "<br><span class='muted small'>원시값을 자체 축에 표시(0~100 점수 아님). 초록/빨강 음영·임계선은 종합지수에만 적용됩니다.</span>");

  $("hVoo").textContent = `VOO  vs  ${ind.label}`;
  $("hTqqq").textContent = `TQQQ  vs  ${ind.label}`;

  // filter by range
  const series = DATA.series;
  let rows = series;
  if (currentDays > 0) {
    const cutoff = new Date(series[series.length - 1].date);
    cutoff.setDate(cutoff.getDate() - currentDays);
    const cutStr = cutoff.toISOString().slice(0, 10);
    rows = series.filter((r) => r.date >= cutStr);
  }
  const first = rows[0]?.date, last = rows[rows.length - 1]?.date;
  const indLabel = ind.label + (normalized ? "" : dirGreed ? "  (↑탐욕)" : "  (↑공포)");

  for (const [canvasId, priceKey] of [["chartVoo", "voo"], ["chartTqqq", "tqqq"]]) {
    const ch = charts[canvasId];
    ch.data.datasets[0].data = rows.filter((r) => r[priceKey] != null).map((r) => ({ x: r.date, y: r[priceKey] }));
    ch.data.datasets[1].data = rows.filter((r) => r[currentInd] != null).map((r) => ({ x: r.date, y: r[currentInd] }));
    ch.data.datasets[1].label = indLabel;
    ch.data.datasets[2].data = DATA.signals.buys.filter((b) => b[priceKey] != null && b.date >= first && b.date <= last).map((b) => ({ x: b.date, y: b[priceKey] }));
    ch.data.datasets[3].data = DATA.signals.sells.filter((s) => s[priceKey] != null && s.date >= first && s.date <= last).map((s) => ({ x: s.date, y: s[priceKey] }));

    // indicator axis: fixed 0-100 for the normalized overall index, auto for raw components
    ch.options.scales.ind.min = normalized ? 0 : undefined;
    ch.options.scales.ind.max = normalized ? 100 : undefined;
    const ann = ch.options.plugins.annotation.annotations;
    for (const k of ["fearBox", "greedBox", "buyLine", "sellLine"]) ann[k].display = normalized;

    ch.update("none");
  }
}

function renderAnalysis() {
  const a = DATA.analysis;
  if (!a) return;
  $("anNote").textContent = a.note;
  $("anFoot").innerHTML =
    `읽는 법: 숫자는 상관계수(−1~+1). <b>양수가 클수록</b> "그 지표가 공포를 가리킬 때 이후 가격이 올랐다"는 뜻 → 역발상 매수에 의미 있는 지표. `
    + `<b>음수</b>면 반대(추세 지속 쪽). 0.2 이상이면 약하게나마 의미 있는 편. `
    + `<span class="muted">(설명용 통계 · 구간 중첩으로 과대평가 가능 · n≈${a.rows[0]?.n ?? "?"})</span>`;

  const H = a.horizons; // [{k,label,days}]
  const head = `<tr><th>지표</th><th>방향</th><th>종합</th>`
    + H.map((h) => `<th>VOO ${h.label}</th>`).join("")
    + H.map((h) => `<th>TQQQ ${h.label}</th>`).join("") + `</tr>`;

  const cell = (v) => {
    if (v == null) return `<td>—</td>`;
    const mag = Math.min(Math.abs(v) / 0.35, 1);
    const bg = v >= 0 ? `rgba(46,204,113,${(mag * 0.5).toFixed(2)})` : `rgba(231,76,60,${(mag * 0.5).toFixed(2)})`;
    return `<td style="background:${bg}">${v > 0 ? "+" : ""}${v.toFixed(2)}</td>`;
  };

  const body = a.rows.map((r, idx) => {
    const meta = IND[r.key] || { label: r.key, direction: "" };
    const dir = meta.direction === "fearUp" ? "↑공포" : "↑탐욕";
    const star = idx === 0 ? " ⭐" : "";
    return `<tr>
      <td>${meta.label}${star}</td>
      <td class="muted small">${dir}</td>
      <td style="font-weight:700;background:${r.composite >= 0 ? `rgba(46,204,113,${Math.min(Math.abs(r.composite) / 0.35, 1) * 0.55})` : `rgba(231,76,60,${Math.min(Math.abs(r.composite) / 0.35, 1) * 0.55})`}">${r.composite > 0 ? "+" : ""}${r.composite == null ? "—" : r.composite.toFixed(2)}</td>
      ${H.map((h) => cell(r.corr.voo[h.k])).join("")}
      ${H.map((h) => cell(r.corr.tqqq[h.k])).join("")}
    </tr>`;
  }).join("");

  $("ranking").innerHTML = `<div class="scrolltable"><table class="rank">${head}${body}</table></div>`;
}

function renderStrategy() {
  const st = DATA.strategyTest;
  if (!st) return;
  $("stNote").textContent = st.note;
  $("stFoot").innerHTML =
    `Calmar = 수익률 ÷ 최대낙폭 (클수록 효율적). <b>단순보유보다 Calmar가 높으면</b> 그 신호로 타이밍 잡는 게 의미 있었다는 뜻. `
    + `<span class="muted">주의: 복합 신호는 같은 데이터로 고른 거라 과최적화 가능 · 백분위 전략은 첫 1년은 신호 없음(워밍업) · 과거 성과가 미래를 보장하지 않음.</span>`;

  const calCell = (c) => {
    if (c == null) return `<td>—</td>`;
    const mag = Math.min(Math.abs(c) / 5, 1);
    const bg = c >= 0 ? `rgba(46,204,113,${(mag * 0.55).toFixed(2)})` : `rgba(231,76,60,${(mag * 0.55).toFixed(2)})`;
    return `<td style="background:${bg};font-weight:700">${c.toFixed(2)}</td>`;
  };
  const ret = (s) => `<td class="${cls(s.returnPct)}">${pct(s.returnPct)}</td>`;
  const mdd = (s) => `<td class="neg">-${s.maxDrawdownPct}%</td>`;

  const baseline = st.rows.find((r) => r.key === "buyhold")?.voo.calmar ?? 0;
  const head = `<tr><th>전략</th>
    <th>VOO 수익</th><th>VOO MDD</th><th>VOO Calmar</th>
    <th>TQQQ 수익</th><th>TQQQ MDD</th><th>TQQQ Calmar</th>
    <th>매매</th><th>투자%</th></tr>`;
  const body = st.rows.map((r, idx) => {
    const tag = r.key === "buyhold" ? " <span class='muted small'>(기준)</span>"
      : r.key === "fng_fixed" ? " <span class='muted small'>(현재규칙)</span>"
      : r.key === "combo" ? " 🧩" : "";
    const star = idx === 0 ? " ⭐" : "";
    const beat = r.key !== "buyhold" && r.voo.calmar != null && r.voo.calmar > baseline;
    return `<tr style="${beat ? "outline:1px solid rgba(46,204,113,.25)" : ""}">
      <td>${r.label}${star}${tag}</td>
      ${ret(r.voo)}${mdd(r.voo)}${calCell(r.voo.calmar)}
      ${ret(r.tqqq)}${mdd(r.tqqq)}${calCell(r.tqqq.calmar)}
      <td>${r.voo.trades}</td><td>${r.voo.timeInMarketPct}%</td></tr>`;
  }).join("");

  $("strategy").innerHTML = `<div class="scrolltable"><table class="rank">${head}${body}</table></div>`;
}

function calmarCell(c, scale = 5, bold = true) {
  if (c == null) return `<td>—</td>`;
  const mag = Math.min(Math.abs(c) / scale, 1);
  const bg = c >= 0 ? `rgba(46,204,113,${(mag * 0.55).toFixed(2)})` : `rgba(231,76,60,${(mag * 0.55).toFixed(2)})`;
  return `<td style="background:${bg};${bold ? "font-weight:700" : ""}">${c.toFixed(2)}</td>`;
}

function renderSensitivity() {
  const se = DATA.sensitivity;
  if (!se) return;
  $("seNote").textContent = se.note;
  const cols = se.grid.map((x) => `공포 상위 ${Math.round(x * 100)}%`);
  const head = `<tr><th>전략</th>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>`;
  const body = se.rows.map((r) => {
    const cells = r.voo.map((v, i) => {
      const t = r.tqqq[i];
      if (v == null) return `<td>—</td>`;
      const mag = Math.min(Math.abs(v) / 5, 1);
      const bg = v >= 0 ? `rgba(46,204,113,${(mag * 0.55).toFixed(2)})` : `rgba(231,76,60,${(mag * 0.55).toFixed(2)})`;
      return `<td style="background:${bg}"><b>${v.toFixed(2)}</b><br><span class="muted small">(${t == null ? "—" : t.toFixed(2)})</span></td>`;
    }).join("");
    return `<tr><td>${r.label}</td>${cells}</tr>`;
  }).join("");
  $("sensitivity").innerHTML = `<div class="scrolltable"><table class="rank">${head}${body}</table></div>`;
}

function renderScaled() {
  const sc = DATA.scaled;
  if (!sc) return;
  $("scNote").textContent = sc.note;
  const head = `<tr><th>전략</th>
    <th>VOO 전량</th><th>VOO 분할</th>
    <th>TQQQ 전량</th><th>TQQQ 분할</th><th>분할 평균노출</th></tr>`;
  const body = sc.rows.map((r) => {
    const better = (a, s) => s?.calmar != null && a?.calmar != null && s.calmar > a.calmar;
    const mark = (s, win) => {
      const cell = calmarCell(s?.calmar);
      return win ? cell.replace("<td", "<td title='분할이 더 우수' ").replace(">", " ✅>") : cell;
    };
    return `<tr>
      <td>${r.label}</td>
      ${calmarCell(r.allin.voo.calmar)}
      ${mark(r.scaled.voo, better(r.allin.voo, r.scaled.voo))}
      ${calmarCell(r.allin.tqqq.calmar)}
      ${mark(r.scaled.tqqq, better(r.allin.tqqq, r.scaled.tqqq))}
      <td class="muted">${r.scaled.voo?.avgExposurePct ?? "—"}%</td></tr>`;
  }).join("");
  $("scaled").innerHTML = `<div class="scrolltable"><table class="rank">${head}${body}</table>`
    + `<p class="muted small" style="margin-top:8px">숫자 = Calmar(수익÷MDD). ✅ = 분할이 전량보다 우수. 분할은 평균 노출이 낮아(현금 비중↑) 변동성 큰 TQQQ에서 특히 효율이 좋아지는 경향.</p></div>`;
}

function renderWalkForward() {
  const w = DATA.walkForward;
  if (!w) { return; }
  $("wfNote").textContent = w.note;

  const bv = w.benchmark.voo, bt = w.benchmark.tqqq;
  $("wfBench").innerHTML =
    `<b>이 기간(${w.oosFrom} ~ ${w.oosTo})에 그냥 사서 들고만 있었다면 — 이게 넘어야 할 기준선:</b><br>`
    + `VOO <span class="now">+${bv.returnPct}%</span> · MDD ${bv.maxDrawdownPct}% · Calmar <b>${bv.calmar}</b><br>`
    + `TQQQ <span class="now">+${bt.returnPct}%</span> · MDD ${bt.maxDrawdownPct}% · Calmar <b>${bt.calmar}</b>`;

  const beats = (c, base) => c != null && base != null && c >= base;
  const head = `<tr><th>전략 (검증 구간)</th><th>인샘플 Calmar<br><span class="muted small">(낙관치)</span></th>
    <th>VOO 수익</th><th>VOO MDD</th><th>VOO Calmar</th><th>TQQQ Calmar</th><th>단순보유<br>넘었나(VOO)</th></tr>`;
  const rows = w.perIndicator.map((r) => {
    const ov = r.oosVoo, ot = r.oosTqqq;
    const win = beats(ov?.calmar, bv.calmar);
    return `<tr>
      <td>${r.label}</td>
      <td class="muted">${r.isCalmar ?? "—"}</td>
      <td class="${cls(ov?.returnPct)}">${ov ? pct(ov.returnPct) : "—"}</td>
      <td class="neg">${ov ? "-" + ov.maxDrawdownPct + "%" : "—"}</td>
      ${calmarCell(ov?.calmar)}
      ${calmarCell(ot?.calmar, 15)}
      <td>${win ? "✅ 넘음" : "❌ 못넘음"}</td></tr>`;
  }).join("");
  const a = w.autoPick;
  const autoRow = `<tr style="border-top:2px solid var(--line)">
      <td><b>🤖 자동선택</b><br><span class="muted small">매 구간 1등 지표</span></td>
      <td class="muted">—</td>
      <td class="${cls(a.voo?.returnPct)}">${a.voo ? pct(a.voo.returnPct) : "—"}</td>
      <td class="neg">${a.voo ? "-" + a.voo.maxDrawdownPct + "%" : "—"}</td>
      ${calmarCell(a.voo?.calmar)}
      ${calmarCell(a.tqqq?.calmar, 15)}
      <td>${beats(a.voo?.calmar, bv.calmar) ? "✅ 넘음" : "❌ 못넘음"}</td></tr>`;

  $("walkforward").innerHTML = `<div class="scrolltable"><table class="rank">${head}${rows}${autoRow}</table></div>`;

  // which indicator the auto-picker chose each period
  const picks = a.picks.map((p) => `${p.from.slice(0, 7)} → ${({ safehaven: "안전자산", combo: "복합", fng: "종합", putcall: "풋/콜", momentum: "모멘텀" })[p.key] || p.key}(상위 ${Math.round(p.X * 100)}%)`).join("  ·  ");
  $("wfPicks").innerHTML = `<b>자동선택이 매 구간 고른 지표:</b> ${picks}`;
}

function renderBacktest() {
  const bt = DATA.backtest, cfg = DATA.config;
  $("btRange").textContent = bt.voo ? `(${bt.voo.from} ~ ${bt.voo.to}, ${bt.voo.years}년)` : "";
  $("btRule").textContent =
    `초기자금 $${fmtNum(cfg.initialCash)} · 공포(≤${cfg.buyThreshold}) 진입 시 전액 매수, ` +
    `탐욕(≥${cfg.sellThreshold}) ${cfg.sellSustainDays}일 지속 시 전액 매도. "전략" vs 단순 보유(Buy&Hold) 비교. (종합지수 기준)`;
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
