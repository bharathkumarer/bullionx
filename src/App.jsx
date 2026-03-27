import React, { useState, useEffect, useRef, useCallback } from 'react';
import { showInterstitial, showRewarded, isRewardedReady, isAdFree, hideBanner, showBanner, startAdFreeWatcher } from './admob.js';

// ─── Constants ──────────────────────────────────────────────────────────────
const REFRESH_INTERVALS = [
  { label: '5s',   value: 5 },
  { label: '15s',  value: 15 },
  { label: '30s',  value: 30 },
  { label: '1m',   value: 60 },
  { label: '5m',   value: 300 },
  { label: '15m',  value: 900 },
];
const DEFAULT_REFRESH = 30; // seconds
const TROY_OZ = 31.1035;     // grams per troy oz
const TOLA = 11.6638;        // grams per tola
const SOVEREIGN = 8;         // grams per sovereign

// Indian landed-cost markup: 5% Basic Customs Duty + 1% AIDC (ex-GST)
// This brings spot prices in line with IBJA / bullion dealer rates
const INDIA_DUTY_FACTOR = 1.06;

// Yahoo Finance chart URLs — raw = signs so proxy encodes them correctly once
// Yahoo Finance chart paths (path only — host is handled per environment)
const YAHOO_PATHS = {
  gold:     '/v8/finance/chart/GC=F?range=5d&interval=1d',
  silver:   '/v8/finance/chart/SI=F?range=5d&interval=1d',
  platinum: '/v8/finance/chart/PL=F?range=5d&interval=1d',
  usdInr:   '/v8/finance/chart/USDINR=X?range=5d&interval=1d',
  gbpInr:   '/v8/finance/chart/GBPINR=X?range=5d&interval=1d',
};
const YAHOO_HOST = 'https://query1.finance.yahoo.com';

// In dev (localhost) Vite proxies /yahoo/* → Yahoo Finance directly — no CORS proxy needed
// In production (Android WebView / deployed) use CORS proxies
const IS_DEV = typeof window !== 'undefined' && window.location.hostname === 'localhost';

function makeUrl(key) {
  const path = YAHOO_PATHS[key];
  if (IS_DEV) return `/yahoo${path}`; // Vite dev proxy
  return YAHOO_HOST + path;           // full URL for CORS proxy wrapping
}

// CORS proxies — only used in production (Android / hosted)
const PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

const CITY_PREMIUMS = {
  Chennai:    1.0030,
  Mumbai:     1.0020,
  Delhi:      1.0010,
  Bangalore:  1.0030,
  Hyderabad:  1.0020,
  Kolkata:    1.0020,
  Pune:       1.0010,
  Ahmedabad:  1.0010,
  Jaipur:     1.0010,
  Lucknow:    1.0010,
  Coimbatore: 1.0030,
  Kochi:      1.0030,
};

const KARATS = { '24K': 1, '22K': 22/24, '18K': 18/24, '14K': 14/24, '10K': 10/24, '9K': 9/24 };

const TABS = [
  { id: 'gold',     label: 'Gold',     icon: '⚡' },
  { id: 'calc',     label: 'Calc',     icon: '⊞' },
  { id: 'silver',   label: 'Silver',   icon: '◈' },
  { id: 'platinum', label: 'Plat',     icon: '◇' },
  { id: 'charts',   label: 'Charts',   icon: '◫' },
  { id: 'forex',    label: 'Forex',    icon: '₹' },
  { id: 'cities',   label: 'Cities',   icon: '◉' },
  { id: 'alerts',   label: 'Alerts',   icon: '◎' },
];

const CONV_AMOUNTS = [10, 50, 100, 500, 1000, 5000];

// ─── Prev-close localStorage cache ───────────────────────────────────────────
// Stores yesterday's closing price per symbol so we always have a baseline
// even when the API doesn't return chartPreviousClose.
const PREV_CLOSE_KEY = 'bsx_prev_close';

function loadStoredPrevClose() {
  try { return JSON.parse(localStorage.getItem(PREV_CLOSE_KEY) || '{}'); }
  catch { return {}; }
}

function saveStoredPrevClose(symbol, price) {
  try {
    const store = loadStoredPrevClose();
    const today = new Date().toDateString();
    // Always save latest price so the last update becomes tomorrow's prevClose
    store[symbol] = { price, date: today };
    localStorage.setItem(PREV_CLOSE_KEY, JSON.stringify(store));
  } catch { /* ignore */ }
}

function getStoredPrevClose(symbol) {
  const store = loadStoredPrevClose();
  const today = new Date().toDateString();
  const entry = store[symbol];
  // Return stored close only if it was saved on a DIFFERENT day (i.e. it is yesterday's close)
  if (entry && entry.date !== today) return entry.price;
  return null;
}

// ─── Fetch Utilities ─────────────────────────────────────────────────────────

// Fetch a Yahoo chart URL — direct in dev (Vite proxy), via CORS proxies in production
async function fetchProxy(rawUrl) {
  if (IS_DEV) {
    // Dev: Vite server proxies /yahoo/* → Yahoo Finance, no CORS issue
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.chart?.result?.[0]) throw new Error('Invalid chart response');
    return json;
  }
  // Production: try each CORS proxy in order
  let lastErr;
  for (const makeProxy of PROXIES) {
    try {
      const res = await fetch(makeProxy(rawUrl), { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json?.chart?.result?.[0]) throw new Error('Invalid chart response');
      return json;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Parse a 5d/1d chart response → standard price object
function parseChart(json, symbol) {
  const meta   = json.chart.result[0].meta;
  const quotes = json.chart.result[0].indicators?.quote?.[0] || {};
  const timestamps = json.chart.result[0].timestamp || [];
  const price  = meta.regularMarketPrice;

  // Get previous close — 4-layer fallback:
  // 1. Yahoo meta field
  // 2. Second-to-last daily close bar
  // 3. Our localStorage cache (saved from previous session/day)
  let prev = meta.chartPreviousClose || meta.regularMarketPreviousClose || null;
  let prevCloseDate = null;

  if (!prev && quotes.close?.length >= 2) {
    const nonNull = quotes.close.filter(v => v != null);
    if (nonNull.length >= 2) prev = nonNull[nonNull.length - 2];
  }
  if (!prev && symbol) prev = getStoredPrevClose(symbol);

  // Extract the date of the previous close from chart timestamps
  if (timestamps.length >= 2) {
    prevCloseDate = new Date(timestamps[timestamps.length - 2] * 1000);
  }

  // Day high/low: prefer today's intraday meta values, fall back to last daily bar
  const dayHighs = quotes.high || [];
  const dayLows  = quotes.low  || [];
  const high = meta.regularMarketDayHigh || dayHighs[dayHighs.length - 1] || price;
  const low  = meta.regularMarketDayLow  || dayLows[dayLows.length - 1]   || price;

  // Save today's price so it becomes tomorrow's prevClose fallback
  if (symbol) saveStoredPrevClose(symbol, price);

  return {
    price,
    prevClose: prev,
    prevCloseDate,
    high,
    low,
    change:    prev ? price - prev : null,
    changePct: prev ? ((price - prev) / prev) * 100 : null,
  };
}

// Fetch one Yahoo chart symbol
async function fetchChart(key) {
  const SYMBOL_MAP = { gold: 'GC=F', silver: 'SI=F', platinum: 'PL=F', usdInr: 'USDINR=X', gbpInr: 'GBPINR=X' };
  const json = await fetchProxy(makeUrl(key));
  return parseChart(json, SYMBOL_MAP[key]);
}

// Direct fetch gold-api.com (CORS-friendly, no proxy needed)
async function fetchGoldApi(symbol) {
  const res = await fetch(`https://api.gold-api.com/price/${symbol}`,
    { signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d   = await res.json();
  const p   = d.price;
  const prev = d.prev_close_price || null;
  return {
    price: p, prevClose: prev,
    high: p, low: p,
    change:    prev ? p - prev : null,
    changePct: prev ? ((p - prev) / prev) * 100 : null,
  };
}

// Frankfurter forex fallback (CORS-friendly)
async function fetchFrankfurter() {
  const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR,GBP',
    { signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d   = await res.json();
  const usdP = d.rates.INR;
  const gbpP = d.rates.INR / d.rates.GBP;
  const mk = (p) => ({ price: p, prevClose: null, high: p, low: p, change: null, changePct: null });
  return { usdInr: mk(usdP), gbpInr: mk(gbpP) };
}

async function fetchAllPrices() {
  const results = {};

  // All five fetched in parallel — Yahoo chart via proxy, gold-api.com as metal fallback
  const [gold, silver, platinum, usdInr, gbpInr] = await Promise.allSettled([
    fetchChart('gold').catch(() => fetchGoldApi('XAU')),
    fetchChart('silver').catch(() => fetchGoldApi('XAG')),
    fetchChart('platinum').catch(() => fetchGoldApi('XPT')),
    fetchChart('usdInr'),
    fetchChart('gbpInr'),
  ]);

  results.gold     = gold.status     === 'fulfilled' ? gold.value     : null;
  results.silver   = silver.status   === 'fulfilled' ? silver.value   : null;
  results.platinum = platinum.status === 'fulfilled' ? platinum.value : null;
  results.usdInr   = usdInr.status   === 'fulfilled' ? usdInr.value   : null;
  results.gbpInr   = gbpInr.status   === 'fulfilled' ? gbpInr.value   : null;

  // Forex final fallback — Frankfurter (no change data but gives rate)
  if (!results.usdInr || !results.gbpInr) {
    try {
      const fb = await fetchFrankfurter();
      if (!results.usdInr) results.usdInr = fb.usdInr;
      if (!results.gbpInr) results.gbpInr = fb.gbpInr;
    } catch { /* nothing */ }
  }

  return results;
}

// ─── Chart Data Fetch ─────────────────────────────────────────────────────────
const chartCache = new Map();
const CHART_CACHE_TTL = 60000; // 1 minute

async function fetchChartFast(rawUrl) {
  if (IS_DEV) {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.chart?.result?.[0]) throw new Error('Invalid chart response');
    return json;
  }
  // Production: try all proxies concurrently — use whichever responds first
  const controller = new AbortController();
  const promises = PROXIES.map(makeProxy =>
    fetch(makeProxy(rawUrl), { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(json => {
        if (!json?.chart?.result?.[0]) throw new Error('Invalid');
        return json;
      })
  );
  try {
    const result = await Promise.any(promises);
    controller.abort(); // cancel remaining
    return result;
  } catch {
    throw new Error('All proxies failed');
  }
}

async function fetchChartData(symbol, range, interval) {
  const cacheKey = `${symbol}:${range}:${interval}`;
  const cached = chartCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CHART_CACHE_TTL) return cached.data;

  const path = `/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
  const url = IS_DEV ? `/yahoo${path}` : YAHOO_HOST + path;
  const json = await fetchChartFast(url);
  const result = json.chart.result[0];
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const data = ts.map((t, i) => ({ time: t * 1000, price: closes[i] })).filter(d => d.price != null);

  chartCache.set(cacheKey, { data, time: Date.now() });
  return data;
}

// ─── Price Check for Alerts ───────────────────────────────────────────────────
function getAlertCurrentPrice(alert, prices) {
  const usdInr = prices?.usdInr?.price || 84;
  if (alert.metal === 'gold') {
    if (!prices?.gold?.price) return null;
    if (alert.currency === 'usd') return prices.gold.price;
    return (prices.gold.price / TROY_OZ) * usdInr * INDIA_DUTY_FACTOR * 10; // INR per 10g
  }
  if (alert.metal === 'silver') {
    if (!prices?.silver?.price) return null;
    if (alert.currency === 'usd') return prices.silver.price;
    return (prices.silver.price / TROY_OZ) * usdInr * INDIA_DUTY_FACTOR * 1000; // INR per kg
  }
  if (alert.metal === 'platinum') {
    if (!prices?.platinum?.price) return null;
    if (alert.currency === 'usd') return prices.platinum.price;
    return (prices.platinum.price / TROY_OZ) * usdInr * INDIA_DUTY_FACTOR * 10; // INR per 10g
  }
  return null;
}

// ─── Format Helpers ───────────────────────────────────────────────────────────
function fmtN(n, dec = 0) {
  if (n == null || isNaN(n)) return '---';
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtINR(n, dec = 0) {
  if (n == null || isNaN(n)) return '---';
  return '₹' + fmtN(n, dec);
}

function fmtUSD(n, dec = 2) {
  if (n == null || isNaN(n)) return '---';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtGBP(n, dec = 2) {
  if (n == null || isNaN(n)) return '---';
  return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtTime(d) {
  if (!d) return '';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function fmtShortDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Auspicious Days ─────────────────────────────────────────────────────────
const AUSPICIOUS_DAYS = [
  { date: '2026-01-14', name: 'Makar Sankranti', note: 'Traditional gold buying day in South India' },
  { date: '2026-03-19', name: 'Ugadi / Gudi Padwa', note: 'New year — auspicious to buy gold' },
  { date: '2026-04-25', name: 'Akshaya Tritiya', note: 'Most popular day to buy gold in India' },
  { date: '2026-08-27', name: 'Ganesh Chaturthi', note: 'Auspicious for new beginnings' },
  { date: '2026-10-01', name: 'Navratri Begins', note: '9-day festival — gold buying season' },
  { date: '2026-10-18', name: 'Dhanteras', note: 'Biggest gold buying day of the year' },
  { date: '2026-10-20', name: 'Diwali', note: 'Festival of wealth — gold & silver gifting' },
  { date: '2026-11-14', name: 'Onam', note: 'Major gold buying festival in Kerala' },
];

function AuspiciousBanner() {
  const now = new Date();
  const upcoming = AUSPICIOUS_DAYS.map(d => {
    const date = new Date(d.date + 'T00:00:00');
    const diff = Math.ceil((date - now) / 86400000);
    return { ...d, diff, date };
  }).filter(d => d.diff >= 0 && d.diff <= 30).sort((a, b) => a.diff - b.diff);

  if (!upcoming.length) return null;
  const next = upcoming[0];

  return (
    <div className="auspicious-banner">
      <div className="auspicious-header">
        <span className="auspicious-icon">✦</span>
        <span className="auspicious-name">{next.name}</span>
        <span className="auspicious-days">{next.diff === 0 ? 'Today!' : `in ${next.diff} day${next.diff > 1 ? 's' : ''}`}</span>
      </div>
      <div className="auspicious-note">{next.note}</div>
    </div>
  );
}

// ─── Ad Strip — rewarded ad CTA or ad-free status ───────────────────────────
function AdStrip() {
  const [adFree, setAdFree] = useState(isAdFree());
  const [remaining, setRemaining] = useState('');

  useEffect(() => {
    const tick = setInterval(() => {
      const free = isAdFree();
      setAdFree(free);
      if (free) {
        const ms = parseInt(localStorage.getItem('adFreeUntil') || '0', 10) - Date.now();
        if (ms > 0) {
          const mins = Math.ceil(ms / 60000);
          setRemaining(`${mins}m`);
        }
      }
    }, 10000);
    return () => clearInterval(tick);
  }, []);

  const handleWatchAd = async () => {
    const success = await showRewarded();
    if (success) {
      setAdFree(true);
      hideBanner();
      startAdFreeWatcher();
    }
  };

  if (adFree) {
    return (
      <div className="ad-strip ad-strip--free">
        <span className="ad-strip-icon">✦</span>
        <span>Ad-free for {remaining}</span>
      </div>
    );
  }

  return (
    <div className="ad-strip" onClick={handleWatchAd}>
      <span className="ad-strip-icon">▶</span>
      <span>Watch a short ad — go ad-free for 30 min</span>
    </div>
  );
}

// ─── "Should I Buy?" Signal ──────────────────────────────────────────────────
function BuySignal({ symbol, label }) {
  const [signal, setSignal] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        let data;
        try {
          data = await fetchChartData(symbol, '3mo', '1d');
        } catch {
          // Retry with 1mo if 3mo fails
          data = await fetchChartData(symbol, '1mo', '1d');
        }
        if (cancelled || data.length < 5) { setLoading(false); return; }
        const prices = data.map(d => d.price);
        const current = prices[prices.length - 1];
        const maLen = Math.min(prices.length, 30);
        const sma7 = prices.slice(-Math.min(7, prices.length)).reduce((a, b) => a + b, 0) / Math.min(7, prices.length);
        const sma30 = prices.slice(-maLen).reduce((a, b) => a + b, 0) / maLen;
        const pctFrom30 = ((current - sma30) / sma30) * 100;

        const low30 = Math.min(...prices.slice(-maLen));
        const high30 = Math.max(...prices.slice(-maLen));
        const rangePos = high30 !== low30 ? ((current - low30) / (high30 - low30)) * 100 : 50;

        let level, text, detail;
        if (pctFrom30 < -2 && rangePos < 30) {
          level = 'buy';
          text = 'Good Opportunity';
          detail = `${label} is ${Math.abs(pctFrom30).toFixed(1)}% below its 30-day average and near its monthly low.`;
        } else if (pctFrom30 > 3 && rangePos > 80) {
          level = 'wait';
          text = 'Consider Waiting';
          detail = `${label} is ${pctFrom30.toFixed(1)}% above its 30-day average and near its monthly high.`;
        } else if (sma7 > sma30 && pctFrom30 > 0) {
          level = 'neutral-up';
          text = 'Upward Trend';
          detail = `${label} is in a short-term uptrend. 7-day average is above 30-day average.`;
        } else if (sma7 < sma30 && pctFrom30 < 0) {
          level = 'neutral-down';
          text = 'Downward Trend';
          detail = `${label} is in a short-term downtrend, which may present buying opportunities soon.`;
        } else {
          level = 'neutral';
          text = 'Neutral';
          detail = `${label} is trading near its 30-day average. No strong signal either way.`;
        }

        if (!cancelled) setSignal({ level, text, detail, pctFrom30, rangePos, sma30, current });
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [symbol, label]);

  if (loading) return <div className="signal-card" style={{ borderColor: 'var(--border-card)', textAlign: 'center', padding: 20 }}><div className="spinner" style={{ margin: '0 auto' }} /><div className="signal-disclaimer" style={{ marginTop: 8 }}>Analyzing price trends...</div></div>;
  if (!signal) return null;

  const colorMap = { buy: 'var(--green)', wait: 'var(--red)', 'neutral-up': 'var(--blue)', 'neutral-down': '#ff9800', neutral: 'var(--text-dim)' };
  const iconMap = { buy: '▼', wait: '▲', 'neutral-up': '↗', 'neutral-down': '↘', neutral: '→' };

  return (
    <div className="signal-card" style={{ borderColor: colorMap[signal.level] }}>
      <div className="signal-header">
        <span className="signal-icon" style={{ color: colorMap[signal.level] }}>{iconMap[signal.level]}</span>
        <span className="signal-title" style={{ color: colorMap[signal.level] }}>{signal.text}</span>
        <span className="signal-badge">AI Signal</span>
      </div>
      <div className="signal-detail">{signal.detail}</div>
      <div className="signal-stats">
        <span>30d avg: {fmtUSD(signal.sma30)}</span>
        <span>Range position: {signal.rangePos.toFixed(0)}%</span>
      </div>
      <div className="signal-disclaimer">Not financial advice. Based on price trends only.</div>
    </div>
  );
}

// ─── Share Rate Card ─────────────────────────────────────────────────────────
function shareRateCard(prices, goldPerGramINR, goldPer10gINR, silverPerGramINR) {
  const now = new Date();
  const today = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const gold1g = goldPerGramINR ? fmtN(goldPerGramINR) : '---';
  const gold24 = goldPer10gINR ? fmtN(goldPer10gINR) : '---';
  const gold22 = goldPer10gINR ? fmtN(goldPer10gINR * (22 / 24)) : '---';
  const gold22g = goldPerGramINR ? fmtN(goldPerGramINR * (22 / 24)) : '---';
  const silverG = silverPerGramINR ? fmtN(silverPerGramINR, 2) : '---';
  const silverKg = silverPerGramINR ? fmtN(silverPerGramINR * 1000) : '---';

  // Gold change in INR
  const g = prices?.gold;
  const s = prices?.silver;
  const usdInr = prices?.usdInr?.price || 0;
  const lines = [
    `Gold & Silver Rates`,
    `${today} at ${time} IST`,
    ``,
    `Gold 24K: ₹${gold1g}/g | ₹${gold24}/10g`,
    `Gold 22K: ₹${gold22g}/g | ₹${gold22}/10g`,
    `Silver: ₹${silverG}/g | ₹${silverKg}/kg`,
  ];

  // Gold change from yesterday
  lines.push('');
  if (g?.change != null && g?.changePct != null) {
    const arrow = g.change >= 0 ? '▲' : '▼';
    const dir = g.change >= 0 ? 'UP' : 'DOWN';
    if (usdInr > 0) {
      const inrChange10g = (g.change / TROY_OZ) * usdInr * INDIA_DUTY_FACTOR * 10;
      lines.push(`${arrow} Gold ${dir} ₹${Math.abs(inrChange10g).toFixed(0)}/10g (${Math.abs(g.changePct).toFixed(2)}%) vs yesterday`);
    } else {
      lines.push(`${arrow} Gold ${dir} $${Math.abs(g.change).toFixed(2)}/oz (${Math.abs(g.changePct).toFixed(2)}%) vs yesterday`);
    }
  }

  // Silver change from yesterday
  if (s?.change != null && s?.changePct != null) {
    const arrow = s.change >= 0 ? '▲' : '▼';
    const dir = s.change >= 0 ? 'UP' : 'DOWN';
    if (usdInr > 0) {
      const inrChangeKg = (s.change / TROY_OZ) * usdInr * INDIA_DUTY_FACTOR * 1000;
      lines.push(`${arrow} Silver ${dir} ₹${Math.abs(inrChangeKg).toFixed(0)}/kg (${Math.abs(s.changePct).toFixed(2)}%) vs yesterday`);
    } else {
      lines.push(`${arrow} Silver ${dir} $${Math.abs(s.change).toFixed(2)}/oz (${Math.abs(s.changePct).toFixed(2)}%) vs yesterday`);
    }
  }

  lines.push(``, `Live prices, charts & calculators:`, `https://bullionlive-test.netlify.app`, ``, `#GoldPrice #GoldRate #SilverPrice`);

  const text = lines.join('\n');
  if (navigator.share) {
    navigator.share({ title: 'Gold & Silver Rates Today', text }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(text);
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PriceChange({ change, changePct }) {
  if (change == null || changePct == null) return null;
  const isPos = change >= 0;
  const cls = isPos ? 'up' : 'down';
  const arrow = isPos ? '▲' : '▼';
  return (
    <span className={`change ${cls}`}>
      {arrow} {Math.abs(change).toFixed(2)} ({Math.abs(changePct).toFixed(2)}%)
    </span>
  );
}

function Ticker({ prices, goldPerGramINR, silverPerGramINR }) {
  const buildItems = () => {
    const items = [];
    const g = prices?.gold;
    const s = prices?.silver;
    const p = prices?.platinum;
    const u = prices?.usdInr;
    const gb = prices?.gbpInr;

    if (g) {
      const hasPct = g.changePct != null;
      const sign = hasPct && g.changePct >= 0 ? '+' : '';
      items.push(
        <React.Fragment key="gold">
          <span className="ticker-item">
            GOLD {fmtUSD(g.price)}&nbsp;
            {hasPct && (
              <span className={g.changePct >= 0 ? 'ticker-up' : 'ticker-down'}>
                {sign}{g.changePct.toFixed(2)}%
              </span>
            )}
          </span>
          <span className="ticker-sep">◆</span>
        </React.Fragment>
      );
    }
    if (s) {
      const hasPct = s.changePct != null;
      const sign = hasPct && s.changePct >= 0 ? '+' : '';
      items.push(
        <React.Fragment key="silver">
          <span className="ticker-item">
            SILVER {fmtUSD(s.price, 3)}&nbsp;
            {hasPct && (
              <span className={s.changePct >= 0 ? 'ticker-up' : 'ticker-down'}>
                {sign}{s.changePct.toFixed(2)}%
              </span>
            )}
          </span>
          <span className="ticker-sep">◆</span>
        </React.Fragment>
      );
    }
    if (p) {
      const hasPct = p.changePct != null;
      const sign = hasPct && p.changePct >= 0 ? '+' : '';
      items.push(
        <React.Fragment key="plat">
          <span className="ticker-item">
            PLATINUM {fmtUSD(p.price)}&nbsp;
            {hasPct && (
              <span className={p.changePct >= 0 ? 'ticker-up' : 'ticker-down'}>
                {sign}{p.changePct.toFixed(2)}%
              </span>
            )}
          </span>
          <span className="ticker-sep">◆</span>
        </React.Fragment>
      );
    }
    if (u) {
      items.push(
        <React.Fragment key="usd">
          <span className="ticker-item">USD/INR {fmtN(u.price, 2)}</span>
          <span className="ticker-sep">◆</span>
        </React.Fragment>
      );
    }
    if (gb) {
      items.push(
        <React.Fragment key="gbp">
          <span className="ticker-item">GBP/INR {fmtN(gb.price, 2)}</span>
          <span className="ticker-sep">◆</span>
        </React.Fragment>
      );
    }
    if (goldPerGramINR) {
      items.push(
        <React.Fragment key="gold-inr">
          <span className="ticker-item">GOLD 24K {fmtINR(goldPerGramINR * 10)}/10g</span>
          <span className="ticker-sep">◆</span>
        </React.Fragment>
      );
    }
    if (silverPerGramINR) {
      items.push(
        <React.Fragment key="silver-inr">
          <span className="ticker-item">SILVER {fmtINR(silverPerGramINR * 1000)}/kg</span>
          <span className="ticker-sep">◆</span>
        </React.Fragment>
      );
    }
    return items;
  };

  const items = buildItems();
  if (!items.length) {
    return (
      <div className="ticker-wrap">
        <div className="ticker-track">
          <span className="ticker-item" style={{ color: 'var(--text-dim)' }}>Loading prices...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="ticker-wrap">
      <div className="ticker-track">
        {items}{items}
      </div>
    </div>
  );
}

// ─── Gold Tab ─────────────────────────────────────────────────────────────────
function GoldTab({ prices, goldPerGramINR, goldPer10gINR }) {
  const g = prices?.gold;
  const usdInr = prices?.usdInr?.price;

  return (
    <div className="tab-content fade-in">
      <AuspiciousBanner />
      {/* Main spot card */}
      <div className="price-card gold-card">
        <div className="card-label">COMEX Gold Futures</div>
        <div className="card-price">{fmtUSD(g?.price)}</div>
        <div className="card-change">
          <PriceChange change={g?.change} changePct={g?.changePct} />
        </div>
        <div className="day-range">
          <span>▲ H: {fmtUSD(g?.high)}</span>
          <span>▼ L: {fmtUSD(g?.low)}</span>
          {usdInr && <span>₹{fmtN(usdInr, 2)}/USD</span>}
        </div>
        {g?.prevClose != null && (
          <div className="prev-close">
            Prev Close: {fmtUSD(g.prevClose)}
            {g.prevCloseDate && <span className="prev-close-date"> ({fmtShortDate(g.prevCloseDate)})</span>}
          </div>
        )}
      </div>

      {/* Karat rates per 10g INR */}
      <div className="section-header">Karat Rates — per 10g (INR)</div>
      <div className="karat-grid">
        {Object.entries(KARATS).map(([karat, factor]) => (
          <div key={karat} className={`karat-card ${karat === '24K' ? 'primary' : ''}`}>
            <div className="karat-label">{karat}</div>
            <div className="karat-price mono">
              {fmtINR(goldPer10gINR != null ? goldPer10gINR * factor : null)}
            </div>
          </div>
        ))}
      </div>

      {/* Quick Reference */}
      <div className="section-header">Quick Reference — 24K</div>
      <div className="ref-table">
        <div className="ref-row highlight">
          <span className="ref-label">Per Gram</span>
          <span className="ref-value">{fmtINR(goldPerGramINR)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per Tola (11.66g)</span>
          <span className="ref-value">{fmtINR(goldPerGramINR ? goldPerGramINR * TOLA : null)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per Sovereign (8g)</span>
          <span className="ref-value">{fmtINR(goldPerGramINR ? goldPerGramINR * SOVEREIGN : null)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per 100g Bar</span>
          <span className="ref-value">{fmtINR(goldPerGramINR ? goldPerGramINR * 100 : null)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per Troy Oz</span>
          <span className="ref-value">{fmtINR(goldPerGramINR ? goldPerGramINR * TROY_OZ : null)}</span>
        </div>
      </div>

      <p className="disclaimer">
        * Includes 5% BCD + 1% AIDC. Excludes 3% GST &amp; making charges.
      </p>

      <BuySignal symbol="GC=F" label="Gold" />

      {/* Festival Calendar */}
      <div className="section-header">Gold Buying Calendar 2026</div>
      <div className="festival-list">
        {AUSPICIOUS_DAYS.map(d => {
          const date = new Date(d.date + 'T00:00:00');
          const now = new Date();
          const diff = Math.ceil((date - now) / 86400000);
          const isPast = diff < 0;
          const isSoon = diff >= 0 && diff <= 14;
          const isToday = diff === 0;
          return (
            <div key={d.date} className={`festival-row ${isPast ? 'past' : ''} ${isSoon ? 'soon' : ''} ${isToday ? 'today' : ''}`}>
              <div className="festival-date">
                <span className="festival-day">{date.toLocaleDateString('en-IN', { day: 'numeric' })}</span>
                <span className="festival-month">{date.toLocaleDateString('en-IN', { month: 'short' })}</span>
              </div>
              <div className="festival-info">
                <span className="festival-name">{d.name}</span>
                <span className="festival-note">{d.note}</span>
              </div>
              <div className="festival-badge">
                {isToday ? 'Today!' : isPast ? 'Passed' : `${diff}d`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Silver Tab ───────────────────────────────────────────────────────────────
function SilverTab({ prices, silverPerGramINR }) {
  const s = prices?.silver;
  const usdInr = prices?.usdInr?.price;

  return (
    <div className="tab-content fade-in">
      <div className="price-card silver-card">
        <div className="card-label">COMEX Silver Futures</div>
        <div className="card-price silver">{fmtUSD(s?.price, 3)}</div>
        <div className="card-change">
          <PriceChange change={s?.change} changePct={s?.changePct} />
        </div>
        <div className="day-range">
          <span>▲ H: {fmtUSD(s?.high, 3)}</span>
          <span>▼ L: {fmtUSD(s?.low, 3)}</span>
          {usdInr && <span>₹{fmtN(usdInr, 2)}/USD</span>}
        </div>
        {s?.prevClose != null && (
          <div className="prev-close">
            Prev Close: {fmtUSD(s.prevClose, 3)}
            {s.prevCloseDate && <span className="prev-close-date"> ({fmtShortDate(s.prevCloseDate)})</span>}
          </div>
        )}
      </div>

      <div className="section-header">INR Rates</div>
      <div className="ref-table">
        <div className="ref-row highlight">
          <span className="ref-label">Per Kilogram</span>
          <span className="ref-value">{fmtINR(silverPerGramINR ? silverPerGramINR * 1000 : null)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per 100g</span>
          <span className="ref-value">{fmtINR(silverPerGramINR ? silverPerGramINR * 100 : null)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per 10g</span>
          <span className="ref-value">{fmtINR(silverPerGramINR ? silverPerGramINR * 10 : null)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per Gram</span>
          <span className="ref-value">{fmtINR(silverPerGramINR, 2)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per Tola (11.66g)</span>
          <span className="ref-value">{fmtINR(silverPerGramINR ? silverPerGramINR * TOLA : null, 2)}</span>
        </div>
      </div>

      <p className="disclaimer">
        * Includes 5% BCD + 1% AIDC. Excludes 3% GST &amp; making charges.
      </p>

      <BuySignal symbol="SI=F" label="Silver" />
    </div>
  );
}

// ─── Platinum Tab ─────────────────────────────────────────────────────────────
function PlatinumTab({ prices, platPerGramINR }) {
  const p = prices?.platinum;
  const usdInr = prices?.usdInr?.price;

  return (
    <div className="tab-content fade-in">
      <div className="price-card plat-card">
        <div className="card-label">NYMEX Platinum Futures</div>
        <div className="card-price platinum">{fmtUSD(p?.price)}</div>
        <div className="card-change">
          <PriceChange change={p?.change} changePct={p?.changePct} />
        </div>
        <div className="day-range">
          <span>▲ H: {fmtUSD(p?.high)}</span>
          <span>▼ L: {fmtUSD(p?.low)}</span>
          {usdInr && <span>₹{fmtN(usdInr, 2)}/USD</span>}
        </div>
        {p?.prevClose != null && (
          <div className="prev-close">
            Prev Close: {fmtUSD(p.prevClose)}
            {p.prevCloseDate && <span className="prev-close-date"> ({fmtShortDate(p.prevCloseDate)})</span>}
          </div>
        )}
      </div>

      <div className="section-header">INR Rates</div>
      <div className="ref-table">
        <div className="ref-row highlight">
          <span className="ref-label">Per 10g</span>
          <span className="ref-value">{fmtINR(platPerGramINR ? platPerGramINR * 10 : null)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per Gram</span>
          <span className="ref-value">{fmtINR(platPerGramINR, 2)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per Troy Oz</span>
          <span className="ref-value">{fmtINR(platPerGramINR ? platPerGramINR * TROY_OZ : null)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per Troy Oz (USD)</span>
          <span className="ref-value">{fmtUSD(p?.price)}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Per 100g</span>
          <span className="ref-value">{fmtINR(platPerGramINR ? platPerGramINR * 100 : null)}</span>
        </div>
      </div>

      <p className="disclaimer">
        * Includes 5% BCD + 1% AIDC. Excludes 3% GST &amp; making charges.
      </p>

      <BuySignal symbol="PL=F" label="Platinum" />
    </div>
  );
}

// ─── Forex Tab ────────────────────────────────────────────────────────────────
const FOREX_CURRENCIES = [
  { code: 'USD', symbol: '$',  name: 'US Dollar' },
  { code: 'EUR', symbol: '€',  name: 'Euro' },
  { code: 'GBP', symbol: '£',  name: 'British Pound' },
  { code: 'JPY', symbol: '¥',  name: 'Japanese Yen' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
  { code: 'CHF', symbol: 'Fr', name: 'Swiss Franc' },
  { code: 'CNY', symbol: '¥',  name: 'Chinese Yuan' },
  { code: 'HKD', symbol: 'HK$',name: 'Hong Kong Dollar' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
  { code: 'SEK', symbol: 'kr', name: 'Swedish Krona' },
  { code: 'KRW', symbol: '₩',  name: 'South Korean Won' },
  { code: 'NOK', symbol: 'kr', name: 'Norwegian Krone' },
  { code: 'NZD', symbol: 'NZ$',name: 'New Zealand Dollar' },
  { code: 'MXN', symbol: 'Mex$',name: 'Mexican Peso' },
  { code: 'ZAR', symbol: 'R',  name: 'South African Rand' },
  { code: 'AED', symbol: 'د.إ',name: 'UAE Dirham' },
  { code: 'SAR', symbol: '﷼',  name: 'Saudi Riyal' },
  { code: 'THB', symbol: '฿',  name: 'Thai Baht' },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit' },
];

function ForexTab({ prices }) {
  const u = prices?.usdInr;
  const g = prices?.gbpInr;
  const [forexRates, setForexRates] = useState(null);
  const [fromCur, setFromCur] = useState('USD');
  const [toCur, setToCur] = useState('INR');
  const [forexAmt, setForexAmt] = useState('1');

  // Fetch all rates from Frankfurter (base=USD)
  useEffect(() => {
    const symbols = FOREX_CURRENCIES.map(c => c.code).filter(c => c !== 'USD').join(',');
    const load = async () => {
      try {
        const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${symbols},INR`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error('fail');
        const data = await res.json();
        const rates = { ...data.rates, USD: 1 };
        // Override INR with Yahoo live rate so converter matches Live Rates card
        if (u?.price) rates.INR = u.price;
        setForexRates(rates);
      } catch {
        // Fallback: at least set USD/INR from Yahoo data
        if (u?.price) setForexRates({ USD: 1, INR: u.price });
      }
    };
    load();
  }, [u?.price]);

  const allCurrencies = [{ code: 'INR', symbol: '₹', name: 'Indian Rupee' }, ...FOREX_CURRENCIES];

  const getRate = (from, to) => {
    if (!forexRates) return null;
    const fromRate = from === 'INR' ? (forexRates.INR || u?.price || null) : forexRates[from];
    const toRate = to === 'INR' ? (forexRates.INR || u?.price || null) : forexRates[to];
    if (!fromRate || !toRate) return null;
    return toRate / fromRate;
  };

  const rate = getRate(fromCur, toCur);
  const amt = parseFloat(forexAmt) || 0;
  const converted = rate ? amt * rate : null;
  const fromInfo = allCurrencies.find(c => c.code === fromCur);
  const toInfo = allCurrencies.find(c => c.code === toCur);

  const swapCurrencies = () => {
    setFromCur(toCur);
    setToCur(fromCur);
  };

  return (
    <div className="tab-content fade-in">
      {/* Live rates cards */}
      <div className="section-header">Live Rates</div>
      <div className="forex-grid">
        <div className="price-card forex-card">
          <div className="card-label">USD / INR</div>
          <div className="card-price blue">{fmtN(u?.price, 2)}</div>
          <div className="card-change">
            <PriceChange change={u?.change} changePct={u?.changePct} />
          </div>
          <div className="day-range">
            <span>H: {fmtN(u?.high, 2)}</span>
            <span>L: {fmtN(u?.low, 2)}</span>
          </div>
          {u?.prevClose != null && (
            <div className="prev-close">
              Prev Close: {fmtN(u.prevClose, 2)}
              {u.prevCloseDate && <span className="prev-close-date"> ({fmtShortDate(u.prevCloseDate)})</span>}
            </div>
          )}
        </div>
        <div className="price-card forex-card">
          <div className="card-label">GBP / INR</div>
          <div className="card-price blue">{fmtN(g?.price, 2)}</div>
          <div className="card-change">
            <PriceChange change={g?.change} changePct={g?.changePct} />
          </div>
          <div className="day-range">
            <span>H: {fmtN(g?.high, 2)}</span>
            <span>L: {fmtN(g?.low, 2)}</span>
          </div>
          {g?.prevClose != null && (
            <div className="prev-close">
              Prev Close: {fmtN(g.prevClose, 2)}
              {g.prevCloseDate && <span className="prev-close-date"> ({fmtShortDate(g.prevCloseDate)})</span>}
            </div>
          )}
        </div>
      </div>

      {/* Currency Converter */}
      <div className="section-header">Currency Converter</div>
      <div className="calc-card">
        <div className="calc-field">
          <label>Amount</label>
          <input
            type="number"
            className="num-input"
            style={{ width: '100%' }}
            value={forexAmt}
            onChange={e => setForexAmt(e.target.value)}
            placeholder="1"
            min="0"
            step="any"
            inputMode="decimal"
          />
        </div>

        <div className="calc-field">
          <label>From</label>
          <select className="form-select" value={fromCur} onChange={e => setFromCur(e.target.value)}>
            {allCurrencies.map(c => (
              <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
            ))}
          </select>
        </div>

        <div style={{ textAlign: 'center', margin: '4px 0' }}>
          <button className="swap-btn" onClick={swapCurrencies} title="Swap currencies">⇅</button>
        </div>

        <div className="calc-field">
          <label>To</label>
          <select className="form-select" value={toCur} onChange={e => setToCur(e.target.value)}>
            {allCurrencies.map(c => (
              <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
            ))}
          </select>
        </div>

        <div className="calc-result-card">
          <div className="result-label">{fromInfo?.symbol}{amt ? fmtN(amt, 2) : '0'} {fromCur} =</div>
          <div className="result-amount">
            {converted != null ? `${toInfo?.symbol}${fmtN(converted, 2)} ${toCur}` : '---'}
          </div>
          {rate && (
            <div className="result-breakdown">
              1 {fromCur} = {fmtN(rate, 4)} {toCur}
            </div>
          )}
        </div>
      </div>

      {/* Quick rates table against INR */}
      <div className="section-header">Rates vs INR</div>
      <div className="conv-table">
        <div className="conv-header"><span>Currency</span><span>1 Unit = INR</span></div>
        {forexRates && FOREX_CURRENCIES.slice(0, 10).map(c => {
          const inrRate = getRate(c.code, 'INR');
          return (
            <div key={c.code} className="conv-row">
              <span className="conv-from">{c.symbol} {c.code}</span>
              <span className="conv-to">{inrRate ? fmtINR(inrRate, 2) : '---'}</span>
            </div>
          );
        })}
        {!forexRates && <div className="conv-row"><span className="conv-from" style={{ color: 'var(--text-dim)' }}>Loading rates...</span></div>}
      </div>
    </div>
  );
}

// ─── Cities Tab ───────────────────────────────────────────────────────────────
function CitiesTab({ goldPer10gINR }) {
  const [karat, setKarat] = useState('22K');
  const factor = KARATS[karat];

  return (
    <div className="tab-content fade-in">
      <div className="section-header">Gold Rate by City — per 10g</div>

      <div className="karat-selector">
        {Object.keys(KARATS).map(k => (
          <button key={k} className={`sel-btn ${karat === k ? 'active' : ''}`} onClick={() => setKarat(k)}>
            {k}
          </button>
        ))}
      </div>

      <p className="subtitle">Indicative rate · {karat} · Spot only</p>

      <div className="cities-grid">
        {Object.entries(CITY_PREMIUMS).map(([city, premium]) => {
          const base = goldPer10gINR != null ? goldPer10gINR * factor * premium : null;
          return (
            <div key={city} className="city-card">
              <div className="city-name">{city}</div>
              <div className="city-price">{fmtINR(base)}</div>
              <div className="city-premium">+{((premium - 1) * 100).toFixed(1)}% premium</div>
            </div>
          );
        })}
      </div>

      <p className="disclaimer">
        * Local premiums are indicative. Actual prices may vary. Excludes GST &amp; making charges.
      </p>
    </div>
  );
}

// ─── Calculator Tab ───────────────────────────────────────────────────────────
const CALC_MODES = [
  { id: 'jewellery', label: 'Jewellery Cost' },
  { id: 'scrap',     label: 'Scrap Gold' },
  { id: 'loan',      label: 'Gold Loan' },
  { id: 'weight',    label: 'Weight→Value' },
  { id: 'amount',    label: 'Amount→Grams' },
];

function CalculatorTab({ goldPerGramINR, silverPerGramINR, platPerGramINR }) {
  const [mode, setMode]       = useState('jewellery');

  // By-weight state
  const [weight, setWeight]   = useState('');
  const [unit, setUnit]       = useState('gram');
  const [wMetal, setWMetal]   = useState('gold');
  const [karat, setKarat]     = useState('22K');

  // By-amount state
  const [amountINR, setAmountINR] = useState('');
  const [amtMetal, setAmtMetal]   = useState('gold');
  const [amtKarat, setAmtKarat]   = useState('22K');

  // Jewellery state
  const [jwlWeight, setJwlWeight]       = useState('');
  const [jwlKarat, setJwlKarat]         = useState('22K');
  const [jwlMaking, setJwlMaking]       = useState('12');
  const [jwlWastage, setJwlWastage]     = useState('2');
  const [jwlGst, setJwlGst]             = useState(true);

  // Scrap state
  const [scrapWeight, setScrapWeight]   = useState('');
  const [scrapKarat, setScrapKarat]     = useState('22K');
  const [scrapMargin, setScrapMargin]   = useState('4');

  // Gold Loan state
  const [loanWeight, setLoanWeight]     = useState('');
  const [loanKarat, setLoanKarat]       = useState('22K');
  const [loanLtv, setLoanLtv]           = useState('75');
  const [loanRate, setLoanRate]         = useState('7.5');
  const [loanTenure, setLoanTenure]     = useState('12');

  // Portfolio / Family Gold Diary state
  const [portfolio, setPortfolio] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bsx_portfolio') || '[]'); }
    catch { return []; }
  });
  const [pfMetal, setPfMetal]     = useState('gold');
  const [pfWeight, setPfWeight]   = useState('');
  const [pfPrice, setPfPrice]     = useState('');
  const [pfKarat, setPfKarat]     = useState('24K');
  const [pfMember, setPfMember]   = useState('');
  const [pfType, setPfType]       = useState('jewellery');

  // Gold Goal Planner state
  const [goals, setGoals] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bsx_goals') || '[]'); }
    catch { return []; }
  });
  const [goalName, setGoalName]     = useState('');
  const [goalType, setGoalType]     = useState('wedding');
  const [goalGrams, setGoalGrams]   = useState('');
  const [goalKarat, setGoalKarat]   = useState('22K');
  const [goalDate, setGoalDate]     = useState('');
  const [goalSaved, setGoalSaved]   = useState('');

  // Rate Fairness Checker state
  const [fairRate, setFairRate]     = useState('');
  const [fairKarat, setFairKarat]   = useState('22K');
  const [fairWeight, setFairWeight] = useState('10');

  // HUID state
  const [huidInput, setHuidInput]   = useState('');

  // ── By-weight calc ──
  const toGrams = (w, u) => {
    const n = parseFloat(w);
    if (!n || n <= 0) return 0;
    if (u === 'tola') return n * TOLA;
    if (u === 'oz')   return n * TROY_OZ;
    if (u === 'kg')   return n * 1000;
    return n;
  };
  const weightInGrams = toGrams(weight, unit);
  const kFactor       = wMetal === 'gold' ? KARATS[karat] : 1;
  const wPricePerGram = wMetal === 'gold' ? goldPerGramINR : wMetal === 'silver' ? silverPerGramINR : platPerGramINR;
  const weightResult  = weightInGrams && wPricePerGram ? weightInGrams * wPricePerGram * kFactor : null;

  // ── By-amount calc ──
  const budget = parseFloat(amountINR) || 0;
  const pricePerGram = () => {
    if (amtMetal === 'gold')     return goldPerGramINR ? goldPerGramINR * KARATS[amtKarat] : null;
    if (amtMetal === 'silver')   return silverPerGramINR || null;
    if (amtMetal === 'platinum') return platPerGramINR || null;
    return null;
  };
  const ppg = pricePerGram();
  const gramsYouGet  = budget && ppg ? budget / ppg : null;
  const tolaYouGet   = gramsYouGet ? gramsYouGet / TOLA : null;
  const ozYouGet     = gramsYouGet ? gramsYouGet / TROY_OZ : null;
  const sovYouGet    = amtMetal === 'gold' && gramsYouGet ? gramsYouGet / SOVEREIGN : null;

  return (
    <div className="tab-content fade-in">
      {/* Mode selector */}
      <div className="calc-mode-bar">
        {CALC_MODES.map(m => (
          <button key={m.id} className={`calc-mode-btn ${mode === m.id ? 'active' : ''}`} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {/* ── MODE: Gold Goals ── */}
      {mode === 'goals' && (
        <>
          <div className="section-header">My Gold Goals</div>
          <div className="calc-card">
            <div className="calc-field">
              <label>Goal Name</label>
              <input type="text" className="num-input" style={{ width: '100%' }} value={goalName} onChange={e => setGoalName(e.target.value)} placeholder="e.g. Priya's Wedding" />
            </div>
            <div className="calc-field">
              <label>Purpose</label>
              <div className="karat-selector">
                {[['wedding', 'Wedding'], ['festival', 'Festival'], ['savings', 'Savings'], ['gift', 'Gift']].map(([v, l]) => (
                  <button key={v} className={`sel-btn ${goalType === v ? 'active' : ''}`} onClick={() => setGoalType(v)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="calc-field">
              <label>Target Gold (grams)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={goalGrams} onChange={e => setGoalGrams(e.target.value)} placeholder="e.g. 100" min="0" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label>Karat</label>
              <div className="karat-row">
                {['24K', '22K', '18K'].map(k => (
                  <button key={k} className={`sel-btn ${goalKarat === k ? 'active' : ''}`} onClick={() => setGoalKarat(k)}>{k}</button>
                ))}
              </div>
            </div>
            <div className="calc-field">
              <label>Target Date</label>
              <input type="date" className="num-input" style={{ width: '100%' }} value={goalDate} onChange={e => setGoalDate(e.target.value)} />
            </div>
            <div className="calc-field">
              <label>Gold Already Saved (grams)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={goalSaved} onChange={e => setGoalSaved(e.target.value)} placeholder="0" min="0" inputMode="decimal" />
            </div>
            <button className="add-btn" onClick={() => {
              const g = parseFloat(goalGrams);
              if (!goalName || !g || g <= 0 || !goalDate) return;
              const updated = [...goals, { id: Date.now(), name: goalName, type: goalType, targetGrams: g, karat: goalKarat, deadline: goalDate, savedGrams: parseFloat(goalSaved) || 0 }];
              setGoals(updated);
              localStorage.setItem('bsx_goals', JSON.stringify(updated));
              setGoalName(''); setGoalGrams(''); setGoalDate(''); setGoalSaved('');
            }}>+ Add Goal</button>
          </div>

          {goals.length > 0 && (
            <div className="goals-list">
              {goals.map(goal => {
                const ppg = goldPerGramINR ? goldPerGramINR * KARATS[goal.karat] : 0;
                const targetValue = goal.targetGrams * ppg;
                const savedValue = goal.savedGrams * ppg;
                const remaining = goal.targetGrams - goal.savedGrams;
                const pct = goal.targetGrams > 0 ? (goal.savedGrams / goal.targetGrams) * 100 : 0;
                const deadline = new Date(goal.deadline + 'T00:00:00');
                const daysLeft = Math.max(0, Math.ceil((deadline - new Date()) / 86400000));
                const monthsLeft = Math.max(1, Math.ceil(daysLeft / 30));
                const monthlyGrams = remaining > 0 ? remaining / monthsLeft : 0;
                const monthlyCost = monthlyGrams * ppg;
                const typeIcons = { wedding: '💍', festival: '🪔', savings: '🪙', gift: '🎁' };
                return (
                  <div key={goal.id} className="goal-card">
                    <div className="goal-header">
                      <span className="goal-icon">{typeIcons[goal.type] || '🎯'}</span>
                      <span className="goal-name">{goal.name}</span>
                      <button className="del-btn" onClick={() => {
                        const updated = goals.filter(g => g.id !== goal.id);
                        setGoals(updated);
                        localStorage.setItem('bsx_goals', JSON.stringify(updated));
                      }}>✕</button>
                    </div>
                    <div className="goal-progress-bar">
                      <div className="goal-fill" style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <div className="goal-stats">
                      <span>{goal.savedGrams}g of {goal.targetGrams}g ({goal.karat})</span>
                      <span>{pct.toFixed(0)}%</span>
                    </div>
                    <div className="goal-details">
                      <div>Target value: {fmtINR(targetValue)}</div>
                      <div>Saved so far: {fmtINR(savedValue)}</div>
                      <div>Remaining: {remaining.toFixed(1)}g ({fmtINR(remaining * ppg)})</div>
                      <div>Deadline: {deadline.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} ({daysLeft} days)</div>
                    </div>
                    {remaining > 0 && monthlyCost > 0 && (
                      <div className="emi-highlight">
                        <div className="emi-label">Monthly Gold SIP Needed</div>
                        <div className="emi-amount">{fmtINR(monthlyCost)}</div>
                        <div className="emi-detail">{monthlyGrams.toFixed(2)}g/month for {monthsLeft} months</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {goals.length === 0 && (
            <div className="empty-state" style={{ marginTop: 16 }}>
              Plan for your daughter's wedding, festivals, or savings. Set a gold target and track your progress.
            </div>
          )}
        </>
      )}

      {/* ── MODE: Rate Fairness ── */}
      {mode === 'fairness' && (
        <>
          <div className="section-header">Is Your Jeweller's Rate Fair?</div>
          <div className="calc-card">
            <div className="calc-field">
              <label>Jeweller's Quoted Rate (₹ per gram)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={fairRate} onChange={e => setFairRate(e.target.value)} placeholder="e.g. 6400" min="0" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label>Karat</label>
              <div className="karat-row">
                {Object.keys(KARATS).map(k => (
                  <button key={k} className={`sel-btn ${fairKarat === k ? 'active' : ''}`} onClick={() => setFairKarat(k)}>{k}</button>
                ))}
              </div>
            </div>
            <div className="calc-field">
              <label>Purchase Weight (grams)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={fairWeight} onChange={e => setFairWeight(e.target.value)} placeholder="10" min="0" inputMode="decimal" />
            </div>

            {(() => {
              const quoted = parseFloat(fairRate) || 0;
              const marketRate = goldPerGramINR ? goldPerGramINR * KARATS[fairKarat] : 0;
              const weight = parseFloat(fairWeight) || 0;
              if (!quoted || !marketRate) return (
                <div className="calc-result-card">
                  <div className="result-label">Enter the rate your jeweller quoted</div>
                  <div className="result-breakdown">We'll compare it against today's live market rate</div>
                </div>
              );
              const diff = quoted - marketRate;
              const diffPct = (diff / marketRate) * 100;
              const totalOverpay = diff * weight;
              const fairLow = marketRate;
              const fairHigh = marketRate * 1.008; // up to 0.8% above is normal
              const slightHigh = marketRate * 1.02;

              let verdict, verdictClass, verdictIcon;
              if (quoted <= fairHigh) {
                verdict = 'Fair Price'; verdictClass = 'fair-good'; verdictIcon = '✅';
              } else if (quoted <= slightHigh) {
                verdict = 'Slightly Above Market'; verdictClass = 'fair-warn'; verdictIcon = '⚠️';
              } else {
                verdict = 'Overpriced'; verdictClass = 'fair-bad'; verdictIcon = '❌';
              }

              return (
                <div className={`fairness-result ${verdictClass}`}>
                  <div className="fair-verdict">
                    <span className="fair-icon">{verdictIcon}</span>
                    <span className="fair-text">{verdict}</span>
                  </div>
                  <div className="fair-compare">
                    <div className="fair-row">
                      <span>Jeweller's rate:</span>
                      <strong>{fmtINR(quoted, 2)}/g</strong>
                    </div>
                    <div className="fair-row">
                      <span>Market rate ({fairKarat}):</span>
                      <strong>{fmtINR(marketRate, 2)}/g</strong>
                    </div>
                    <div className="fair-row">
                      <span>Difference:</span>
                      <strong style={{ color: diff > 0 ? 'var(--red)' : 'var(--green)' }}>
                        {diff > 0 ? '+' : ''}{fmtINR(diff, 2)}/g ({diffPct > 0 ? '+' : ''}{diffPct.toFixed(2)}%)
                      </strong>
                    </div>
                    {weight > 0 && diff > 0 && (
                      <div className="fair-row" style={{ marginTop: 8, fontWeight: 700 }}>
                        <span>Overpayment on {fairWeight}g:</span>
                        <strong style={{ color: 'var(--red)' }}>{fmtINR(totalOverpay)}</strong>
                      </div>
                    )}
                  </div>
                  <div className="fair-ranges">
                    <div className="fair-range-item">🟢 Fair: up to {fmtINR(fairHigh, 2)}/g</div>
                    <div className="fair-range-item">🟡 Slightly high: {fmtINR(fairHigh, 2)} – {fmtINR(slightHigh, 2)}/g</div>
                    <div className="fair-range-item">🔴 Overpriced: above {fmtINR(slightHigh, 2)}/g</div>
                  </div>
                </div>
              );
            })()}
          </div>
          <p className="disclaimer">* Market rate includes 5% BCD + 1% AIDC. Excludes GST &amp; making charges which are separate.</p>
        </>
      )}

      {/* ── MODE: HUID Verify ── */}
      {mode === 'huid' && (
        <>
          <div className="section-header">Hallmark HUID Verification</div>
          <div className="calc-card">
            <div className="huid-info">
              <div className="huid-what">
                <strong>What is HUID?</strong>
                <p>Every BIS hallmarked gold item in India has a unique 6-character <strong>Hallmark Unique ID (HUID)</strong> engraved on it. This confirms the gold's purity has been tested and certified by a government-approved assaying center.</p>
              </div>
              <div className="huid-where">
                <strong>Where to find it?</strong>
                <p>Look for a tiny alphanumeric code (e.g. A1B2C3) engraved on your gold jewellery, usually near the hallmark symbols (BIS logo, purity mark, assaying center mark).</p>
              </div>
            </div>
            <div className="calc-field">
              <label>Enter HUID Number</label>
              <input type="text" className="num-input" style={{ width: '100%', textTransform: 'uppercase', letterSpacing: 3 }} value={huidInput} onChange={e => setHuidInput(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6))} placeholder="e.g. A1B2C3" maxLength={6} />
            </div>
            <div className="huid-verify-box">
              <div className="huid-display">{huidInput.toUpperCase() || '------'}</div>
              {huidInput.length === 6 && (
                <button className="add-btn" onClick={() => {
                  navigator.clipboard?.writeText(huidInput.toUpperCase());
                }}>Copy HUID</button>
              )}
            </div>

            <div className="huid-methods">
              <div className="section-header">How to Verify</div>
              <div className="huid-method">
                <strong>1. BIS Care App (Recommended)</strong>
                <p>Download <strong>BIS Care App</strong> from Play Store. It has a built-in HUID scanner — just scan the code on your jewellery or enter the HUID manually.</p>
                <a className="huid-link" href="https://play.google.com/store/apps/details?id=com.veridic.biscare" target="_blank" rel="noopener noreferrer">Download BIS Care App →</a>
              </div>
              <div className="huid-method">
                <strong>2. Call BIS Helpline</strong>
                <p>Call <strong>14100</strong> (BIS toll-free) and provide your HUID number. They'll verify it over the phone.</p>
                <a className="huid-link" href="tel:14100">Call 14100 →</a>
              </div>
              <div className="huid-method">
                <strong>3. SMS Verification</strong>
                <p>Send SMS: <strong>HUID {huidInput.toUpperCase() || 'XXXXXX'}</strong> to <strong>14100</strong></p>
              </div>
            </div>
            <div className="huid-tips">
              <div className="section-header" style={{ marginTop: 16 }}>How to Read Hallmark</div>
              <div className="huid-symbols">
                <div className="huid-symbol-row">
                  <span className="huid-symbol-icon">◈</span>
                  <div><strong>BIS Logo</strong> — Confirms it's tested by Bureau of Indian Standards</div>
                </div>
                <div className="huid-symbol-row">
                  <span className="huid-symbol-icon">999</span>
                  <div><strong>Purity Grade</strong> — 999 (24K), 916 (22K), 750 (18K), 585 (14K), 375 (9K)</div>
                </div>
                <div className="huid-symbol-row">
                  <span className="huid-symbol-icon">A1B2C3</span>
                  <div><strong>HUID</strong> — 6-character unique ID to verify authenticity online</div>
                </div>
              </div>
            </div>
            <div className="huid-alert">
              <strong>⚠️ No HUID?</strong> If your gold jewellery doesn't have a HUID number, it may not be hallmarked. Since June 2021, hallmarking is mandatory for gold jewellery sold in India. Ask your jeweller for hallmarked gold only.
            </div>
          </div>
        </>
      )}

      {/* ── MODE: By Weight ── */}
      {mode === 'weight' && (
        <>
          <div className="section-header">Metal Value Calculator</div>
          <div className="calc-card">
            <div className="calc-field">
              <label>Metal</label>
              <div className="toggle-row">
                {['gold', 'silver', 'platinum'].map(m => (
                  <button key={m} className={`toggle-btn ${wMetal === m ? 'active' : ''}`} onClick={() => setWMetal(m)}>
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="calc-field">
              <label>Weight</label>
              <div className="input-row">
                <input
                  type="number"
                  className="num-input"
                  value={weight}
                  onChange={e => setWeight(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                />
                <select className="unit-select" value={unit} onChange={e => setUnit(e.target.value)}>
                  <option value="gram">Gram</option>
                  <option value="tola">Tola</option>
                  <option value="oz">Troy Oz</option>
                  <option value="kg">Kilogram</option>
                </select>
              </div>
            </div>

            {wMetal === 'gold' && (
              <div className="calc-field">
                <label>Karat</label>
                <div className="karat-row">
                  {Object.keys(KARATS).map(k => (
                    <button key={k} className={`sel-btn ${karat === k ? 'active' : ''}`} onClick={() => setKarat(k)}>
                      {k}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="calc-result-card">
              <div className="result-label">Estimated Value (INR)</div>
              <div className="result-amount">{weightResult ? fmtINR(weightResult) : '₹ —'}</div>
              {weightResult && (
                <div className="result-breakdown">
                  {weight} {unit} · {wMetal === 'gold' ? `${karat} · ` : ''}{fmtINR(wPricePerGram, 2)}/g
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── MODE: By Amount ── */}
      {mode === 'amount' && (
        <>
          <div className="section-header">How Much Can I Buy?</div>
          <div className="calc-card">
            <div className="calc-field">
              <label>Your Budget (₹)</label>
              <input
                type="number"
                className="num-input"
                style={{ width: '100%' }}
                value={amountINR}
                onChange={e => setAmountINR(e.target.value)}
                placeholder="e.g. 50000"
                min="0"
                step="100"
                inputMode="decimal"
              />
            </div>

            <div className="calc-field">
              <label>Metal</label>
              <div className="toggle-row">
                {['gold', 'silver', 'platinum'].map(m => (
                  <button key={m} className={`toggle-btn ${amtMetal === m ? 'active' : ''}`} onClick={() => setAmtMetal(m)}>
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {amtMetal === 'gold' && (
              <div className="calc-field">
                <label>Karat</label>
                <div className="karat-row">
                  {Object.keys(KARATS).map(k => (
                    <button key={k} className={`sel-btn ${amtKarat === k ? 'active' : ''}`} onClick={() => setAmtKarat(k)}>
                      {k}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="calc-result-card">
              <div className="result-label">
                {fmtINR(budget || null)} buys you
              </div>
              <div className="result-amount">
                {gramsYouGet ? `${gramsYouGet.toFixed(3)} g` : '— g'}
              </div>
              {gramsYouGet && (
                <div className="result-breakdown" style={{ lineHeight: 1.8 }}>
                  {tolaYouGet && <span>{tolaYouGet.toFixed(4)} tola  ·  </span>}
                  {ozYouGet   && <span>{ozYouGet.toFixed(4)} troy oz</span>}
                  {sovYouGet  && <span>  ·  {sovYouGet.toFixed(3)} sovereign</span>}
                </div>
              )}
              {!ppg && <div className="result-breakdown">Price data unavailable</div>}
            </div>
          </div>
        </>
      )}

      {/* ── MODE: Jewellery Cost ── */}
      {mode === 'jewellery' && (
        <>
          <div className="section-header">Jewellery Price Calculator</div>
          <div className="calc-card">
            <div className="calc-field">
              <label>Gold Weight (grams)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={jwlWeight} onChange={e => setJwlWeight(e.target.value)} placeholder="e.g. 15" min="0" step="0.01" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label>Karat</label>
              <div className="karat-row">
                {Object.keys(KARATS).map(k => (
                  <button key={k} className={`sel-btn ${jwlKarat === k ? 'active' : ''}`} onClick={() => setJwlKarat(k)}>{k}</button>
                ))}
              </div>
            </div>
            <div className="calc-field">
              <label>Making Charge (%)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={jwlMaking} onChange={e => setJwlMaking(e.target.value)} placeholder="12" min="0" max="50" step="0.5" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label>Wastage (%)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={jwlWastage} onChange={e => setJwlWastage(e.target.value)} placeholder="2" min="0" max="20" step="0.5" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={jwlGst} onChange={e => setJwlGst(e.target.checked)} />
                Include GST (3%)
              </label>
            </div>

            {(() => {
              const w = parseFloat(jwlWeight) || 0;
              const ppg = goldPerGramINR ? goldPerGramINR * KARATS[jwlKarat] : 0;
              const goldCost = w * ppg;
              const makingCost = goldCost * ((parseFloat(jwlMaking) || 0) / 100);
              const wastageCost = goldCost * ((parseFloat(jwlWastage) || 0) / 100);
              const subtotal = goldCost + makingCost + wastageCost;
              const gst = jwlGst ? subtotal * 0.03 : 0;
              const total = subtotal + gst;
              return (
                <div className="calc-result-card">
                  <div className="result-label">Cost Breakdown</div>
                  {w > 0 && ppg > 0 && (
                    <div className="result-breakdown" style={{ lineHeight: 2 }}>
                      <div>Gold ({jwlKarat}, {jwlWeight}g): {fmtINR(goldCost)}</div>
                      <div>Making ({jwlMaking}%): {fmtINR(makingCost)}</div>
                      <div>Wastage ({jwlWastage}%): {fmtINR(wastageCost)}</div>
                      {jwlGst && <div>GST (3%): {fmtINR(gst)}</div>}
                    </div>
                  )}
                  <div className="result-amount">{total > 0 ? fmtINR(total) : '₹ —'}</div>
                </div>
              );
            })()}
          </div>
        </>
      )}

      {/* ── MODE: Scrap Gold ── */}
      {mode === 'scrap' && (
        <>
          <div className="section-header">Scrap / Old Gold Value</div>
          <div className="calc-card">
            <div className="calc-field">
              <label>Gold Weight (grams)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={scrapWeight} onChange={e => setScrapWeight(e.target.value)} placeholder="e.g. 25" min="0" step="0.01" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label>Purity / Karat</label>
              <div className="karat-row">
                {Object.keys(KARATS).map(k => (
                  <button key={k} className={`sel-btn ${scrapKarat === k ? 'active' : ''}`} onClick={() => setScrapKarat(k)}>{k}</button>
                ))}
              </div>
            </div>
            <div className="calc-field">
              <label>Dealer Margin (%) — typically 3-6%</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={scrapMargin} onChange={e => setScrapMargin(e.target.value)} placeholder="4" min="0" max="20" step="0.5" inputMode="decimal" />
            </div>

            {(() => {
              const w = parseFloat(scrapWeight) || 0;
              const ppg = goldPerGramINR ? goldPerGramINR * KARATS[scrapKarat] : 0;
              const marketValue = w * ppg;
              const margin = marketValue * ((parseFloat(scrapMargin) || 0) / 100);
              const youGet = marketValue - margin;
              return (
                <div className="calc-result-card">
                  <div className="result-label">Estimated Value</div>
                  {w > 0 && ppg > 0 && (
                    <div className="result-breakdown" style={{ lineHeight: 2 }}>
                      <div>Market value ({scrapKarat}, {scrapWeight}g): {fmtINR(marketValue)}</div>
                      <div>Dealer margin ({scrapMargin}%): -{fmtINR(margin)}</div>
                    </div>
                  )}
                  <div className="result-amount">{youGet > 0 ? fmtINR(youGet) : '₹ —'}</div>
                  <div className="result-breakdown">What a dealer will likely pay you</div>
                </div>
              );
            })()}
          </div>
        </>
      )}

      {/* ── MODE: Gold Loan ── */}
      {mode === 'loan' && (
        <>
          <div className="section-header">Gold Loan Calculator</div>
          <div className="calc-card">
            <div className="calc-field">
              <label>Gold Weight (grams)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={loanWeight} onChange={e => setLoanWeight(e.target.value)} placeholder="e.g. 50" min="0" step="0.01" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label>Karat</label>
              <div className="karat-row">
                {Object.keys(KARATS).map(k => (
                  <button key={k} className={`sel-btn ${loanKarat === k ? 'active' : ''}`} onClick={() => setLoanKarat(k)}>{k}</button>
                ))}
              </div>
            </div>
            <div className="calc-field">
              <label>Loan-to-Value Ratio</label>
              <div className="toggle-row">
                <button className={`toggle-btn ${loanLtv === '75' ? 'active' : ''}`} onClick={() => { setLoanLtv('75'); setLoanRate('7.5'); }}>Bank (75%)</button>
                <button className={`toggle-btn ${loanLtv === '65' ? 'active' : ''}`} onClick={() => { setLoanLtv('65'); setLoanRate('12'); }}>NBFC (65%)</button>
              </div>
            </div>
            <div className="calc-field">
              <label>Interest Rate (% p.a.)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={loanRate} onChange={e => setLoanRate(e.target.value)} placeholder="7.5" min="0" max="30" step="0.1" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label>Tenure (months)</label>
              <div className="karat-selector">
                {['6', '12', '24', '36'].map(t => (
                  <button key={t} className={`sel-btn ${loanTenure === t ? 'active' : ''}`} onClick={() => setLoanTenure(t)}>{t}mo</button>
                ))}
              </div>
            </div>

            {(() => {
              const w = parseFloat(loanWeight) || 0;
              const ppg = goldPerGramINR ? goldPerGramINR * KARATS[loanKarat] : 0;
              const goldValue = w * ppg;
              const ltv = (parseFloat(loanLtv) || 75) / 100;
              const loanAmt = goldValue * ltv;
              const rate = (parseFloat(loanRate) || 7.5) / 100;
              const tenure = parseInt(loanTenure) || 12;
              // EMI calculation (reducing balance)
              const monthlyRate = rate / 12;
              const emi = monthlyRate > 0 && tenure > 0 ? loanAmt * monthlyRate * Math.pow(1 + monthlyRate, tenure) / (Math.pow(1 + monthlyRate, tenure) - 1) : 0;
              const totalPayable = emi * tenure;
              const totalInterest = totalPayable - loanAmt;
              return (
                <div className="calc-result-card">
                  <div className="result-label">Loan Details</div>
                  {w > 0 && ppg > 0 && (
                    <div className="result-breakdown" style={{ lineHeight: 2 }}>
                      <div>Gold value ({loanKarat}, {loanWeight}g): {fmtINR(goldValue)}</div>
                      <div>Loan amount ({loanLtv}% LTV): {fmtINR(loanAmt)}</div>
                      <div>Interest rate: {loanRate}% p.a.</div>
                      <div>Tenure: {tenure} months</div>
                    </div>
                  )}
                  <div className="result-amount">{loanAmt > 0 ? fmtINR(loanAmt) : '₹ —'}</div>
                  <div className="result-breakdown">Maximum loan you can get</div>
                  {emi > 0 && (
                    <div className="emi-highlight">
                      <div className="emi-label">Monthly EMI</div>
                      <div className="emi-amount">{fmtINR(emi)}</div>
                      <div className="emi-detail">Total payable: {fmtINR(totalPayable)} (Interest: {fmtINR(totalInterest)})</div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </>
      )}

      {/* ── MODE: Family Gold Diary ── */}
      {mode === 'portfolio' && (
        <>
          <div className="section-header">Family Gold Diary</div>
          <div className="calc-card">
            <div className="calc-field">
              <label>Family Member</label>
              <input type="text" className="num-input" style={{ width: '100%' }} value={pfMember} onChange={e => setPfMember(e.target.value)} placeholder="e.g. Wife, Mom, Self" />
            </div>
            <div className="calc-field">
              <label>Type</label>
              <div className="karat-selector">
                {[['jewellery', 'Jewellery'], ['coin', 'Coin'], ['bar', 'Bar'], ['digital', 'Digital']].map(([v, l]) => (
                  <button key={v} className={`sel-btn ${pfType === v ? 'active' : ''}`} onClick={() => setPfType(v)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="calc-field">
              <label>Metal</label>
              <div className="toggle-row">
                {['gold', 'silver', 'platinum'].map(m => (
                  <button key={m} className={`toggle-btn ${pfMetal === m ? 'active' : ''}`} onClick={() => setPfMetal(m)}>{m.charAt(0).toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
            </div>
            {pfMetal === 'gold' && (
              <div className="calc-field">
                <label>Karat</label>
                <div className="karat-row">
                  {['24K', '22K', '18K'].map(k => (
                    <button key={k} className={`sel-btn ${pfKarat === k ? 'active' : ''}`} onClick={() => setPfKarat(k)}>{k}</button>
                  ))}
                </div>
              </div>
            )}
            <div className="calc-field">
              <label>Weight (grams)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={pfWeight} onChange={e => setPfWeight(e.target.value)} placeholder="e.g. 50" min="0" step="0.01" inputMode="decimal" />
            </div>
            <div className="calc-field">
              <label>Buy Price per gram (₹)</label>
              <input type="number" className="num-input" style={{ width: '100%' }} value={pfPrice} onChange={e => setPfPrice(e.target.value)} placeholder="e.g. 6500" min="0" step="1" inputMode="decimal" />
            </div>
            <button className="add-btn" onClick={() => {
              const w = parseFloat(pfWeight); const p = parseFloat(pfPrice);
              if (!w || !p || w <= 0 || p <= 0) return;
              const updated = [...portfolio, { id: Date.now(), member: pfMember || 'Self', type: pfType, metal: pfMetal, karat: pfMetal === 'gold' ? pfKarat : null, weight: w, buyPrice: p }];
              setPortfolio(updated);
              localStorage.setItem('bsx_portfolio', JSON.stringify(updated));
              setPfWeight(''); setPfPrice('');
            }}>+ Add Holding</button>
          </div>

          {portfolio.length > 0 && (
            <>
              {(() => {
                let totalInvested = 0, totalCurrent = 0;
                const rows = portfolio.map(h => {
                  const currentPpg = h.metal === 'gold' ? (goldPerGramINR || 0) * (h.karat ? KARATS[h.karat] : 1) : h.metal === 'silver' ? (silverPerGramINR || 0) : (platPerGramINR || 0);
                  const invested = h.weight * h.buyPrice;
                  const current = h.weight * currentPpg;
                  const pnl = current - invested;
                  const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;
                  totalInvested += invested;
                  totalCurrent += current;
                  return { ...h, invested, current, pnl, pnlPct };
                });
                const totalPnl = totalCurrent - totalInvested;
                const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
                // Group by family member
                const members = [...new Set(rows.map(h => h.member || 'Self'))];
                const typeIcons = { jewellery: '💍', coin: '🪙', bar: '▬', digital: '📱' };
                return (
                  <>
                    {members.map(member => {
                      const memberRows = rows.filter(h => (h.member || 'Self') === member);
                      const memberTotal = memberRows.reduce((s, h) => s + h.current, 0);
                      return (
                        <div key={member}>
                          <div className="section-header">{member} — {fmtINR(memberTotal)}</div>
                          {memberRows.map(h => (
                            <div key={h.id} className="portfolio-row">
                              <div className="pf-info">
                                <span className="pf-metal">{typeIcons[h.type] || ''} {h.metal.toUpperCase()}{h.karat ? ` ${h.karat}` : ''}</span>
                                <span className="pf-weight">{h.weight}g @ {fmtINR(h.buyPrice)}/g</span>
                              </div>
                              <div className="pf-values">
                                <span className="pf-current">{fmtINR(h.current)}</span>
                                <span className={`pf-pnl ${h.pnl >= 0 ? 'up' : 'down'}`}>{h.pnl >= 0 ? '+' : ''}{fmtINR(h.pnl)} ({h.pnlPct.toFixed(1)}%)</span>
                              </div>
                              <button className="del-btn" onClick={() => {
                                const updated = portfolio.filter(p => p.id !== h.id);
                                setPortfolio(updated);
                                localStorage.setItem('bsx_portfolio', JSON.stringify(updated));
                              }}>✕</button>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    <div className="portfolio-total">
                      <div><span>Total Family Gold:</span> <strong>{fmtN(rows.reduce((s, h) => s + h.weight, 0), 1)}g</strong></div>
                      <div><span>Invested:</span> <strong>{fmtINR(totalInvested)}</strong></div>
                      <div><span>Current Value:</span> <strong>{fmtINR(totalCurrent)}</strong></div>
                      <div className={totalPnl >= 0 ? 'up' : 'down'}><span>P&L:</span> <strong>{totalPnl >= 0 ? '+' : ''}{fmtINR(totalPnl)} ({totalPnlPct.toFixed(1)}%)</strong></div>
                    </div>
                  </>
                );
              })()}
            </>
          )}
        </>
      )}

      <p className="disclaimer">
        * Includes 5% BCD + 1% AIDC. Excludes 3% GST &amp; making charges.
      </p>
    </div>
  );
}

// ─── Chart Components ─────────────────────────────────────────────────────────

const CHART_RANGES = [
  { label: '1m',  range: '1d',  interval: '1m',  trimMs: 60 * 1000 },
  { label: '15m', range: '1d',  interval: '1m',  trimMs: 15 * 60 * 1000 },
  { label: '2h',  range: '1d',  interval: '1m',  trimMs: 2 * 60 * 60 * 1000 },
  { label: '1D',  range: '1d',  interval: '15m' },
  { label: '5D',  range: '5d',  interval: '1h' },
  { label: '1M',  range: '1mo', interval: '1d' },
  { label: '3M',  range: '3mo', interval: '1d' },
  { label: '1Y',  range: '1y',  interval: '1wk' },
];

const CHART_SYMBOLS = [
  { key: 'GC=F', label: 'Gold' },
  { key: 'SI=F', label: 'Silver' },
  { key: 'PL=F', label: 'Platinum' },
  { key: 'USDINR=X', label: 'USD/INR' },
];

function MiniChart({ data }) {
  if (!data || data.length < 2) return <div className="chart-empty">No data available</div>;

  const prices = data.map(d => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const W = 340, H = 180;
  const pad = { top: 10, right: 10, bottom: 30, left: 60 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const pts = data.map((d, i) => {
    const x = pad.left + (i / (data.length - 1)) * cW;
    const y = pad.top + (1 - (d.price - min) / range) * cH;
    return `${x},${y}`;
  });

  const line = pts.join(' ');
  const area = `${pad.left},${pad.top + cH} ${line} ${pad.left + cW},${pad.top + cH}`;

  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? 'var(--green)' : 'var(--red)';

  const yVals = [min, min + range * 0.5, max];
  const xIdxs = [0, Math.floor(data.length / 4), Math.floor(data.length / 2), Math.floor(data.length * 3 / 4), data.length - 1];

  // Pick date format based on data span
  const spanMs = data[data.length - 1].time - data[0].time;
  const isIntraday = spanMs < 2 * 86400000;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      {yVals.map((val, i) => {
        const y = pad.top + (1 - (val - min) / range) * cH;
        return (
          <g key={i}>
            <line x1={pad.left} y1={y} x2={W - pad.right} y2={y} stroke="var(--chart-grid)" />
            <text x={pad.left - 5} y={y + 4} textAnchor="end" fill="var(--chart-label)" fontSize="9" fontFamily="var(--mono)">
              {val < 100 ? val.toFixed(2) : Math.round(val).toLocaleString('en-IN')}
            </text>
          </g>
        );
      })}
      <polygon points={area} fill={isUp ? 'var(--green)' : 'var(--red)'} opacity="0.1" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      {xIdxs.map(idx => {
        if (idx >= data.length) return null;
        const d = data[idx];
        const x = pad.left + (idx / (data.length - 1)) * cW;
        const label = isIntraday
          ? new Date(d.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
          : new Date(d.time).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        return (
          <text key={idx} x={x} y={H - 5} textAnchor="middle" fill="var(--chart-axis)" fontSize="8.5">
            {label}
          </text>
        );
      })}
    </svg>
  );
}

function ChartTab() {
  const [symbol, setSymbol] = useState('GC=F');
  const [rangeIdx, setRangeIdx] = useState(3);
  const [chartData, setChartData] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const r = CHART_RANGES[rangeIdx];
    const load = async () => {
      setChartLoading(true);
      try {
        let d = await fetchChartData(symbol, r.range, r.interval);
        if (r.trimMs && d.length > 1) {
          const cutoff = d[d.length - 1].time - r.trimMs;
          d = d.filter(p => p.time >= cutoff);
        }
        if (!cancelled) setChartData(d);
      } catch {
        if (!cancelled) setChartData(null);
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [symbol, rangeIdx]);

  const lastP = chartData?.[chartData.length - 1]?.price;
  const firstP = chartData?.[0]?.price;
  const chg = lastP && firstP ? lastP - firstP : null;
  const chgPct = chg && firstP ? (chg / firstP) * 100 : null;
  const isFx = symbol.includes('INR');

  return (
    <div className="tab-content fade-in">
      <div className="section-header">Price Chart</div>

      <div className="karat-selector">
        {CHART_SYMBOLS.map(s => (
          <button key={s.key} className={`sel-btn ${symbol === s.key ? 'active' : ''}`} onClick={() => setSymbol(s.key)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="karat-selector" style={{ marginTop: 8 }}>
        {CHART_RANGES.map((r, i) => (
          <button key={r.label} className={`sel-btn ${rangeIdx === i ? 'active' : ''}`} onClick={() => setRangeIdx(i)}>
            {r.label}
          </button>
        ))}
      </div>

      {lastP != null && (
        <div className="chart-info">
          <span className="chart-price mono">{isFx ? fmtN(lastP, 2) : fmtUSD(lastP)}</span>
          {chg != null && <PriceChange change={chg} changePct={chgPct} />}
          <span className="chart-range-label">{CHART_RANGES[rangeIdx].label} change</span>
        </div>
      )}

      <div className="chart-container">
        {chartLoading && <div className="chart-loading"><div className="spinner" /></div>}
        {!chartLoading && chartData && <MiniChart data={chartData} />}
        {!chartLoading && !chartData && <div className="chart-empty">Could not load chart data</div>}
      </div>

      {chartData && (
        <div className="ref-table" style={{ marginTop: 12 }}>
          <div className="ref-row">
            <span className="ref-label">High</span>
            <span className="ref-value">{isFx ? fmtN(Math.max(...chartData.map(d => d.price)), 2) : fmtUSD(Math.max(...chartData.map(d => d.price)))}</span>
          </div>
          <div className="ref-row">
            <span className="ref-label">Low</span>
            <span className="ref-value">{isFx ? fmtN(Math.min(...chartData.map(d => d.price)), 2) : fmtUSD(Math.min(...chartData.map(d => d.price)))}</span>
          </div>
          <div className="ref-row">
            <span className="ref-label">Open</span>
            <span className="ref-value">{isFx ? fmtN(firstP, 2) : fmtUSD(firstP)}</span>
          </div>
          <div className="ref-row">
            <span className="ref-label">Current</span>
            <span className="ref-value">{isFx ? fmtN(lastP, 2) : fmtUSD(lastP)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Alerts Tab ───────────────────────────────────────────────────────────────
function AlertsTab({ prices, alerts, setAlerts, goldPer10gINR, silverPerKgINR, platPer10gINR }) {
  const [metal, setMetal]         = useState('gold');
  const [direction, setDirection] = useState('above');
  const [currency, setCurrency]   = useState('usd');
  const [target, setTarget]       = useState('');

  const placeholder = () => {
    if (currency === 'usd') {
      if (metal === 'silver') return 'e.g. 32.50';
      return 'e.g. 2800';
    }
    if (metal === 'silver') return 'e.g. 90000';
    return 'e.g. 75000';
  };

  const currencyLabel = () => {
    if (currency === 'usd') return 'USD / oz';
    if (metal === 'silver') return 'INR / kg';
    return 'INR / 10g';
  };

  const addAlert = () => {
    const t = parseFloat(target);
    if (!t || t <= 0) return;
    setAlerts(prev => [...prev, {
      id: Date.now(),
      metal,
      direction,
      currency,
      target: t,
      triggered: false,
      createdAt: Date.now(),
    }]);
    setTarget('');
  };

  const removeAlert = (id) => setAlerts(prev => prev.filter(a => a.id !== id));

  const metalBadgeClass = (m) => ({
    gold: 'badge-gold', silver: 'badge-silver', platinum: 'badge-platinum'
  }[m] || 'badge-gold');

  return (
    <div className="tab-content fade-in">
      <div className="section-header">Set Price Alert</div>

      <div className="alert-form-card">
        <div className="form-field">
          <label>Metal</label>
          <select className="form-select" value={metal} onChange={e => setMetal(e.target.value)}>
            <option value="gold">Gold</option>
            <option value="silver">Silver</option>
            <option value="platinum">Platinum</option>
          </select>
        </div>

        <div className="form-field">
          <label>Trigger When Price Goes</label>
          <div className="toggle-row">
            <button className={`toggle-btn ${direction === 'above' ? 'active' : ''}`} onClick={() => setDirection('above')}>
              ▲ Above
            </button>
            <button className={`toggle-btn ${direction === 'below' ? 'active' : ''}`} onClick={() => setDirection('below')}>
              ▼ Below
            </button>
          </div>
        </div>

        <div className="form-field">
          <label>Price In</label>
          <div className="toggle-row">
            <button className={`toggle-btn ${currency === 'usd' ? 'active' : ''}`} onClick={() => setCurrency('usd')}>
              USD / oz
            </button>
            <button className={`toggle-btn ${currency === 'inr' ? 'active' : ''}`} onClick={() => setCurrency('inr')}>
              {metal === 'silver' ? 'INR / kg' : 'INR / 10g'}
            </button>
          </div>
        </div>

        <div className="form-field">
          <label>Target Price ({currencyLabel()})</label>
          <input
            type="number"
            className="price-input"
            value={target}
            onChange={e => setTarget(e.target.value)}
            placeholder={placeholder()}
            min="0"
            step="0.01"
            inputMode="decimal"
          />
        </div>

        <button className="add-btn" onClick={addAlert} disabled={!target || parseFloat(target) <= 0}>
          + Add Alert
        </button>
      </div>

      {/* Current price reference */}
      <div className="current-ref">
        <div className="ref-grid">
          <div className="ref-metal">
            <div className="ref-metal-name">Gold</div>
            <div className="ref-metal-price">{fmtUSD(prices?.gold?.price)}</div>
            <div className="ref-metal-sub">{fmtINR(goldPer10gINR)}/10g</div>
          </div>
          <div className="ref-metal">
            <div className="ref-metal-name">Silver</div>
            <div className="ref-metal-price">{fmtUSD(prices?.silver?.price, 3)}</div>
            <div className="ref-metal-sub">{fmtINR(silverPerKgINR)}/kg</div>
          </div>
          <div className="ref-metal">
            <div className="ref-metal-name">Plat.</div>
            <div className="ref-metal-price">{fmtUSD(prices?.platinum?.price)}</div>
            <div className="ref-metal-sub">{fmtINR(platPer10gINR)}/10g</div>
          </div>
        </div>
      </div>

      <div className="section-header">Active Alerts ({alerts.filter(a => !a.triggered).length})</div>

      {alerts.length === 0 && (
        <div className="empty-state">No alerts set. Add one above.</div>
      )}

      <div className="alert-list">
        {alerts.map(alert => {
          const currentPrice = getAlertCurrentPrice(alert, prices);
          const isTriggered = alert.triggered || (
            currentPrice != null && (
              alert.direction === 'above' ? currentPrice >= alert.target : currentPrice <= alert.target
            )
          );
          const fmtTarget = alert.currency === 'usd' ? fmtUSD(alert.target) : fmtINR(alert.target);
          const unitLabel = alert.currency === 'usd' ? '/oz' : (alert.metal === 'silver' ? '/kg' : '/10g');

          return (
            <div key={alert.id} className={`alert-item ${isTriggered ? 'triggered' : ''}`}>
              <div className="alert-meta">
                <span className={`alert-badge ${metalBadgeClass(alert.metal)}`}>
                  {alert.metal.toUpperCase()}
                </span>
                <span className={`alert-arrow ${alert.direction === 'above' ? 'up' : 'down'}`}>
                  {alert.direction === 'above' ? '▲' : '▼'}
                </span>
                <span className="alert-target mono">
                  {fmtTarget}<span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{unitLabel}</span>
                </span>
                {isTriggered && <span className="triggered-chip">HIT</span>}
              </div>
              <button className="del-btn" onClick={() => removeAlert(alert.id)}>✕</button>
            </div>
          );
        })}
      </div>

      {alerts.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button
            className="del-btn"
            style={{ width: 'auto', padding: '8px 20px', fontSize: 12 }}
            onClick={() => setAlerts([])}
          >
            Clear All
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [prices, setPrices]             = useState(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [activeTab, setActiveTab]       = useState('gold');
  const [refreshInterval, setRefreshInterval] = useState(DEFAULT_REFRESH);
  const [countdown, setCountdown]       = useState(DEFAULT_REFRESH);
  const [lastUpdated, setLastUpdated]   = useState(null);
  const [showIntervalPicker, setShowIntervalPicker] = useState(false);
  const [tabCount, setTabCount]         = useState(0);
  const [toasts, setToasts]             = useState([]);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('bsx_theme') || 'light'; }
    catch { return 'light'; }
  });
  const [alerts, setAlerts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bullion_alerts') || '[]'); }
    catch { return []; }
  });

  const [founderMode, setFounderMode] = useState(() => {
    try { return localStorage.getItem('bsx_founder') === '1'; }
    catch { return false; }
  });

  const alertsRef = useRef(alerts);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bsx_theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  // Founder mode — long-press title 3s to toggle, hides all ads
  const founderTimer = useRef(null);
  const handleTitleDown = () => {
    founderTimer.current = setTimeout(() => {
      setFounderMode(prev => {
        const next = !prev;
        localStorage.setItem('bsx_founder', next ? '1' : '0');
        if (next) { hideBanner(); }
        else { showBanner(); }
        return next;
      });
    }, 10000);
  };
  const handleTitleUp = () => { if (founderTimer.current) clearTimeout(founderTimer.current); };

  // On mount, hide banner if founder mode is on
  useEffect(() => {
    if (founderMode) hideBanner();
  }, [founderMode]);

  // Persist alerts
  useEffect(() => {
    localStorage.setItem('bullion_alerts', JSON.stringify(alerts));
  }, [alerts]);

  // Fetch
  const fetchPrices = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchAllPrices();
      setPrices(data);
      setLastUpdated(new Date());
      setCountdown(prev => prev); // reset handled in timer effect

      // Check alerts
      const current = alertsRef.current;
      const newlyTriggered = [];
      const updated = current.map(a => {
        if (a.triggered) return a;
        const cp = getAlertCurrentPrice(a, data);
        if (cp == null) return a;
        const hit = a.direction === 'above' ? cp >= a.target : cp <= a.target;
        if (hit) {
          newlyTriggered.push(a);
          return { ...a, triggered: true };
        }
        return a;
      });
      if (newlyTriggered.length) {
        alertsRef.current = updated;
        setAlerts(updated);
        setToasts(prev => [
          ...prev,
          ...newlyTriggered.map(a => ({
            id: Date.now() + Math.random(),
            text: `${a.metal.toUpperCase()} hit your target of ${a.currency === 'usd' ? fmtUSD(a.target) : fmtINR(a.target)}`,
          })),
        ]);
      }
    } catch {
      setError('Could not fetch prices. Tap refresh to retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => { fetchPrices(); }, [fetchPrices]);

  // Countdown timer + auto-refresh
  const refreshRef = useRef(refreshInterval);
  useEffect(() => { refreshRef.current = refreshInterval; }, [refreshInterval]);

  useEffect(() => {
    setCountdown(refreshInterval);
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          fetchPrices();
          return refreshRef.current;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [fetchPrices, refreshInterval]);

  // Dismiss toasts after 5s
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => {
      setToasts(prev => prev.slice(1));
    }, 5000);
    return () => clearTimeout(t);
  }, [toasts]);

  // Tab switch
  const handleTabSwitch = (id) => {
    if (id === activeTab) return;
    const newCount = tabCount + 1;
    setTabCount(newCount);
    setActiveTab(id);
    if (newCount % 5 === 0 && !founderMode) {
      showInterstitial();
    }
  };

  // Derived calculations
  const usdInrPrice      = prices?.usdInr?.price;
  const goldPerGramINR   = prices?.gold?.price && usdInrPrice ? (prices.gold.price / TROY_OZ) * usdInrPrice * INDIA_DUTY_FACTOR : null;
  const goldPer10gINR    = goldPerGramINR ? goldPerGramINR * 10 : null;
  const silverPerGramINR = prices?.silver?.price && usdInrPrice ? (prices.silver.price / TROY_OZ) * usdInrPrice * INDIA_DUTY_FACTOR : null;
  const platPerGramINR   = prices?.platinum?.price && usdInrPrice ? (prices.platinum.price / TROY_OZ) * usdInrPrice * INDIA_DUTY_FACTOR : null;

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <div className="header-left">
          <span className="live-dot" />
          <h1
            className="app-title"
            onTouchStart={handleTitleDown}
            onTouchEnd={handleTitleUp}
            onMouseDown={handleTitleDown}
            onMouseUp={handleTitleUp}
            onMouseLeave={handleTitleUp}
          >BS BullionX</h1>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☽'}
          </button>
          <button className="theme-toggle" onClick={() => shareRateCard(prices, goldPerGramINR, goldPer10gINR, silverPerGramINR)} title="Share rates">
            ↗
          </button>
        </div>
        <div className="header-right">
          <div className="header-meta">
            <span
              className="countdown clickable"
              onClick={() => setShowIntervalPicker(p => !p)}
              title="Change refresh interval"
            >
              {countdown}s
            </span>
            {lastUpdated && <span className="last-updated">{fmtTime(lastUpdated)}</span>}
          </div>
          <button
            className={`refresh-btn ${loading ? 'spinning' : ''}`}
            onClick={fetchPrices}
            disabled={loading}
            title="Refresh prices"
          >
            ↻
          </button>
        </div>
      </header>

      {/* ── Interval Picker ── */}
      {showIntervalPicker && (
        <div className="interval-picker">
          <span className="interval-label">Refresh every:</span>
          {REFRESH_INTERVALS.map(opt => (
            <button
              key={opt.value}
              className={`interval-btn ${refreshInterval === opt.value ? 'active' : ''}`}
              onClick={() => { setRefreshInterval(opt.value); setShowIntervalPicker(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Ticker ── */}
      <Ticker
        prices={prices}
        goldPerGramINR={goldPerGramINR}
        silverPerGramINR={silverPerGramINR}
      />

      {/* ── Ad-Free / Watch Ad Strip ── */}
      {!founderMode && <AdStrip />}

      {/* ── Content ── */}
      <main className="content">
        {loading && !prices && (
          <div className="loading-screen">
            <div className="spinner" />
            <p className="loading-text">Fetching live prices…</p>
          </div>
        )}

        {error && !prices && (
          <div className="error-screen">
            <span>{error}</span>
            <button className="retry-btn" onClick={fetchPrices}>Retry</button>
          </div>
        )}

        {prices && (
          <>
            {activeTab === 'gold'     && <GoldTab     prices={prices} goldPerGramINR={goldPerGramINR} goldPer10gINR={goldPer10gINR} />}
            {activeTab === 'silver'   && <SilverTab   prices={prices} silverPerGramINR={silverPerGramINR} />}
            {activeTab === 'platinum' && <PlatinumTab prices={prices} platPerGramINR={platPerGramINR} />}
            {activeTab === 'charts'   && <ChartTab />}
            {activeTab === 'forex'    && <ForexTab    prices={prices} />}
            {activeTab === 'cities'   && <CitiesTab   goldPer10gINR={goldPer10gINR} />}
            {activeTab === 'calc'     && <CalculatorTab goldPerGramINR={goldPerGramINR} silverPerGramINR={silverPerGramINR} platPerGramINR={platPerGramINR} />}
            {activeTab === 'alerts'   && (
              <AlertsTab
                prices={prices}
                alerts={alerts}
                setAlerts={setAlerts}
                goldPer10gINR={goldPer10gINR}
                silverPerKgINR={silverPerGramINR ? silverPerGramINR * 1000 : null}
                platPer10gINR={platPerGramINR ? platPerGramINR * 10 : null}
              />
            )}
          </>
        )}
      </main>

      {/* ── Bottom Nav ── */}
      <nav className="bottom-nav">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`nav-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => handleTabSwitch(tab.id)}
          >
            <span className="nav-icon">{tab.icon}</span>
            <span className="nav-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* ── Alert Toasts ── */}
      {toasts.slice(0, 1).map(toast => (
        <div key={toast.id} className="alert-toast" onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}>
          <span className="toast-icon">🔔</span> {toast.text}
          <div className="toast-dismiss">Tap to dismiss</div>
        </div>
      ))}
    </div>
  );
}
