// NDX 五因子量化定投助手
// 数据源: Yahoo Finance (^NDX 行情, QQQ PE)

const SYMBOL = '%5ENDX';   // ^NDX URL-encoded
const PE_SYMBOL = 'QQQ';   // QQQ ETF 跟踪 NDX, 用其 PE 代表 NDX 估值
const RANGE = '2y';
const INTERVAL = '1d';

// 多通道获取数据，避免 CORS 阻塞
function chartUrls(sym) {
  const direct = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${RANGE}&interval=${INTERVAL}`;
  const direct2 = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?range=${RANGE}&interval=${INTERVAL}`;
  return [
    direct,
    `https://corsproxy.io/?${encodeURIComponent(direct)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(direct2)}`,
  ];
}
function quoteUrls(sym) {
  // v7/finance/quote 包含 trailingPE
  const direct = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}`;
  return [
    direct,
    `https://corsproxy.io/?${encodeURIComponent(direct)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(direct)}`,
  ];
}

const STORE_KEY = 'ndx_dca_settings_v2';
const CACHE_KEY = 'ndx_dca_cache_v2';
const PE_CACHE_KEY = 'ndx_pe_cache_v2';

// 纳指 100 长期平均 PE 约 24（约 2000-2024 年中位数）
const defaults = { baseAmount: 100, currency: 'USD', manualPE: '', avgPE: 24 };
let settings = loadSettings();
let lastFactors = null;
let lastPE = null;

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch { return { ...defaults }; }
}
function saveSettings() {
  localStorage.setItem(STORE_KEY, JSON.stringify(settings));
}

async function tryFetch(urls) {
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('全部端点失败');
}

async function fetchChart() {
  try {
    const data = await tryFetch(chartUrls(SYMBOL));
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error('Empty response');
    const ts = result.timestamp;
    const closes = result.indicators.quote[0].close;
    const highs = result.indicators.quote[0].high;
    const lows = result.indicators.quote[0].low;
    const series = ts.map((t, i) => ({
      t: t * 1000,
      c: closes[i],
      h: highs[i],
      l: lows[i],
    })).filter(d => d.c != null);
    if (series.length < 220) throw new Error('Insufficient data');
    const cached = { series, fetchedAt: Date.now() };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cached)); } catch {}
    return cached;
  } catch (e) {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return { ...JSON.parse(raw), stale: true };
    throw e;
  }
}

async function fetchPE() {
  // 用户手动覆盖优先
  if (settings.manualPE && settings.manualPE > 0) {
    return { pe: parseFloat(settings.manualPE), source: '用户手动输入' };
  }
  try {
    const data = await tryFetch(quoteUrls(PE_SYMBOL));
    const item = data.quoteResponse && data.quoteResponse.result && data.quoteResponse.result[0];
    if (!item) throw new Error('No quote');
    const pe = item.trailingPE;
    if (typeof pe !== 'number' || pe <= 0) throw new Error('No PE field');
    const cached = { pe, source: 'Yahoo Finance · QQQ TTM', fetchedAt: Date.now() };
    try { localStorage.setItem(PE_CACHE_KEY, JSON.stringify(cached)); } catch {}
    return cached;
  } catch (e) {
    const raw = localStorage.getItem(PE_CACHE_KEY);
    if (raw) return { ...JSON.parse(raw), source: '离线缓存' };
    return { pe: null, source: '获取失败 · 可在设置手动输入' };
  }
}

// ---- 指标计算 ----
function sma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}
function realizedVol(closes, n = 20) {
  if (closes.length < n + 1) return null;
  const slice = closes.slice(-n - 1);
  const rets = [];
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

// PE 评分: 当前 PE 越低于历史均值, 分数越高 (越值得加仓)
// 偏离 -25% 以下 → 100, 偏离 +25% 以上 → 0
function peScore(currentPE, avgPE) {
  if (!currentPE || !avgPE) return null;
  const dev = (currentPE - avgPE) / avgPE; // -1 ~ +1
  return clamp(50 - dev * 200, 0, 100);
}
function peAdviceText(currentPE, avgPE) {
  if (!currentPE || !avgPE) return 'PE 数据缺失，参考其他因子';
  const dev = (currentPE - avgPE) / avgPE * 100;
  const pct = dev.toFixed(1);
  if (dev <= -20) return `🔴 PE 显著低估 (${pct}%) · 建议大幅加码`;
  if (dev <= -10) return `🟠 PE 偏低估 (${pct}%) · 建议加大投入`;
  if (dev <= 10)  return `⚪ PE 接近均值 (${pct >= 0 ? '+' : ''}${pct}%) · 按计划定投`;
  if (dev <= 25)  return `🟡 PE 偏高估 (+${pct}%) · 适度减少投入`;
  return `🔴 PE 显著高估 (+${pct}%) · 建议减仓 / 暂停`;
}

// ---- 5 因子打分 (0-100，分高 = 适合多投) ----
function computeFactors(series, peData, avgPE) {
  const closes = series.map(d => d.c);
  const last = closes[closes.length - 1];
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);

  // 因子 1: 估值 = 50% PE偏离 + 50% 价格 vs MA200
  const dev200 = (ma200 - last) / ma200;
  const f1Tech = clamp(50 + dev200 * 250, 0, 100);
  const f1PE = peScore(peData.pe, avgPE);
  const f1 = f1PE != null ? (f1Tech * 0.4 + f1PE * 0.6) : f1Tech;
  const f1Detail = f1PE != null
    ? `PE ${peData.pe.toFixed(1)} vs 均值 ${avgPE.toFixed(1)}（PE 分 ${f1PE.toFixed(0)} · MA200 分 ${f1Tech.toFixed(0)}）`
    : `当前价 ${last.toFixed(0)} vs MA200 ${ma200.toFixed(0)}（偏离 ${(dev200*100).toFixed(2)}%）`;

  // 因子 2: RSI 超卖
  const rsi14 = rsi(closes, 14);
  const f2 = clamp(100 - rsi14, 0, 100);

  // 因子 3: 回撤 (52 周高点)
  const yearSlice = closes.slice(-252);
  const yearHigh = Math.max(...yearSlice);
  const drawdown = (yearHigh - last) / yearHigh;
  const f3 = clamp(drawdown * 250, 0, 100);

  // 因子 4: 波动率 (20日年化)
  const vol = realizedVol(closes, 20);
  const f4 = clamp((vol - 8) / (40 - 8) * 100, 0, 100);

  // 因子 5: 趋势确认 (MA50 vs MA200)
  const trendDev = (ma50 - ma200) / ma200;
  const f5 = clamp(50 + trendDev * 333, 0, 100);

  const composite = (f1 + f2 + f3 + f4 + f5) / 5;

  return {
    last,
    prev: closes[closes.length - 2],
    composite,
    factors: [
      { key: 'value', name: '估值因子 (PE+MA200)', score: f1, detail: f1Detail },
      { key: 'rsi',   name: '超卖因子 (RSI14)',     score: f2, detail: `RSI(14) = ${rsi14.toFixed(1)}` },
      { key: 'dd',    name: '回撤因子 (52周高点)',   score: f3, detail: `距 52 周高 ${yearHigh.toFixed(0)} 回撤 ${(drawdown*100).toFixed(2)}%` },
      { key: 'vol',   name: '波动因子 (20日年化)',   score: f4, detail: `年化波动率 ${vol.toFixed(1)}%` },
      { key: 'trend', name: '趋势因子 (MA50/200)',   score: f5, detail: `MA50 ${ma50.toFixed(0)} vs MA200 ${ma200.toFixed(0)}（差 ${(trendDev*100).toFixed(2)}%）` },
    ],
  };
}

function scoreToMultiplier(score) {
  if (score < 20) return 0.5;
  if (score < 40) return 0.75;
  if (score < 60) return 1.0;
  if (score < 80) return 1.5;
  return 2.0;
}
function scoreToAdvice(score) {
  if (score < 20) return '🟢 市场偏热 · 建议减仓 / 暂停';
  if (score < 40) return '🟡 略偏高位 · 适度减少投入';
  if (score < 60) return '⚪ 中性区间 · 按计划定投';
  if (score < 80) return '🟠 进入恐慌 · 加大投入';
  return '🔴 极度低估 · 重仓加码';
}
function scoreColor(score) {
  if (score < 20) return '#ff453a';
  if (score < 40) return '#ff9f0a';
  if (score < 60) return '#ffd60a';
  if (score < 80) return '#9ee04f';
  return '#30d158';
}

function fmtMoney(usd) {
  if (settings.currency === 'CNY') {
    return '¥' + Math.round(usd * 7.2).toLocaleString('zh-CN');
  }
  return '$' + Math.round(usd).toLocaleString('en-US');
}

function renderPE(peData, avgPE) {
  document.getElementById('peCurrent').textContent = peData.pe ? peData.pe.toFixed(2) : '—';
  document.getElementById('peCurrentSrc').textContent = peData.source || '';
  document.getElementById('peAvg').textContent = avgPE.toFixed(1);

  // 把 PE 偏离映射到 0%~100% 滑条 (-50% → 左端低估, +50% → 右端高估)
  let pos = 50;
  if (peData.pe && avgPE) {
    const dev = (peData.pe - avgPE) / avgPE * 100;
    pos = clamp(50 + dev, 0, 100);
  }
  document.getElementById('peBarFill').style.left = pos + '%';
  document.getElementById('peAdvice').textContent = peAdviceText(peData.pe, avgPE);
}

function render(data, stale = false) {
  const { last, prev, composite, factors } = data;
  lastFactors = data;

  document.getElementById('price').textContent = last.toFixed(2);
  const diff = last - prev;
  const diffPct = (diff / prev) * 100;
  const ch = document.getElementById('change');
  ch.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${diff >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)`;
  ch.className = 'change ' + (diff >= 0 ? 'up' : 'down');

  document.getElementById('updated').textContent =
    (stale ? '⚠ 离线缓存 · ' : '') + '更新于 ' + new Date().toLocaleString('zh-CN', { hour12: false });

  const arcLen = 251;
  document.getElementById('gaugeArc').setAttribute('stroke-dasharray', `${(composite / 100) * arcLen} ${arcLen}`);
  const scoreEl = document.getElementById('scoreNum');
  scoreEl.textContent = composite.toFixed(0);
  scoreEl.style.color = scoreColor(composite);

  document.getElementById('advice').textContent = scoreToAdvice(composite);

  const mult = scoreToMultiplier(composite);
  document.getElementById('multiplier').textContent = mult.toFixed(2) + '×';
  document.getElementById('todayAmount').textContent = fmtMoney(settings.baseAmount * mult);

  const wrap = document.getElementById('factors');
  wrap.innerHTML = '';
  for (const f of factors) {
    const div = document.createElement('div');
    div.className = 'factor';
    div.innerHTML = `
      <div class="factor-head">
        <div class="factor-name">${f.name}</div>
        <div class="factor-score" style="color:${scoreColor(f.score)}">${f.score.toFixed(0)}</div>
      </div>
      <div class="factor-bar">
        <div class="factor-fill" style="width:${f.score}%; background:${scoreColor(f.score)}"></div>
      </div>
      <div class="factor-detail">${f.detail}</div>
    `;
    wrap.appendChild(div);
  }
}

function showError(msg) {
  let banner = document.querySelector('.error');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'error';
    document.querySelector('.app').insertBefore(banner, document.querySelector('.hero').nextSibling);
  }
  banner.textContent = msg;
}

async function refresh() {
  try {
    const [chartRes, peRes] = await Promise.all([fetchChart(), fetchPE()]);
    lastPE = peRes;
    const avgPE = parseFloat(settings.avgPE) || 24;
    renderPE(peRes, avgPE);
    const data = computeFactors(chartRes.series, peRes, avgPE);
    render(data, !!chartRes.stale);
  } catch (e) {
    showError('数据获取失败: ' + (e.message || e));
  }
}

function bindSettings() {
  const baseInput = document.getElementById('baseAmount');
  const curSel = document.getElementById('currency');
  const manualPEInput = document.getElementById('manualPE');
  const avgPEInput = document.getElementById('avgPE');

  baseInput.value = settings.baseAmount;
  curSel.value = settings.currency;
  manualPEInput.value = settings.manualPE;
  avgPEInput.value = settings.avgPE;

  baseInput.addEventListener('input', () => {
    const v = parseFloat(baseInput.value);
    if (!isNaN(v) && v > 0) {
      settings.baseAmount = v;
      saveSettings();
      if (lastFactors) render(lastFactors);
    }
  });
  curSel.addEventListener('change', () => {
    settings.currency = curSel.value;
    saveSettings();
    if (lastFactors) render(lastFactors);
  });
  manualPEInput.addEventListener('change', () => {
    settings.manualPE = manualPEInput.value;
    saveSettings();
    refresh();
  });
  avgPEInput.addEventListener('change', () => {
    const v = parseFloat(avgPEInput.value);
    if (!isNaN(v) && v > 0) {
      settings.avgPE = v;
      saveSettings();
      refresh();
    }
  });
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
bindSettings();
refresh();
