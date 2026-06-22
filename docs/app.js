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

// plain-language explanation of each indicator
const INDDESC = {
  fng: "CNN이 아래 7개를 합쳐 만든 0~100 점수예요. 0에 가까우면 다들 패닉(극도의 공포), 100에 가까우면 다들 들떠 있음(극도의 탐욕).",
  momentum: "S&P500이 자기 평균선(최근 125일)보다 얼마나 위/아래에 있는지. 위로 멀수록 상승 분위기(탐욕), 아래로 가면 침체(공포).",
  strength: "신고가를 찍는 종목 vs 신저가를 찍는 종목 수. 신고가가 많을수록 시장이 튼튼하다는 뜻(탐욕).",
  breadth: "오르는 종목들의 거래량 vs 내리는 종목들의 거래량. 폭넓게 오르면 탐욕, 소수만 끌고 가면 공포.",
  putcall: "하락에 거는 돈(풋) vs 상승에 거는 돈(콜)의 비율. 풋이 많아질수록 다들 겁먹었다는 신호(공포).",
  volatility: "흔히 '공포지수'라 부르는 VIX. 값이 높을수록 시장이 출렁이고 불안하다는 뜻(공포).",
  safehaven: "최근 20일간 주식 수익에서 채권 수익을 뺀 값. 주식이 채권보다 많이 빠지면 다들 안전한 채권으로 도망친 것(공포).",
  junkbond: "위험한 회사채(정크본드)와 안전한 채권의 금리 차이. 이 차이가 벌어질수록 위험을 피하려는 분위기(공포).",
};

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
  renderBuyLevels();
  renderStrategy();
  renderSensitivity();
  renderScaled();
  renderWalkForward();
  renderDCA();
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
  const desc = INDDESC[currentInd] ? `<br><span class='muted small'>${INDDESC[currentInd]}</span>` : "";
  $("indInfo").innerHTML = `<b>${ind.label}</b><br>${nowVal} (${ratingKo(ind.currentRating)}) · ${dirTxt}${desc}`
    + (normalized ? "" : "<br><span class='muted small'>※ 이 지표는 원시값을 그대로 보여줘요(0~100 점수 아님). 공포/탐욕 음영과 ▲▼ 신호는 '종합' 지수에서만 표시됩니다.</span>");

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
  $("anNote").innerHTML =
    `각 지표가 <b>"공포"를 가리킬 때</b>, 그 뒤 1주·1달·3달 동안 주가가 <b>실제로 올랐는지</b> 따져본 거예요. `
    + `한마디로 "이 지표가 겁먹으라고 할 때 사두면 정말 이득이었나?"를 점수로 매긴 겁니다.`;
  $("anFoot").innerHTML =
    `읽는 법: 숫자는 −1~+1 사이. <b>+(초록)가 클수록</b> "공포일 때 사두면 이후 올랐다" → 쓸모 있는 지표예요. `
    + `<b>0이면</b> 별 관계 없음, <b>−(빨강)면</b> 오히려 반대(공포가 더 깊어지는 쪽). 대략 0.2 넘으면 약하게나마 의미 있는 편입니다. `
    + `<span class="muted">단, 설명용 통계라 실제보다 부풀려 보일 수 있어요(표본 약 5년).</span>`;

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

function renderBuyLevels() {
  const b = DATA.buyLevels;
  if (!b) return;
  $("blNote").innerHTML =
    `풋/콜은 위 랭킹에서 <b>미래 수익과 가장 잘 맞았던 지표</b>예요(특히 3달 뒤). `
    + `그래서 "백분위" 같은 추상적인 말 대신 <b>실제 풋/콜 수치 얼마부터 사면 좋았나</b>를 전 기간으로 따져봤습니다. `
    + `'아무 때나'(전체 평균)보다 <b>수익도 높고 승률(이긴 비율)도 높을수록</b> 그 수치가 진짜 '줍줍' 구간이에요.`;

  // forward-return cell: mean% (big) + win-rate (small), green tint by mean
  const cell = (s) => {
    if (!s) return `<td>—</td>`;
    const mag = Math.min(Math.max(s.meanPct, 0) / 10, 1);
    const bg = `rgba(46,204,113,${(mag * 0.5).toFixed(2)})`;
    return `<td style="background:${bg}"><b>${pct(s.meanPct)}</b><br><span class="muted small">승률 ${s.hitPct.toFixed(0)}%</span></td>`;
  };

  const head = `<tr><th>매수 기준</th><th>해당 빈도</th>
    <th>VOO 1달</th><th>VOO 3달</th><th>TQQQ 1달</th><th>TQQQ 3달</th></tr>`;
  const baseRow = `<tr style="opacity:.85">
    <td>아무 때나 <span class="muted small">(기준)</span></td>
    <td class="muted small">전체</td>
    ${cell(b.baseline.voo.m)}${cell(b.baseline.voo.q)}${cell(b.baseline.tqqq.m)}${cell(b.baseline.tqqq.q)}</tr>`;
  const rows = b.rows.map((r) => {
    const topPct = Math.round(100 - r.pctl); // "top X% most fearful"
    const strong = r.threshold === b.strongThreshold;
    return `<tr style="${strong ? "outline:1px solid rgba(46,204,113,.45)" : ""}">
      <td><b>풋/콜 ≥ ${r.threshold.toFixed(2)}</b>${strong ? " ⭐" : ""}</td>
      <td class="muted small">${r.days}일<br>(상위 ${topPct}%)</td>
      ${cell(r.voo.m)}${cell(r.voo.q)}${cell(r.tqqq.m)}${cell(r.tqqq.q)}</tr>`;
  }).join("");
  $("buylevels").innerHTML = `<div class="scrolltable"><table class="rank">${head}${baseRow}${rows}</table></div>`
    + `<p class="muted small" style="margin-top:8px">셀 = 그 수치일 때 산 뒤 평균 수익, 아래 작은 글씨 = 이긴 비율(승률). 위로 갈수록(풋/콜이 높을수록) 다들 겁먹은 상태 → 역사적으로 그 뒤 더 잘 올랐어요. ⭐ = 승률이 확 높아지는 분기점.</p>`;

  // current value callout
  const cur = b.current;
  const st = b.strongThreshold;
  const where = cur == null ? "" :
    cur >= 1.0 ? `<span class="dir fear">아주 깊은 공포 — 역사적으로 '거의 안 졌던' 구간</span>이에요.`
    : cur >= (st ?? 0.9) ? `<span class="dir fear">유리한 매수 구간(≥${(st ?? 0.9).toFixed(2)})</span>에 들어와 있어요.`
    : cur >= 0.80 ? `약한 공포예요. 더 확실히 사려면 <b>${(st ?? 0.9).toFixed(2)} 이상</b>을 기다려볼 만합니다.`
    : `평범하거나 탐욕 쪽이에요. 풋/콜만 보면 <b>아직 줍줍 타이밍은 아님</b> — ${(st ?? 0.9).toFixed(2)} 이상에서 빛났어요.`;
  $("blNow").innerHTML = `<b>지금 풋/콜 = <span class="now">${fmtVal(cur)}</span></b> (전 기간 ${b.min}~${b.max}). ${where}`;

  // verdict
  const strongRow = b.rows.find((r) => r.threshold === st);
  $("blVerdict").innerHTML = st && strongRow
    ? `<b>결론:</b> 풋/콜이 <b>${st.toFixed(2)}을 넘으면</b> 3달 뒤 VOO가 평균 <b>${pct(strongRow.voo.q.meanPct)}</b> (승률 <b>${strongRow.voo.q.hitPct.toFixed(0)}%</b>), `
      + `TQQQ는 <b>${pct(strongRow.tqqq.q.meanPct)}</b>로 — '아무 때나'(VOO ${pct(b.baseline.voo.q.meanPct)})보다 확실히 좋았어요. `
      + `<b>1.00을 넘으면</b> 표본은 적지만 승률이 거의 100%에 가깝습니다. `
      + `<span class="muted">즉 "풋이 콜보다 많아질수록(공포가 깊을수록) 더 공격적으로 사라"가 과거엔 잘 통했어요. 단 표본이 최근 ~5년이라 다음 폭락장에선 다를 수 있습니다.</span>`
    : `풋/콜 수치가 높을수록 이후 수익이 좋아지는 경향이 있어요.`;

  // ---- action playbook: tiers by raw put/call, highlight current tier ----
  $("blStratNote").innerHTML =
    `핵심 아이디어: <b>평소엔 매달 정해진 금액만 사고, 그와 별도로 "예비 현금"을 모아둡니다.</b> `
    + `그러다 풋/콜이 아래 단계에 들어오면 그 현금을 단계에 맞게 투입하는 거예요 — <b>공포가 깊을수록 더 크게.</b> `
    + `(파는 건 이 지표가 아니라 위쪽 '탐욕 ${DATA.config.sellThreshold} 지속' 규칙으로 판단)`;

  const tiers = [
    { lo: 0, hi: 0.80, name: "평상시", tag: "평소대로", cls: "t-calm",
      action: "추가 매수 없이 <b>정해둔 적립(매달 같은 금액)만</b> 유지. 현금은 다음 공포를 위해 계속 모아둡니다." },
    { lo: 0.80, hi: 0.90, name: "약한 공포", tag: "조금 더", cls: "t-mild",
      action: "예비 현금의 <b>약 1/3</b>을 추가 투입. 아직 확신 구간은 아니라 가볍게 발만 담급니다." },
    { lo: 0.90, hi: 1.00, name: "강한 공포 ⭐", tag: "적극 매수", cls: "t-strong",
      action: "예비 현금의 <b>절반~2/3</b>를 투입. 과거 3달 뒤 승률이 확 올라간(≈89%) <b>핵심 줍줍 구간</b>이에요." },
    { lo: 1.00, hi: 99, name: "극단적 공포", tag: "최대 매수", cls: "t-max",
      action: "<b>남은 현금을 거의 전부</b>, 단 한 번에 말고 <b>며칠에 나눠</b> 투입. 표본은 적지만 이후 거의 항상 반등했어요(승률 ≈95%)." },
  ];
  const inTier = (t) => cur != null && cur >= t.lo && cur < t.hi;
  $("blStrategy").innerHTML = tiers.map((t) => {
    const here = inTier(t);
    const range = t.hi >= 99 ? `≥ ${t.lo.toFixed(2)}` : `${t.lo === 0 ? "< " + t.hi.toFixed(2) : t.lo.toFixed(2) + " ~ " + t.hi.toFixed(2)}`;
    return `<div class="tier ${t.cls}${here ? " active" : ""}">
      <div class="tier-head"><span class="tier-range">풋/콜 ${range}</span>
        <span class="tier-tag">${t.tag}</span>${here ? `<span class="tier-now">지금 여기 (${fmtVal(cur)})</span>` : ""}</div>
      <div class="tier-name">${t.name}</div>
      <div class="tier-action">${t.action}</div></div>`;
  }).join("")
    + `<p class="muted small" style="margin-top:10px">※ 투입 비율(1/3, 1/2 등)은 과거 데이터에 기반한 <b>예시 가이드</b>일 뿐 정답이 아니에요. 핵심 원칙은 <b>"공포가 깊을수록 더 공격적으로, 한 번에 말고 나눠서"</b>. 표본이 최근 약 5년이라 큰 폭락장에선 결과가 달라질 수 있습니다.</p>`;
}

function renderStrategy() {
  const st = DATA.strategyTest;
  if (!st) return;
  $("stNote").innerHTML =
    `각 지표로 <b>실제로 사고팔았다면</b> 어땠을지 5년치로 돌려본 결과예요. `
    + `규칙은 "최근 1년 기준 가장 공포스러운 축(상위 15%)에 들어가면 사고, 가장 탐욕스러울 때(하위 15%)가 한동안 이어지면 판다". `
    + `<b>맨 윗줄 ⭐가 과거 기준 1등</b>, <b>'단순보유(기준)'가 넘어야 할 선</b>이에요.`;
  $("stFoot").innerHTML =
    `초록 테두리 = 단순보유보다 효율(Calmar)이 좋았던 전략. `
    + `<span class="muted">주의: 🧩복합 신호는 같은 데이터를 보고 고른 거라 실제보다 좋아 보일 수 있어요. 그리고 이건 "과거에 그랬다"는 얘기지 미래 보장은 아닙니다 — 아래 '워크포워드'에서 진짜 검증해요.</span>`;

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
  $("seNote").innerHTML =
    `위에서 1등이 <b>진짜 실력인지 운인지</b> 확인하는 표예요. 매수 기준(공포 상위 몇 %)을 10%부터 30%까지 바꿔보면서 점수가 어떻게 변하나 봅니다. `
    + `<b>어느 칸에서도 점수가 고르게 높으면 진짜 실력</b>, 딱 한 칸만 튀고 나머지는 별로면 "운빨(과최적화)"이에요. `
    + `<span class="muted">셀 = VOO의 Calmar, 괄호 = TQQQ.</span>`;
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
  $("scNote").innerHTML =
    `전 재산을 한 번에 넣었다 빼는(<b>전량</b>) 대신, <b>공포가 깊을수록 조금씩 더 사는(분할)</b> 방식이 나은지 비교해요. `
    + `여기선 "별로 안 무서우면 현금, 아주 무서우면 100%, 그 사이는 비례해서" 매일 조금씩 조절합니다. `
    + `<span class="muted">숫자 = Calmar.</span>`;
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
  $("wfNote").innerHTML =
    `<b>가장 정직한 검증이에요.</b> 위 표들은 "지난 5년 시험지를 다 펴놓고 제일 잘 맞는 답을 고른 것"이라 당연히 좋아 보입니다. `
    + `여기선 그렇게 안 해요 — <b>앞 2년만 보고 규칙을 정한 뒤, 한 번도 안 본 다음 구간에 그대로 적용</b>하고, 6개월마다 이걸 반복합니다. `
    + `즉 <b>"실제로 그때그때 굴렸으면 미래에 통했을까?"</b>를 봅니다. 여기서도 단순보유를 이겨야 진짜죠.`;

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

  // plain verdict + which indicator the auto-picker chose each period
  const beatList = w.perIndicator.filter((r) => r.oosVoo && r.oosVoo.calmar >= bv.calmar).map((r) => r.label);
  const verdict = beatList.length
    ? `<b>평결:</b> 위험조정(Calmar) 기준으로 단순보유를 넘은 건 <b>${beatList.join(", ")}</b> 정도뿐이고, 그마저 <b>총수익은 단순보유보다 적었어요</b>. 즉 "더 안전했지만 덜 벌었다". 이 강세장 구간에선 그냥 보유가 사실상 최강이었습니다.`
    : `<b>평결:</b> 이 검증 구간에선 <b>어떤 전략도 '그냥 보유'를 뚜렷이 이기지 못했어요.</b> 강세장에선 현금 들고 기다리는 시간이 곧 손해라서요.`;
  const caveat = ` <span class="muted">참고: 이 구간(2023~)엔 큰 폭락이 없어서, 공포 신호 같은 방어 전략이 진짜 빛나는 '폭락 회피' 기회 자체가 없었어요. 다음 폭락장에선 결론이 또 달라질 수 있습니다.</span>`;
  const picks = a.picks.map((p) => `${p.from.slice(0, 7)} → ${({ safehaven: "안전자산", combo: "복합", fng: "종합", putcall: "풋/콜", momentum: "모멘텀" })[p.key] || p.key}(상위 ${Math.round(p.X * 100)}%)`).join("  ·  ");
  $("wfPicks").innerHTML = `<div class="verdict">${verdict}${caveat}</div><b>참고 — 자동선택이 매 구간 고른 지표:</b> ${picks}`;
}

function renderDCA() {
  const x = DATA.dca;
  if (!x) return;
  const won = `$${x.contributed.toLocaleString()}`;
  $("dcaNote").innerHTML =
    `대부분의 사람이 실제로 하는 방식이에요: <b>매달 $${x.monthly.toLocaleString()}씩 ${x.months}개월 꾸준히 투자</b>(총 ${won}). `
    + `여기에 "<b>매달 ${Math.round(x.saveFraction * 100)}%는 안 쓰고 모아뒀다가, 진짜 공포가 오면(상위 ${Math.round(x.dipPercentile * 100)}%) 한 번에 몰아넣기</b>"를 더하면 더 나은지 봅니다. `
    + `<b>투입한 총액은 네 방식 모두 똑같아요</b> — 타이밍만 다릅니다. (IRR = 연환산 수익률)`;

  const money = (v) => `$${v.toLocaleString()}`;
  const best = { voo: Math.max(...x.rows.map((r) => r.voo.finalValue)), tqqq: Math.max(...x.rows.map((r) => r.tqqq.finalValue)) };
  const head = `<tr><th>방식</th>
    <th>VOO 최종</th><th>VOO 수익</th><th>VOO IRR</th><th>VOO MDD</th>
    <th>TQQQ 최종</th><th>TQQQ IRR</th><th>TQQQ MDD</th></tr>`;
  const body = x.rows.map((r) => {
    const bv = r.voo.finalValue === best.voo, bt = r.tqqq.finalValue === best.tqqq;
    return `<tr>
      <td>${r.label}${r.key === "plain" ? " <span class='muted small'>(기준)</span>" : ""}</td>
      <td style="${bv ? "font-weight:700;color:var(--buy)" : ""}">${money(r.voo.finalValue)}</td>
      <td class="${cls(r.voo.gainPct)}">${pct(r.voo.gainPct)}</td>
      <td>${r.voo.irrPct}%</td><td class="neg">-${r.voo.maxDrawdownPct}%</td>
      <td style="${bt ? "font-weight:700;color:var(--buy)" : ""}">${money(r.tqqq.finalValue)}</td>
      <td>${r.tqqq.irrPct}%</td><td class="neg">-${r.tqqq.maxDrawdownPct}%</td></tr>`;
  }).join("");
  $("dca").innerHTML = `<div class="scrolltable"><table class="rank">${head}${body}</table></div>`;

  // verdict: did fear-timing meaningfully beat plain DCA?
  const plain = x.rows.find((r) => r.key === "plain");
  const others = x.rows.filter((r) => r.key !== "plain");
  const bestOtherVoo = Math.max(...others.map((r) => r.voo.gainPct));
  const bestOtherTqqq = Math.max(...others.map((r) => r.tqqq.gainPct));
  const dVoo = (bestOtherVoo - plain.voo.gainPct).toFixed(1);
  const dTqqq = (bestOtherTqqq - plain.tqqq.gainPct).toFixed(1);
  const tiny = Math.abs(bestOtherVoo - plain.voo.gainPct) < 3 && Math.abs(bestOtherTqqq - plain.tqqq.gainPct) < 8;
  const el = $("dcaVerdict");
  el.style.display = "block";
  el.innerHTML = tiny
    ? `<b>평결: 거의 차이가 없어요.</b> 공포 타이밍을 더해도 가장 좋은 경우가 순수 적립식보다 VOO ${dVoo}p, TQQQ ${dTqqq}p 차이 — 사실상 오차 범위입니다. `
      + `<b>그냥 매달 꾸준히 사는 것</b>이, 현금을 들고 공포를 기다리는 것만큼(혹은 그 이상) 좋았다는 뜻이에요. 게다가 적립식이 훨씬 마음 편하고 단순하죠. `
      + `<span class="muted">단, 이 기간엔 깊은 폭락이 드물었어요. 큰 폭락장이 오면 '현금 모아뒀다 줍줍'이 더 빛날 수 있습니다.</span>`
    : `공포매수가 순수 적립식보다 VOO ${dVoo}p, TQQQ ${dTqqq}p 더 나았어요. 다만 그만큼 현금을 들고 기다리는 인내가 필요합니다.`;
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
      <div class="scrolltable"><table class="bt"><thead><tr><th></th><th>최종자산</th><th>수익률</th><th>연복리</th><th>최대낙폭</th><th>매매</th><th>투자비중</th></tr></thead>
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
      </tbody></table></div>`;
    box.appendChild(t);
  }
}
