#!/usr/bin/env node
// scripts/signals.js — cron every 5 min, market hours
// STOICTA: SFP, B&R, CISD-Fib, SBS (move origin)
// Macro bias: Daily SMA 20/200 from Yahoo 2y daily bars

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const env       = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

import * as coreChart   from '../src/core/chart.js';
import * as coreData    from '../src/core/data.js';
import * as coreHealth  from '../src/core/health.js';
import { evaluate, getChartApi } from '../src/connection.js';

const TELEGRAM_TOKEN   = env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;

const CV = { MNQ: 2, MES: 5, MGC: 10, SIL: 10 };

const TV_SYMBOL = {
  MNQ: 'CME_MINI:MNQ1!',
  MES: 'CME_MINI:MES1!',
  MGC: 'COMEX_MINI:MGC1!',
  SIL: 'COMEX_MINI:SIL1!',
};
const YAHOO = { MNQ: 'MNQ=F', MES: 'MES=F', MGC: 'MGC=F', SIL: 'SIL=F' };

const MIN_SWEEP_PCT = 0.0015;
const MIN_RR        = 2.0;

// ─── Persistence ──────────────────────────────────────────────────────────────

const CACHE_PATH       = join(__dirname, 'signal-cache.json');
const FRACTAL_PATH     = join(__dirname, 'fractal-cache.json');
const OPEN_TRADES_PATH = join(__dirname, 'open-trades.json');

let signalCache = {};
try { signalCache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch {}

let FRACTAL = {};
try { FRACTAL = JSON.parse(readFileSync(FRACTAL_PATH, 'utf8')); } catch {}

const FIB_KEYS = ['-4.5', '-4', '-2.5', '-2', '-1', '0', '1'];

function etDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function isDupe(key) { return !!signalCache[`${key}_${etDay()}`]; }
function markSent(key) {
  const dayKey = `${key}_${etDay()}`;
  signalCache[dayKey] = Date.now();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const k of Object.keys(signalCache)) {
    if (signalCache[k] < cutoff) delete signalCache[k];
  }
  try { writeFileSync(CACHE_PATH, JSON.stringify(signalCache, null, 2)); } catch {}
}

// ─── Open-trades persistence ──────────────────────────────────────────────────

function loadOpenTrades() {
  try { return JSON.parse(readFileSync(OPEN_TRADES_PATH, 'utf8')); }
  catch { return { trades: [] }; }
}

function saveOpenTrade({ key, ticker, setup }) {
  const db = loadOpenTrades();
  const { type, direction, level, entryLow, entryHigh, stop, t1, t1Name, t2, t2Name } = setup;
  const entry = (entryLow + entryHigh) / 2;
  const id    = `${key}_${etDay().replace(/-/g, '')}`;
  if (db.trades.some(t => t.id === id)) return;
  db.trades.push({
    id, key, ticker, type, direction, level,
    entry: +entry.toFixed(4), stop: +stop.toFixed(4),
    t1: t1 != null ? +t1.toFixed(4) : null, t1Name: t1Name ?? null,
    t2: t2 != null ? +t2.toFixed(4) : null, t2Name: t2Name ?? null,
    signaledAt: new Date().toISOString(),
    status: 'open',
    updatedAt: new Date().toISOString(),
  });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.trades = db.trades.filter(t => new Date(t.signaledAt).getTime() > cutoff);
  try { writeFileSync(OPEN_TRADES_PATH, JSON.stringify(db, null, 2)); } catch {}
}

async function fetchLivePrice(yahooSym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1m&range=1d`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
}

// ─── Open trade monitoring ────────────────────────────────────────────────────

async function checkOpenTrades() {
  const db     = loadOpenTrades();
  const active = db.trades.filter(t => t.status === 'open' || t.status === 't1_hit');
  if (!active.length) return;

  let changed = false;
  const now   = new Date().toISOString();

  for (const trade of active) {
    const yahooSym = YAHOO[trade.ticker];
    if (!yahooSym) continue;
    const price = await fetchLivePrice(yahooSym).catch(() => null);
    if (price == null) continue;

    const { direction, entry, stop, t1, t1Name, t2, t2Name, ticker, type } = trade;
    const isLong  = direction === 'LONG';
    const riskPts = isLong ? entry - stop : stop - entry;
    const currR   = riskPts > 0 ? ((isLong ? price - entry : entry - price) / riskPts).toFixed(1) : '?';

    const stopHit = isLong ? price <= stop : price >= stop;
    const t1Hit   = t1 != null && (isLong ? price >= t1 : price <= t1);
    const t2Hit   = t2 != null && (isLong ? price >= t2 : price <= t2);

    if (trade.status === 'open') {
      if (t2Hit) {
        trade.status = 'complete'; trade.updatedAt = now; changed = true;
        const pts = Math.abs(t2 - entry);
        await telegram(`✅ *T2 HIT — ${ticker} ${type} ${direction}*\nEntry: ${f(entry)} → T2: ${f(t2)} (${t2Name ?? 'T2'})\n+$${Math.round(pts * CV[ticker])}/ct | Trade complete.\n_${etNow()} ET_`);
      } else if (t1Hit) {
        if (t2 != null) {
          trade.status = 't1_hit'; trade.updatedAt = now; changed = true;
          const pts = Math.abs(t1 - entry);
          await telegram(`🎯 *T1 HIT — ${ticker} ${type} ${direction}*\nEntry: ${f(entry)} → T1: ${f(t1)} (${t1Name ?? 'T1'})\n+$${Math.round(pts * CV[ticker])}/ct | Runner active → T2: ${f(t2)} (${t2Name ?? 'T2'}).\n_${etNow()} ET_`);
        } else {
          trade.status = 'complete'; trade.updatedAt = now; changed = true;
          const pts = Math.abs(t1 - entry);
          await telegram(`✅ *T1 HIT — ${ticker} ${type} ${direction}*\nEntry: ${f(entry)} → T1: ${f(t1)} (${t1Name ?? 'T1'})\n+$${Math.round(pts * CV[ticker])}/ct | Trade complete.\n_${etNow()} ET_`);
        }
      } else if (stopHit) {
        trade.status = 'stopped'; trade.updatedAt = now; changed = true;
        await telegram(`❌ *STOP HIT — ${ticker} ${type} ${direction}*\nEntry: ${f(entry)} → Stop: ${f(stop)}\n-1R | Invalidated.\n_${etNow()} ET_`);
      }
    } else if (trade.status === 't1_hit') {
      if (t2Hit) {
        trade.status = 'complete'; trade.updatedAt = now; changed = true;
        const pts = Math.abs(t2 - entry);
        await telegram(`✅ *T2 HIT — ${ticker} ${type} ${direction}*\nT1 → T2: ${f(t2)} (${t2Name ?? 'T2'})\n+$${Math.round(pts * CV[ticker])}/ct | Full trade complete.\n_${etNow()} ET_`);
      } else if (stopHit) {
        trade.status = 'stopped_after_t1'; trade.updatedAt = now; changed = true;
        await telegram(`⚠️ *RUNNER STOPPED — ${ticker} ${type} ${direction}*\nT1 was hit. Runner stopped at ${f(price)} | ${currR}R\n_${etNow()} ET_`);
      }
    }
  }

  if (changed) {
    try { writeFileSync(OPEN_TRADES_PATH, JSON.stringify(db, null, 2)); } catch {}
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function telegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { console.log('[NO CHANNEL]\n' + text); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
    });
  } catch (e) { console.error('telegram error:', e.message); }
}

// ─── TV data fetch ─────────────────────────────────────────────────────────────

function parseStoicLevels(labelsResult) {
  const labels = labelsResult?.studies?.[0]?.labels ?? [];
  const out = {};
  for (const l of labels) {
    const t = l.text.trim();
    if (t === 'PDH') out.PDH = l.price;
    else if (t === 'PDL') out.PDL = l.price;
    else if (t === 'PDC') out.PDC = l.price;
    else if (t === 'PWH') out.PWH = l.price;
    else if (t === 'PWL') out.PWL = l.price;
    else if (t.startsWith('HCOM')) out.HCOM = l.price;
    else if (t.startsWith('LCOM')) out.LCOM = l.price;
  }
  return out;
}

function parseFractalTable(tablesResult) {
  const rows = tablesResult?.studies?.[0]?.tables?.[0]?.rows ?? [];
  let bias = 'Neutral', model = null, smt = [];
  for (const row of rows) {
    const biasM = row.match(/Bias:\s*(\w+)/);
    if (biasM) bias = biasM[1];
    const modelM = row.match(/([\w\d]+-[\w\d]+ Model)/);
    if (modelM) model = modelM[1];
    const smtM = row.match(/SMT(?:\(Auto\))?:\s*(.+)/);
    if (smtM) smt = smtM[1].split(',').map(s => s.trim()).filter(Boolean);
  }
  return { bias, model, smt };
}

function parseFractalLabels(labelsResult) {
  const labels = labelsResult?.studies?.[0]?.labels ?? [];
  const sets = [];
  let cur = {};
  for (const l of labels) {
    const t = l.text.trim();
    if (FIB_KEYS.includes(t)) {
      cur[t] = l.price;
    } else if (t === 'C2' || t === 'C4' || t === 'XC2') {
      cur[t.toLowerCase()] = l.price;
      if (cur['-1'] != null && cur['0'] != null) {
        cur.direction = cur['-1'] > cur['0'] ? 'bullish' : 'bearish';
        sets.push({ ...cur });
      }
      cur = {};
    }
  }
  if (cur['-1'] != null && cur['0'] != null) {
    cur.direction = cur['-1'] > cur['0'] ? 'bullish' : 'bearish';
    sets.push({ ...cur });
  }
  return sets.slice(-2);
}

async function fetchAllTVData() {
  try { await coreHealth.healthCheck(); } catch { return null; }

  const tvData = {};
  for (const ticker of Object.keys(TV_SYMBOL)) {
    try {
      await coreChart.setSymbol({ symbol: TV_SYMBOL[ticker] });
      await new Promise(r => setTimeout(r, 1500));

      const [stoicRaw, fractalLabRaw, fractalTabRaw, fractalBoxRaw] = await Promise.all([
        coreData.getPineLabels({ study_filter: 'Stoic Edge', max_labels: 20 }),
        coreData.getPineLabels({ study_filter: 'Fractal Model', max_labels: 40 }),
        coreData.getPineTables({ study_filter: 'Fractal Model' }),
        coreData.getPineBoxes({ study_filter: 'Fractal Model' }),
      ]);

      const { bias, model, smt } = parseFractalTable(fractalTabRaw);
      const activeFibSets  = parseFractalLabels(fractalLabRaw);
      const imbalanceZones = fractalBoxRaw?.studies?.[0]?.zones ?? [];

      tvData[ticker] = {
        levels:  parseStoicLevels(stoicRaw),
        fractal: { bias, model, smt, activeFibSets, imbalanceZones },
      };
      FRACTAL[ticker] = tvData[ticker].fractal;
    } catch (err) {
      console.error(`[${ticker}] TV read error: ${err.message}`);
      tvData[ticker] = null;
    }
  }

  FRACTAL.updated = new Date().toISOString();
  try { writeFileSync(FRACTAL_PATH, JSON.stringify(FRACTAL, null, 2)); } catch {}
  return tvData;
}

// ─── Yahoo Finance ─────────────────────────────────────────────────────────────

async function fetchBars(symbol, interval = '5m', range = '5d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  const r    = json?.chart?.result?.[0];
  if (!r) return [];
  const ts = r.timestamp, q = r.indicators.quote[0];
  return ts.reduce((acc, t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null && isFinite(v)))
      acc.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
    return acc;
  }, []);
}

async function fetchYahooPD(symbol) {
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10d`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  const r    = json?.chart?.result?.[0];
  if (!r) return null;
  const ts = r.timestamp, q = r.indicators.quote[0];
  const bars = ts.reduce((acc, t, i) => {
    if ([q.high[i], q.low[i], q.close[i]].every(v => v != null && isFinite(v)))
      acc.push({ time: t, high: q.high[i], low: q.low[i], close: q.close[i] });
    return acc;
  }, []);
  if (bars.length < 2) return null;
  const todayET  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const lastDate = new Date(bars.at(-1).time * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const prev     = lastDate === todayET ? bars.at(-2) : bars.at(-1);
  return { PDH: prev.high, PDL: prev.low, PDC: prev.close };
}

// Aggregate 1H bars into 4H bars
function buildFourHourBars(hourlyBars) {
  const out = [];
  for (let i = 0; i + 3 < hourlyBars.length; i += 4) {
    const slice = hourlyBars.slice(i, i + 4);
    out.push({
      time:  slice[0].time,
      open:  slice[0].open,
      high:  Math.max(...slice.map(b => b.high)),
      low:   Math.min(...slice.map(b => b.low)),
      close: slice[slice.length - 1].close,
    });
  }
  return out;
}

function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((s, v) => s + v, 0) / n;
}

// ─── Macro bias (Daily SMA 20/200) ────────────────────────────────────────────

function dailyMacroBias(dailyBars) {
  if (!dailyBars || dailyBars.length < 20) return 'NO DATA';
  const closes = dailyBars.map(b => b.close);
  const price  = closes.at(-1);
  const s20    = sma(closes, 20);
  const s200   = sma(closes, 200);
  if (!s20) return 'NO DATA';
  if (s200 && Math.abs(s20 - s200) / s200 < 0.001) return 'AT THE CROSS';
  if (!s200) return price > s20 ? 'BULLISH' : 'BEARISH';
  const bull = s20 > s200;
  if (bull  && price > s20) return 'BULLISH';
  if (!bull && price < s20) return 'BEARISH';
  if (bull  && price < s20) return 'PULLBACK';
  return 'BOUNCE';
}

// ─── Move Origin detection ────────────────────────────────────────────────────

// Returns { dir, high, low, price, idx } for the most recent move origin on the
// given bar series, or null. Move origin = the last opposing swing immediately
// before the most recent break of structure.
function findMoveOrigin(bars) {
  if (!bars || bars.length < 20) return null;
  const n = bars.length;

  // 3-bar swing points
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < n - 2; i++) {
    if (bars[i].high > bars[i-1].high && bars[i].high > bars[i-2].high &&
        bars[i].high > bars[i+1].high && bars[i].high > bars[i+2].high)
      swingHighs.push({ idx: i, price: bars[i].high });
    if (bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low &&
        bars[i].low < bars[i+1].low && bars[i].low < bars[i+2].low)
      swingLows.push({ idx: i, price: bars[i].low });
  }

  // Most recent BOS: close that breaks a prior swing
  let bosDir = null, bosIdx = -1;
  outer:
  for (let i = n - 1; i >= 10; i--) {
    for (const sh of [...swingHighs].reverse()) {
      if (sh.idx >= i) continue;
      if (bars[i].close > sh.price * 1.001) { bosDir = 'BULL'; bosIdx = i; break outer; }
    }
    for (const sl of [...swingLows].reverse()) {
      if (sl.idx >= i) continue;
      if (bars[i].close < sl.price * 0.999) { bosDir = 'BEAR'; bosIdx = i; break outer; }
    }
  }
  if (!bosDir) return null;

  if (bosDir === 'BULL') {
    const pre = swingLows.filter(sl => sl.idx < bosIdx);
    if (!pre.length) return null;
    const o = pre.at(-1);
    return { dir: 'BULL', high: bars[o.idx].high, low: bars[o.idx].low, price: o.price, idx: o.idx };
  } else {
    const pre = swingHighs.filter(sh => sh.idx < bosIdx);
    if (!pre.length) return null;
    const o = pre.at(-1);
    return { dir: 'BEAR', high: bars[o.idx].high, low: bars[o.idx].low, price: o.price, idx: o.idx };
  }
}

// ─── IFVG detection ───────────────────────────────────────────────────────────

// Bearish FVG (bar[i-1].low > bar[i+1].high) violated by a close above its bottom
// → inverted, now support for LONG. Opposite for SHORT.
function detectIFVG(bars, direction) {
  if (!bars || bars.length < 5) return null;
  for (let i = 1; i < bars.length - 3; i++) {
    if (direction === 'LONG') {
      const gapTop = bars[i-1].low, gapBot = bars[i+1].high;
      if (gapTop <= gapBot) continue;
      for (let j = i + 2; j < bars.length; j++) {
        if (bars[j].close > gapBot) return { high: gapTop, low: gapBot };
      }
    } else {
      const gapBot = bars[i-1].high, gapTop = bars[i+1].low;
      if (gapBot >= gapTop) continue;
      for (let j = i + 2; j < bars.length; j++) {
        if (bars[j].close < gapTop) return { high: gapTop, low: gapBot };
      }
    }
  }
  return null;
}

// ─── CISD confirmation ────────────────────────────────────────────────────────

function hasCISDConfirm(bars, direction) {
  if (!bars || bars.length < 8) return false;
  const b = bars.slice(-15);
  const m = b.length;
  for (let i = 2; i < m - 2; i++) {
    if (direction === 'LONG') {
      if (b[i].low < b[i-1].low && b[i].low < b[i+1].low) {
        const seriesHigh = Math.max(b[Math.max(0, i-3)].high, b[i-2].high, b[i-1].high);
        for (let k = i + 1; k < m; k++) {
          if (b[k].close > seriesHigh && k >= m - 8) return true;
        }
      }
    } else {
      if (b[i].high > b[i-1].high && b[i].high > b[i+1].high) {
        const seriesLow = Math.min(b[Math.max(0, i-3)].low, b[i-2].low, b[i-1].low);
        for (let k = i + 1; k < m; k++) {
          if (b[k].close < seriesLow && k >= m - 8) return true;
        }
      }
    }
  }
  return false;
}

// ─── SBS detection ────────────────────────────────────────────────────────────

function detectSBS(bars5m, mo1h, mo4h, moDaily, macroDir, sma20_5m, sma200_5m) {
  if (!bars5m || bars5m.length < 30) return null;
  const b = bars5m.slice(-62, -1); // ~5h of completed 5M bars
  const m = b.length;

  for (const dir of ['LONG', 'SHORT']) {
    const isLong = dir === 'LONG';
    if (isLong  && macroDir === 'BEARISH') continue;
    if (!isLong && macroDir === 'BULLISH') continue;

    // ── Move 1: first BOS in left 45% of bars ───────────────────────────────
    let m1Level = null, m1Idx = -1;
    const halfway = Math.floor(m * 0.45);
    for (let i = 3; i < halfway; i++) {
      const priorHigh = Math.max(...b.slice(Math.max(0, i-5), i).map(x => x.high));
      const priorLow  = Math.min(...b.slice(Math.max(0, i-5), i).map(x => x.low));
      if (isLong  && b[i].close > priorHigh * 1.001) { m1Level = priorHigh; m1Idx = i; break; }
      if (!isLong && b[i].close < priorLow  * 0.999) { m1Level = priorLow;  m1Idx = i; break; }
    }
    if (m1Idx < 0) continue;

    // ── Move 2: deepest pullback after Move 1, before new high ──────────────
    let m2Extreme = null, m2Idx = -1;
    for (let i = m1Idx + 1; i < m - 15; i++) {
      const v = isLong ? b[i].low : b[i].high;
      if (m2Extreme == null || (isLong ? v < m2Extreme : v > m2Extreme)) {
        m2Extreme = v; m2Idx = i;
      }
      const mv3Check = isLong ? b[i].close > m1Level * 1.001 : b[i].close < m1Level * 0.999;
      if (mv3Check) break;
    }
    if (m2Idx < 0 || m2Extreme == null) continue;

    // ── Move 3: new extreme beyond Move 1 ───────────────────────────────────
    let m3Extreme = isLong ? -Infinity : Infinity, m3Idx = -1;
    for (let i = m2Idx + 1; i < m - 10; i++) {
      const v = isLong ? b[i].high : b[i].low;
      if (isLong ? v > m1Level * 1.001 : v < m1Level * 0.999) {
        if (isLong ? v > m3Extreme : v < m3Extreme) { m3Extreme = v; m3Idx = i; }
      }
      if (m3Idx > 0) {
        const m4Start = isLong ? b[i].close < m2Extreme * 1.001 : b[i].close > m2Extreme * 0.999;
        if (m4Start) break;
      }
    }
    if (m3Idx < 0) continue;

    // ── Move 4: must sweep below Move 2 liquidity ────────────────────────────
    let m4Extreme = null, m4Idx = -1;
    for (let i = m3Idx + 1; i < m - 3; i++) {
      const v = isLong ? b[i].low : b[i].high;
      const swept = isLong ? v < m2Extreme * 0.9995 : v > m2Extreme * 1.0005;
      if (swept && (m4Extreme == null || (isLong ? v < m4Extreme : v > m4Extreme))) {
        m4Extreme = v; m4Idx = i;
      }
    }
    if (m4Idx < 0 || m4Extreme == null) continue;

    // ── Model 1 vs 2: did Move 4 reach any move origin? ─────────────────────
    let model = 1;
    const htfAligned = [];
    const mo5m = findMoveOrigin(b.slice(0, m1Idx + 1));
    const moChecks = [
      { mo: mo5m,    label: '5M MO' },
      { mo: mo1h,    label: '1H MO' },
      { mo: mo4h,    label: '4H MO' },
      { mo: moDaily, label: 'Daily MO' },
    ];
    for (const { mo, label } of moChecks) {
      if (!mo) continue;
      const hit = isLong
        ? m4Extreme <= mo.high * 1.003
        : m4Extreme >= mo.low  * 0.997;
      if (hit) { model = 2; htfAligned.push(label); }
    }

    // ── Move 5: initial expansion leg after Move 4 ───────────────────────────
    const postM4 = b.slice(m4Idx + 1);
    if (postM4.length < 3) continue;

    let m5Peak = null, m5PeakIdx = -1;
    for (let i = 0; i < postM4.length; i++) {
      const v = isLong ? postM4[i].high : postM4[i].low;
      if (isLong ? v > m4Extreme : v < m4Extreme) {
        if (m5Peak == null || (isLong ? v > m5Peak : v < m5Peak)) { m5Peak = v; m5PeakIdx = i; }
      }
    }
    if (m5Peak == null) continue;

    const m5Range = Math.abs(m5Peak - m4Extreme);
    if (m5Range < Math.abs(m4Extreme) * 0.002) continue;

    // Entry zone: 50–61.8% retracement of Move 5 leg
    const entry50  = isLong ? m5Peak - m5Range * 0.500 : m5Peak + m5Range * 0.500;
    const entry618 = isLong ? m5Peak - m5Range * 0.618 : m5Peak + m5Range * 0.618;

    const last = b[m - 1];
    const inZone = isLong
      ? last.low <= entry50 * 1.001 && last.close >= entry618 * 0.999
      : last.high >= entry50 * 0.999 && last.close <= entry618 * 1.001;
    if (!inZone) continue;

    // Stop below Move 4 sweep (structural)
    const stop = isLong ? m4Extreme * 0.9992 : m4Extreme * 1.0008;
    const risk  = Math.abs(entry50 - stop);
    if (risk === 0) continue;

    // T1: just inside Move 3 high (natural SBS target)
    const t1 = isLong ? m3Extreme * 0.9995 : m3Extreme * 1.0005;
    if (Math.abs(t1 - entry50) / risk < MIN_RR) continue;

    // T2 for Model 2: next HTF expansion target
    let t2 = null, t2Name = null;
    if (model === 2) {
      const htfMo = mo4h ?? mo1h ?? moDaily;
      if (htfMo) {
        const potential = isLong ? htfMo.low : htfMo.high;
        if (isLong ? potential > t1 : potential < t1) { t2 = potential; t2Name = 'HTF expansion'; }
      }
      if (!t2) { t2 = isLong ? entry50 + risk * 4 : entry50 - risk * 4; t2Name = '4R'; }
    }

    // Confluence scoring
    const cisdConfirmed = hasCISDConfirm(b.slice(m4Idx), dir);
    const ifvgZone      = detectIFVG(b.slice(Math.max(0, m4Idx - 5)), dir);
    const smaBounce     = (() => {
      if (!sma20_5m && !sma200_5m) return false;
      const tol = 0.003;
      if (sma20_5m  && Math.abs(m4Extreme - sma20_5m)  / sma20_5m  <= tol) return true;
      if (sma200_5m && Math.abs(m4Extreme - sma200_5m) / sma200_5m <= tol) return true;
      return false;
    })();

    const confluenceScore = (cisdConfirmed ? 1 : 0) + (ifvgZone ? 1 : 0) + (smaBounce ? 1 : 0);
    const quality = confluenceScore >= 3 ? 'A+' : confluenceScore === 2 ? 'A' : 'B';

    // Model 1: minimum 2 confluences; Model 2 at MO: minimum 1
    if (model === 1 && confluenceScore < 2) continue;
    if (model === 2 && confluenceScore < 1) continue;

    return {
      type: 'SBS', direction: dir, model, quality,
      level: htfAligned.length ? htfAligned.join(' + ') : 'Move Origin',
      entryLow:  isLong ? entry618 : entry50,
      entryHigh: isLong ? entry50  : entry618,
      stop,
      t1: +t1.toFixed(4), t1Name: 'Move 3',
      t2: t2 != null ? +t2.toFixed(4) : null, t2Name,
      cisdConfirmed, ifvg: ifvgZone != null, smaBounce, confluenceScore,
      htfMoLabel: htfAligned.join(' + '),
      moObjects: { '5M MO': mo5m, '1H MO': mo1h, '4H MO': mo4h, 'Daily MO': moDaily },
      // Fib anchors for TV drawing: M4 extreme → M5 peak → entry
      fibA: m4Extreme, fibA_time: b[m4Idx].time,
      fibB: m5Peak,    fibB_time: b[m4Idx + 1 + m5PeakIdx]?.time ?? b[m4Idx].time,
    };
  }
  return null;
}

// ─── SFP / B&R / CISD-Fib ────────────────────────────────────────────────────

function detectSFP(bars, levels) {
  const out = [];
  const checkBars = bars.slice(-4, -1);
  for (const bar of checkBars) {
    for (const [name, price] of [['PDH', levels.PDH], ['PDL', levels.PDL], ['PDC', levels.PDC]]) {
      if (!price) continue;
      const minSweep = price * MIN_SWEEP_PCT;
      if (name !== 'PDL' && bar.high > price && bar.close < price && bar.high - price >= minSweep) {
        const depth = bar.high - price;
        const entryLow = price - depth * 0.65, entryHigh = price + depth * 0.15;
        const entry = (entryLow + entryHigh) / 2;
        const stop  = bar.high * 1.0008;
        const { t1, t1Name, t2, t2Name } = sfpTargets('SHORT', name, levels);
        const rrVal = t1 ? Math.abs(entry - t1) / Math.abs(entry - stop) : 0;
        if (rrVal >= MIN_RR)
          out.push({ type: 'SFP', direction: 'SHORT', level: name, levelPrice: price,
            entryLow, entryHigh, stop, t1, t1Name, t2, t2Name });
      }
      if (name !== 'PDH' && bar.low < price && bar.close > price && price - bar.low >= minSweep) {
        const depth = price - bar.low;
        const entryLow = price - depth * 0.15, entryHigh = price + depth * 0.65;
        const entry = (entryLow + entryHigh) / 2;
        const stop  = bar.low * 0.9992;
        const { t1, t1Name, t2, t2Name } = sfpTargets('LONG', name, levels);
        const rrVal = t1 ? Math.abs(entry - t1) / Math.abs(entry - stop) : 0;
        if (rrVal >= MIN_RR)
          out.push({ type: 'SFP', direction: 'LONG', level: name, levelPrice: price,
            entryLow, entryHigh, stop, t1, t1Name, t2, t2Name });
      }
    }
  }
  return out;
}

function sfpTargets(dir, level, { PDH, PDL, PDC }) {
  if (dir === 'SHORT') {
    if (level === 'PDH') return { t1: PDC, t1Name: 'PDC', t2: PDL, t2Name: 'PDL' };
    if (level === 'PDC') return { t1: PDL, t1Name: 'PDL', t2: null, t2Name: null };
    if (level === 'PDL') return { t1: PDC, t1Name: 'PDC', t2: null, t2Name: null };
  } else {
    if (level === 'PDL') return { t1: PDC, t1Name: 'PDC', t2: PDH, t2Name: 'PDH' };
    if (level === 'PDC') return { t1: PDH, t1Name: 'PDH', t2: null, t2Name: null };
    if (level === 'PDH') return { t1: PDC, t1Name: 'PDC', t2: null, t2Name: null };
  }
  return { t1: null, t1Name: null, t2: null, t2Name: null };
}

function detectBnR(bars, levels) {
  const out = [];
  if (bars.length < 7) return out;
  const recent = bars.slice(-7);
  const last = recent.at(-1);
  const prev = recent.slice(0, -1);

  if (levels.PDH) {
    const broke = prev.some(b => b.close > levels.PDH * 1.0025);
    if (broke && last.low <= levels.PDH * 1.001 && last.close > levels.PDH * 0.9995) {
      const entry = levels.PDH;
      const stop  = Math.min(...recent.slice(-2).map(b => b.low)) * 0.9992;
      const risk  = entry - stop;
      out.push({ type: 'B&R', direction: 'LONG', level: 'PDH', levelPrice: levels.PDH,
        entryLow: levels.PDH * 0.9996, entryHigh: levels.PDH * 1.001, stop,
        t1: entry + risk * 2.5, t1Name: '2.5R', t2: entry + risk * 4.0, t2Name: '4R' });
    }
  }
  if (levels.PDL) {
    const broke = prev.some(b => b.close < levels.PDL * 0.9975);
    if (broke && last.high >= levels.PDL * 0.999 && last.close < levels.PDL * 1.0005) {
      const entry = levels.PDL;
      const stop  = Math.max(...recent.slice(-2).map(b => b.high)) * 1.0008;
      const risk  = stop - entry;
      out.push({ type: 'B&R', direction: 'SHORT', level: 'PDL', levelPrice: levels.PDL,
        entryLow: levels.PDL * 0.9995, entryHigh: levels.PDL * 1.001, stop,
        t1: entry - risk * 2.5, t1Name: '2.5R', t2: entry - risk * 4.0, t2Name: '4R' });
    }
  }
  return out;
}

function detectCISDFib(bars) {
  if (!bars || bars.length < 20) return null;
  const b = bars.slice(-31, -1);
  const m = b.length;

  for (const dir of ['LONG', 'SHORT']) {
    const isLong = dir === 'LONG';

    let A = isLong ? Infinity : -Infinity, A_idx = -1;
    for (let i = 0; i < Math.floor(m * 0.6); i++) {
      const v = isLong ? b[i].low : b[i].high;
      if (isLong ? v < A : v > A) { A = v; A_idx = i; }
    }
    if (A_idx < 0 || A_idx > m - 8) continue;

    let B = isLong ? -Infinity : Infinity, B_idx = -1;
    for (let i = A_idx + 1; i < m - 5; i++) {
      const v = isLong ? b[i].high : b[i].low;
      if (isLong ? v <= A : v >= A) continue;
      const next1 = isLong ? b[i+1]?.high : b[i+1]?.low;
      const next2 = isLong ? b[i+2]?.high : b[i+2]?.low;
      if (next1 == null || next2 == null) continue;
      if (!(isLong ? next1 < v && next2 < v : next1 > v && next2 > v)) continue;
      let C_look = isLong ? Infinity : -Infinity;
      for (let j = i + 1; j < Math.min(i + 13, m); j++) {
        const cv = isLong ? b[j].low : b[j].high;
        if (isLong ? cv < C_look : cv > C_look) C_look = cv;
      }
      const pb = Math.abs(v - C_look) / Math.abs(v - A);
      if (pb < 0.2 || pb > 0.8) continue;
      B = v; B_idx = i; break;
    }
    if (B_idx < 0) continue;

    const wave1 = Math.abs(B - A);
    if (wave1 < A * 0.001) continue;

    let C = isLong ? Infinity : -Infinity, C_idx = -1;
    for (let i = B_idx + 1; i < Math.min(B_idx + 13, m - 2); i++) {
      const v = isLong ? b[i].low : b[i].high;
      if (isLong ? v < C : v > C) { C = v; C_idx = i; }
    }
    if (C_idx < 0) continue;
    if (Math.abs(B - C) / wave1 < 0.2 || Math.abs(B - C) / wave1 > 0.8) continue;

    const ext100 = isLong ? C + wave1 : C - wave1;
    let W2 = isLong ? -Infinity : Infinity, W2_idx = -1;
    for (let i = C_idx + 1; i < m; i++) {
      const v   = isLong ? b[i].high : b[i].low;
      const hit = isLong ? v >= ext100 * 0.998 : v <= ext100 * 1.002;
      if (hit && (isLong ? v > W2 : v < W2)) { W2 = v; W2_idx = i; }
    }
    if (W2_idx < 0) continue;

    const w2Range  = Math.abs(W2 - C);
    const entry50  = isLong ? W2 - w2Range * 0.500 : W2 + w2Range * 0.500;
    const entry618 = isLong ? W2 - w2Range * 0.618 : W2 + w2Range * 0.618;

    const last = b[m - 1];
    const inZone = isLong
      ? last.low <= entry50 * 1.001 && last.close >= entry618 * 0.999
      : last.high >= entry50 * 0.999 && last.close <= entry618 * 1.001;
    if (!inZone) continue;

    const stop = isLong ? C * 0.9992 : C * 1.0008;
    const risk  = Math.abs(entry50 - stop);
    if (risk === 0) continue;

    const t1 = isLong ? C + wave1 * 2.618 : C - wave1 * 2.618;
    const t2 = isLong ? C + wave1 * 4.236 : C - wave1 * 4.236;
    if (Math.abs(t1 - entry50) / risk < MIN_RR) continue;

    return {
      type: 'CISD-Fib', direction: dir, level: '100%',
      entryLow:  isLong ? entry618 : entry50,
      entryHigh: isLong ? entry50  : entry618,
      stop, t1, t1Name: '261.8%', t2, t2Name: '423.6%',
      fibA: A, fibA_time: b[A_idx].time,
      fibB: B, fibB_time: b[B_idx].time,
      fibC: C, fibC_time: b[C_idx].time,
    };
  }
  return null;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function f(n, dp = 1) {
  return n != null ? n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—';
}
function pnl(entry, target, dir, ticker) {
  if (target == null) return null;
  const pts = dir === 'SHORT' ? entry - target : target - entry;
  return pts > 0 ? Math.round(pts * CV[ticker]) : null;
}
function rrStr(entry, target, stop, dir) {
  if (target == null || stop == null) return null;
  const reward = dir === 'SHORT' ? entry - target : target - entry;
  const risk   = dir === 'SHORT' ? stop - entry  : entry - stop;
  return risk > 0 ? (reward / risk).toFixed(1) : null;
}
function etNow() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function buildStoicMsg(ticker, setup, macro) {
  const { type, direction, level, entryLow, entryHigh, stop, t1, t1Name, t2, t2Name } = setup;
  const entry = (entryLow + entryHigh) / 2;
  const arrow = direction === 'LONG' ? '↑' : '↓';
  const emoji = type === 'SFP' ? '📊' : '🔄';
  return [
    `${emoji} *STOICTA — ${ticker} ${type} at ${level}*`,
    `Direction: *${direction}* ${arrow}`,
    `Entry zone: ${f(entryLow)}–${f(entryHigh)}`,
    `Stop: ${f(stop)}`,
    t1 != null ? `T1: ${f(t1)} (${t1Name}) → ${pnl(entry, t1, direction, ticker) != null ? `+$${pnl(entry, t1, direction, ticker)}/contract` : '—'}` : null,
    t2 != null ? `T2: ${f(t2)} (${t2Name}) → ${pnl(entry, t2, direction, ticker) != null ? `+$${pnl(entry, t2, direction, ticker)}/contract` : '—'}` : null,
    `R:R T1: ${rrStr(entry, t1, stop, direction) ?? '—'}:1 | Macro: ${macro}`,
    `_${etNow()} ET_`,
  ].filter(Boolean).join('\n');
}

function buildCISDFibMsg(ticker, setup, macro) {
  const { direction, entryLow, entryHigh, stop, t1, t1Name, t2, t2Name } = setup;
  const entry = (entryLow + entryHigh) / 2;
  const arrow = direction === 'LONG' ? '↑' : '↓';
  return [
    `📐 *STOICTA — ${ticker} CISD-Fib Extension*`,
    `Direction: *${direction}* ${arrow}`,
    `100% extension hit — limit at 50% retracement`,
    `Entry zone: ${f(entryLow)}–${f(entryHigh)}`,
    `Stop: ${f(stop)}`,
    t1 != null ? `T1: ${f(t1)} (${t1Name}) → ${pnl(entry, t1, direction, ticker) != null ? `+$${pnl(entry, t1, direction, ticker)}/ct` : '—'}` : null,
    t2 != null ? `T2: ${f(t2)} (${t2Name}) → ${pnl(entry, t2, direction, ticker) != null ? `+$${pnl(entry, t2, direction, ticker)}/ct` : '—'}` : null,
    `R:R T1: ${rrStr(entry, t1, stop, direction) ?? '—'}:1 | Macro: ${macro}`,
    `_${etNow()} ET_`,
  ].filter(Boolean).join('\n');
}

function buildSBSMsg(ticker, setup, macro) {
  const { direction, model, quality, entryLow, entryHigh, stop, t1, t1Name, t2, t2Name,
          cisdConfirmed, ifvg, smaBounce, htfMoLabel } = setup;
  const entry = (entryLow + entryHigh) / 2;
  const arrow = direction === 'LONG' ? '↑' : '↓';
  const modelStr = model === 2 ? 'Model 2 — deep MO, HTF expansion' : 'Model 1 — range reversal';
  const confirm  = [
    cisdConfirmed && '✓ CISD',
    ifvg          && '✓ IFVG',
    smaBounce     && '✓ 5M SMA',
  ].filter(Boolean).join(' | ') || 'structure only';
  return [
    `🔁 *STOICTA — ${ticker} SBS ${quality} off Move Origin*`,
    `Direction: *${direction}* ${arrow} | ${modelStr}`,
    htfMoLabel ? `HTF confluence: ${htfMoLabel}` : null,
    `Confirmation: ${confirm}`,
    `Entry zone: ${f(entryLow)}–${f(entryHigh)}`,
    `Stop: ${f(stop)} (below Move 4 sweep)`,
    t1 != null ? `T1: ${f(t1)} (${t1Name}) → ${pnl(entry, t1, direction, ticker) != null ? `+$${pnl(entry, t1, direction, ticker)}/contract` : '—'}` : null,
    t2 != null ? `T2: ${f(t2)} (${t2Name}) → ${pnl(entry, t2, direction, ticker) != null ? `+$${pnl(entry, t2, direction, ticker)}/contract` : '—'}` : null,
    `R:R T1: ${rrStr(entry, t1, stop, direction) ?? '—'}:1 | Macro: ${macro}`,
    model === 2 ? `⚠️ Watch for double ${direction === 'LONG' ? 'bottom' : 'top'} before full entry` : null,
    `_${etNow()} ET_`,
  ].filter(Boolean).join('\n');
}

// ─── Chart drawing ────────────────────────────────────────────────────────────

async function drawSignal(ticker, setup, macro, tvConnected) {
  if (!tvConnected) return;
  try {
    await coreChart.setSymbol({ symbol: TV_SYMBOL[ticker] });
    await new Promise(r => setTimeout(r, 1000));

    const { type, direction, entryLow, entryHigh, stop, t1 } = setup;
    const entry   = (entryLow + entryHigh) / 2;
    const now     = Math.floor(Date.now() / 1000);
    const apiPath = await getChartApi();

    const posShape    = direction === 'LONG' ? 'long_position' : 'short_position';
    const targetPrice = t1 ?? (direction === 'LONG' ? entry * 1.02 : entry * 0.98);
    await evaluate(`${apiPath}.createMultipointShape(${JSON.stringify([
      { time: now, price: entry },
      { time: now + 14400, price: targetPrice },
    ])}, ${JSON.stringify({ shape: posShape, overrides: { stopLevel: stop } })})`);

    // CISD-Fib: A→B→C trend-based fib extension
    if (type === 'CISD-Fib' && setup.fibA != null && setup.fibC != null) {
      await evaluate(`${apiPath}.createMultipointShape(${JSON.stringify([
        { time: setup.fibA_time, price: setup.fibA },
        { time: setup.fibB_time, price: setup.fibB },
        { time: setup.fibC_time, price: setup.fibC },
      ])}, ${JSON.stringify({ shape: 'fib_trend_ext', overrides: {} })})`);
    }

    // SBS: M4 extreme → M5 peak → entry (3-point trend-based fib)
    if (type === 'SBS' && setup.fibA != null && setup.fibB != null) {
      await evaluate(`${apiPath}.createMultipointShape(${JSON.stringify([
        { time: setup.fibA_time, price: setup.fibA },
        { time: setup.fibB_time, price: setup.fibB },
        { time: now,             price: entry },
      ])}, ${JSON.stringify({ shape: 'fib_trend_ext', overrides: {} })})`);
    }

    // SBS: draw horizontal lines at each detected move origin
    if (type === 'SBS' && setup.moObjects) {
      const color = direction === 'LONG' ? '#26a69a' : '#ef5350';
      for (const [label, mo] of Object.entries(setup.moObjects)) {
        if (!mo) continue;
        await evaluate(`${apiPath}.createMultipointShape(${JSON.stringify([
          { time: now, price: mo.price },
        ])}, ${JSON.stringify({ shape: 'horizontal_line', overrides: { linecolor: color, linewidth: 1, linestyle: 1, text: label } })})`);
      }
    }
  } catch (err) {
    console.error(`[${ticker}] draw error: ${err.message}`);
  }
}

// ─── Per-ticker scan ──────────────────────────────────────────────────────────

async function scan(ticker, tvData) {
  const sym = YAHOO[ticker];

  const [bars5m, bars1h, barsDaily, yahooPD] = await Promise.all([
    fetchBars(sym, '5m', '30d'),
    fetchBars(sym, '60m', '60d'),
    fetchBars(sym, '1d', '2y'),
    fetchYahooPD(sym),
  ]);

  if (bars5m.length < 10) return [];

  const bars4h = buildFourHourBars(bars1h);
  const macro  = dailyMacroBias(barsDaily);

  const mo1h    = findMoveOrigin(bars1h.slice(-120));
  const mo4h    = findMoveOrigin(bars4h.slice(-60));
  const moDaily = findMoveOrigin(barsDaily.slice(-60));

  const closes5m = bars5m.map(b => b.close);
  const sma20_5m  = sma(closes5m, 20);
  const sma200_5m = sma(closes5m, 200);

  const tvLevels = tvData?.[ticker]?.levels ?? {};
  const levels = {
    PDH: tvLevels.PDH ?? yahooPD?.PDH,
    PDL: tvLevels.PDL ?? yahooPD?.PDL,
    PDC: tvLevels.PDC ?? yahooPD?.PDC,
    PWH: tvLevels.PWH, PWL: tvLevels.PWL,
    HCOM: tvLevels.HCOM, LCOM: tvLevels.LCOM,
  };
  if (!levels.PDH && !levels.PDL) return [];

  const out = [];
  const bullishMacro = ['BULLISH', 'BOUNCE', 'AT THE CROSS'];
  const bearishMacro = ['BEARISH', 'PULLBACK', 'AT THE CROSS'];

  // SFP
  for (const setup of detectSFP(bars5m, levels)) {
    if (setup.direction === 'SHORT' && macro === 'BULLISH') continue;
    if (setup.direction === 'LONG'  && macro === 'BEARISH') continue;
    const key = `${ticker}_SFP_${setup.level}_${setup.direction}`;
    if (!isDupe(key)) out.push({ key, msg: buildStoicMsg(ticker, setup, macro), ticker, setup, macro });
  }

  // B&R
  for (const setup of detectBnR(bars5m, levels)) {
    if (setup.direction === 'SHORT' && !bearishMacro.includes(macro)) continue;
    if (setup.direction === 'LONG'  && !bullishMacro.includes(macro)) continue;
    const key = `${ticker}_BnR_${setup.level}_${setup.direction}`;
    if (!isDupe(key)) out.push({ key, msg: buildStoicMsg(ticker, setup, macro), ticker, setup, macro });
  }

  // CISD-Fib
  const cisdFib = detectCISDFib(bars5m);
  if (cisdFib &&
      !(cisdFib.direction === 'SHORT' && macro === 'BULLISH') &&
      !(cisdFib.direction === 'LONG'  && macro === 'BEARISH')) {
    const key = `${ticker}_CISDFib_${cisdFib.direction}`;
    if (!isDupe(key)) out.push({ key, msg: buildCISDFibMsg(ticker, cisdFib, macro), ticker, setup: cisdFib, macro });
  }

  // SBS
  const sbs = detectSBS(bars5m, mo1h, mo4h, moDaily, macro, sma20_5m, sma200_5m);
  if (sbs) {
    const key = `${ticker}_SBS_${sbs.direction}_M${sbs.model}`;
    if (!isDupe(key)) out.push({ key, msg: buildSBSMsg(ticker, sbs, macro), ticker, setup: sbs, macro });
  }

  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const ts = new Date().toISOString();

  await checkOpenTrades();

  const tvData = await fetchAllTVData();
  if (!tvData) {
    console.log(`[${ts}] TV offline — levels from Yahoo fallback`);
    await telegram('⚠️ *Signals:* TV offline — STOICTA levels from Yahoo.');
  }

  const results = await Promise.allSettled(Object.keys(YAHOO).map(t => scan(t, tvData)));
  const signals = results.flatMap((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[${Object.keys(YAHOO)[i]}] scan error: ${r.reason?.message}`);
      return [];
    }
    return r.value;
  });

  if (!signals.length) { console.log(`[${ts}] no signals`); return; }

  for (const { key, msg, ticker, setup, macro } of signals) {
    console.log(`[SIGNAL] ${key}`);
    await telegram(msg);
    markSent(key);
    saveOpenTrade({ key, ticker, setup });
    await drawSignal(ticker, setup, macro, !!tvData);
  }
})();
