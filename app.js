// NDX 五因子量化定投助手
// 数据源: Yahoo Finance + Stooq (CSV 备用)

const SYMBOL_YAHOO = '%5ENDX'; // ^NDX URL-encoded
const SYMBOL_STOOQ = '%5Endx'; // Stooq 也接受 ^ndx
const PE_SYMBOL = 'QQQ';
const RANGE = '2y';
const INTERVAL = '1d';

// ---- 多通道代理: 顺序尝试 ----
const PROXIES = [
  raw => raw, // 直连
  raw => `https://corsproxy.io/?${encodeURIComponent(raw)}`,
  raw => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(raw)}`,
  raw => `https://api.allorigins.win/raw?url=${encodeURIComponent(raw)}`,
  raw => `https://cors.eu.org/${raw}`,
];

const STORE_KEY = 'ndx_dca_settings_v2';
const CACHE_KEY = 'ndx_dca_cache_v3';
const PE_CACHE_KEY = 'ndx_pe_cache_v3';

// 历史平均 PE: 26 ≈ NDX 近 15 年中位 (剔除互联网泡沫). 用户可改
const defaults = { baseAmount: 100, currency: 'USD', manualPE: '', avgPE: 26 };
let settings = loadSettings();
let lastFactors = null;
let lastPE = null;

const log = (...a) => console.log('[NDX]', ...a);

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch { return { ...defaults }; }
}
function saveSettings() {
  localStorage.setItem(STORE_KEY, JSON.stringify(settings));
}

async function tryProxies(rawUrl, parser) {
  let lastErr;
  for (const wrap of PROXIES) {
    const u = wrap(rawUrl);
    try {
      log('fetch', u.substring(0, 80));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(u, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const out = await parser(res);
      log('ok via', wrap.toString().includes('raw') && !wrap.toString().includes('encodeURI') ? 'direct' : u.split('?')[0]);
      return out;
    } catch (e) {
      lastErr = e;
      log('fail:', e.message);
    }
  }
  throw lastErr || new Error('全部代理失败');
}

// ---- 数据源 1: Yahoo Finance ----
async function fetchYahooChart() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL_YAHOO}?range=${RANGE}&interval=${INTERVAL}`;
  return tryProxies(url, async res => {
    const data = await res.json();
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error('Yahoo empty');
    const ts = result.timestamp;
    const closes = result.indicators.quote[0].close;
    const series = ts.map((t, i) => ({ t: t * 1000, c: closes[i] })).filter(d => d.c != null);
    if (series.length < 220) throw new Error('Insufficient ' + series.length);
    return series;
  });
}

// ---- 数据源 2: Stooq CSV (CORS 友好备用) ----
async function fetchStooqChart() {
  // Stooq 要求小写 ndx 并带 ^
  const url = `https://stooq.com/q/d/l/?s=^ndx&i=d`;
  return tryProxies(url, async res => {
    const text = await res.text();
    if (!text || text.length < 200) throw new Error('Stooq empty');
    const lines = text.trim().split('\n');
    const header = lines[0].toLowerCase();
    if (!header.includes('close')) throw new Error('Stooq header bad');
    const cols = header.split(',');
    const dateIdx = cols.indexOf('date');
    const closeIdx = cols.indexOf('close');
    const series = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const d = parts[dateIdx];
      const c = parseFloat(parts[closeIdx]);
      if (!d || isNaN(c)) continue;
      series.push({ t: new Date(d).getTime(), c });
    }
    if (series.length < 220) throw new Error('Stooq short ' + series.length);
    // 取最近 2 年
    return series.slice(-520);
  });
}

async function fetchChart() {
  // Yahoo 优先 (有最新当日), Stooq 备份 (CORS 稳)
  try {
    const series = await fetchYahooChart();
    const cached = { series, fetchedAt: Date.now(), source: 'Yahoo' };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cached)); } catch {}
    return cached;
  } catch (e1) {
    log('Yahoo failed, try Stooq:', e1.message);
    try {
      const series = await fetchStooqChart();
      const cached = { series, fetchedAt: Date.now(), source: 'Stooq' };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cached)); } catch {}
      return cached;
    } catch (e2) {
      log('Stooq failed:', e2.message);
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) return { ...JSON.parse(raw), stale: true };
      throw new Error(`Yahoo: ${e1.message} / Stooq: ${e2.message}`);
    }
  }
}

// ---- PE 获取: 多源兜底 ----
async function peFromYahooQuote() {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${PE_SYMBOL}`;
  const data = await tryProxies(url, async r => r.json());
  const item = data.quoteResponse && data.quoteResponse.result && data.quoteResponse.result[0];
  const pe = item && item.trailingPE;
  if (typeof pe !== 'number' || pe <= 0) throw new Error('No trailingPE field');
  return { pe, source: 'Yahoo Quote API' };
}

async function peFromYahooHTML() {
  const url = `https://finance.yahoo.com/quote/${PE_SYMBOL}/`;
  return tryProxies(url, async res => {
    const html = await res.text();
    // 嵌入式 JSON: "trailingPE":{"raw":XX.XX,"fmt":"XX.XX"}
    let m = html.match(/"trailingPE"\s*:\s*\{\s*"raw"\s*:\s*([0-9.]+)/);
    if (!m) m = html.match(/trailingPE[^0-9]{1,40}([0-9]{1,3}\.[0-9]+)/);
    if (!m) throw new Error('No PE in Yahoo HTML');
    const pe = parseFloat(m[1]);
    if (!pe || pe < 1 || pe > 200) throw new Error('PE 异常: ' + pe);
    return { pe, source: 'Yahoo HTML' };
  });
}

async function peFromStockAnalysis() {
  const url = `https://stockanalysis.com/etf/${PE_SYMBOL.toLowerCase()}/`;
  return tryProxies(url, async res => {
    const html = await res.text();
    // 表格: <td>PE Ratio</td><td>XX.XX</td>  或类似结构
    let m = html.match(/PE Ratio[^<>]*<\/[a-z]+>\s*<[^>]+>\s*([0-9]+\.?[0-9]*)/i);
    if (!m) m = html.match(/"peRatio"\s*:\s*"?([0-9.]+)"?/i);
    if (!m) m = html.match(/P\/E\s*Ratio[\s\S]{0,80}?>\s*([0-9]+\.[0-9]+)/i);
    if (!m) throw new Error('No PE in stockanalysis');
    const pe = parseFloat(m[1]);
    if (!pe || pe < 1 || pe > 200) throw new Error('PE 异常: ' + pe);
    return { pe, source: 'StockAnalysis.com' };
  });
}

async function peFromWSJ() {
  const url = `https://www.wsj.com/market-data/quotes/etf/${PE_SYMBOL}`;
  return tryProxies(url, async res => {
    const html = await res.text();
    let m = html.match(/P\/E\s*Ratio[\s\S]{0,200}?<span[^>]*>\s*([0-9]+\.[0-9]+)/i);
    if (!m) m = html.match(/peRatio["':\s]*([0-9]+\.[0-9]+)/i);
    if (!m) throw new Error('No PE in WSJ');
    const pe = parseFloat(m[1]);
    if (!pe || pe < 1 || pe > 200) throw new Error('PE 异常: ' + pe);
    return { pe, source: 'WSJ' };
  });
}

async function fetchPE() {
  if (settings.manualPE && parseFloat(settings.manualPE) > 0) {
    return { pe: parseFloat(settings.manualPE), source: '手动覆盖' };
  }
  const sources = [
    ['Yahoo Quote', peFromYahooQuote],
    ['Yahoo HTML',  peFromYahooHTML],
    ['StockAnaly',  peFromStockAnalysis],
    ['WSJ',         peFromWSJ],
  ];
  const errs = [];
  for (const [name, fn] of sources) {
    try {
      const r = await fn();
      log('PE 成功 via', name, '=', r.pe);
      const cached = { ...r, fetchedAt: Date.now() };
      try { localStorage.setItem(PE_CACHE_KEY, JSON.stringify(cached)); } catch {}
      return cached;
    } catch (e) {
      log('PE 失败', name, e.message);
      errs.push(`${name}: ${e.message}`);
    }
  }
  // 全部失败 → 缓存
  const raw = localStorage.getItem(PE_CACHE_KEY);
  if (raw) {
    const c = JSON.parse(raw);
    return { ...c, source: c.source + ' · 离线缓存' };
  }
  log('PE 全部源失败:', errs.join(' | '));
  return { pe: null, source: '获取失败' };
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

function peScore(currentPE, avgPE) {
  if (!currentPE || !avgPE) return null;
  const dev = (currentPE - avgPE) / avgPE;
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

function computeFactors(series, peData, avgPE) {
  const closes = series.map(d => d.c);
  const last = closes[closes.length - 1];
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);

  const dev200 = (ma200 - last) / ma200;
  const f1Tech = clamp(50 + dev200 * 250, 0, 100);
  const f1PE = peScore(peData.pe, avgPE);
  const f1 = f1PE != null ? (f1Tech * 0.4 + f1PE * 0.6) : f1Tech;
  const f1Detail = f1PE != null
    ? `PE ${peData.pe.toFixed(1)} vs 均值 ${avgPE.toFixed(1)}（PE 分 ${f1PE.toFixed(0)} · MA200 分 ${f1Tech.toFixed(0)}）`
    : `当前价 ${last.toFixed(0)} vs MA200 ${ma200.toFixed(0)}（偏离 ${(dev200*100).toFixed(2)}%）`;

  const rsi14 = rsi(closes, 14);
  const f2 = clamp(100 - rsi14, 0, 100);

  const yearSlice = closes.slice(-252);
  const yearHigh = Math.max(...yearSlice);
  const drawdown = (yearHigh - last) / yearHigh;
  const f3 = clamp(drawdown * 250, 0, 100);

  const vol = realizedVol(closes, 20);
  const f4 = clamp((vol - 8) / (40 - 8) * 100, 0, 100);

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

function scoreToMultiplier(s) {
  if (s < 20) return 0.5;
  if (s < 40) return 0.75;
  if (s < 60) return 1.0;
  if (s < 80) return 1.5;
  return 2.0;
}
function scoreToAdvice(s) {
  if (s < 20) return '🟢 市场偏热 · 建议减仓 / 暂停';
  if (s < 40) return '🟡 略偏高位 · 适度减少投入';
  if (s < 60) return '⚪ 中性区间 · 按计划定投';
  if (s < 80) return '🟠 进入恐慌 · 加大投入';
  return '🔴 极度低估 · 重仓加码';
}
function scoreColor(s) {
  if (s < 20) return '#ff453a';
  if (s < 40) return '#ff9f0a';
  if (s < 60) return '#ffd60a';
  if (s < 80) return '#9ee04f';
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
  let pos = 50;
  if (peData.pe && avgPE) {
    const dev = (peData.pe - avgPE) / avgPE * 100;
    pos = clamp(50 + dev, 0, 100);
  }
  document.getElementById('peBarFill').style.left = pos + '%';
  document.getElementById('peAdvice').textContent = peAdviceText(peData.pe, avgPE);
}

function render(data, meta) {
  const { last, prev, composite, factors } = data;
  lastFactors = data;
  document.getElementById('price').textContent = last.toFixed(2);
  const diff = last - prev;
  const diffPct = (diff / prev) * 100;
  const ch = document.getElementById('change');
  ch.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${diff >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)`;
  ch.className = 'change ' + (diff >= 0 ? 'up' : 'down');

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const tag = meta.stale ? '⚠ 离线缓存 · ' : `[${meta.source}] `;
  document.getElementById('updated').textContent = tag + '更新于 ' + stamp;

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
  hideError();
}

function showError(msg) {
  let banner = document.getElementById('errorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'errorBanner';
    banner.className = 'error';
    const app = document.querySelector('.app');
    app.insertBefore(banner, app.firstChild);
  }
  banner.textContent = msg;
}
function hideError() {
  const b = document.getElementById('errorBanner');
  if (b) b.remove();
}

function setLoading(on) {
  document.getElementById('updated').textContent = on ? '加载中…' : document.getElementById('updated').textContent;
}

async function refresh() {
  setLoading(true);
  try {
    const [chartRes, peRes] = await Promise.all([fetchChart(), fetchPE()]);
    lastPE = peRes;
    const avgPE = parseFloat(settings.avgPE) || 24;
    renderPE(peRes, avgPE);
    const data = computeFactors(chartRes.series, peRes, avgPE);
    render(data, { stale: !!chartRes.stale, source: chartRes.source || '?' });
  } catch (e) {
    showError('行情获取失败: ' + (e.message || e) + ' — 可能浏览器拦截了第三方请求，下拉刷新重试，或在设置手动输入 PE。');
    document.getElementById('updated').textContent = '获取失败 · 点 ↻ 重试';
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
      if (lastFactors) render(lastFactors, { source: 'cache' });
    }
  });
  curSel.addEventListener('change', () => {
    settings.currency = curSel.value;
    saveSettings();
    if (lastFactors) render(lastFactors, { source: 'cache' });
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
      markActivePreset();
      refresh();
    }
  });
  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseFloat(btn.dataset.pe);
      settings.avgPE = v;
      avgPEInput.value = v;
      saveSettings();
      markActivePreset();
      refresh();
    });
  });
  markActivePreset();
}

function markActivePreset() {
  document.querySelectorAll('.preset').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.pe) === parseFloat(settings.avgPE));
  });
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
bindSettings();
refresh();
