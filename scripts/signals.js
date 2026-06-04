#!/usr/bin/env node
// scripts/signals.js — cron every 5 min, market hours
// Detects SFP + B&R (STOICTA) and CISD (TTRADES) setups, sends Telegram signals.
// TV live: cycles all 4 tickers, reads fresh Fractal bias + Stoic levels each scan.
// Fallback: uses fractal-cache.json + Yahoo PD levels if TV is down.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const env       = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

// TV core — imported dynamically after health check succeeds
import * as coreChart   from '../src/core/chart.js';
import * as coreData    from '../src/core/data.js';
import * as coreHealth  from '../src/core/health.js';
import * as coreDrawing from '../src/core/drawing.js';

const TELEGRAM_TOKEN   = env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;

const CV = { MNQ: 2, MES: 5, MGC: 10, SIL: 10 };  // $ per point per contract

const TV_SYMBOL = {
  MNQ: 'CME_MINI:MNQ1!',
  MES: 'CME_MINI:MES1!',
  MGC: 'COMEX_MINI:MGC1!',
  SIL: 'COMEX_MINI:SIL1!',
};
const YAHOO = { MNQ: 'MNQ=F', MES: 'MES=F', MGC: 'MGC=F', SIL: 'SIL=F' };

const MIN_SWEEP_PCT = 0.0015;  // 0.15% min wick for valid SFP (matches backtest filter)

// ─── Persistence ──────────────────────────────────────────────────────────────

const CACHE_PATH       = join(__dirname, 'signal-cache.json');
const FRACTAL_PATH     = join(__dirname, 'fractal-cache.json');
const OPEN_TRADES_PATH = join(__dirname, 'open-trades.json');

let signalCache = {};
try { signalCache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch {}

let FRACTAL = {};
try { FRACTAL = JSON.parse(readFileSync(FRACTAL_PATH, 'utf8')); } catch {}

const FIB_KEYS = ['-4.5', '-4', '-2.5', '-2', '-1', '0', '1'];
const MIN_RR   = 2.0;  // minimum R:R at T1 — strategy rule: never below 2:1

// Day-based dedup: one signal per level/direction per ET calendar day
function etDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function isDupe(key) {
  return !!signalCache[`${key}_${etDay()}`];
}
function markSent(key) {
  const dayKey = `${key}_${etDay()}`;
  signalCache[dayKey] = Date.now();
  // Prune entries older than 7 days
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
  // Prune entries older than 7 days
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

    const stopHit = isLong ? price <= stop  : price >= stop;
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
        await telegram(`⚠️ *RUNNER STOPPED — ${ticker} ${type} ${direction}*\nT1 was hit. Runner stopped at ${f(price)} | ${currR}R\nConsider: move stop to BE after T1.\n_${etNow()} ET_`);
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
  // Active set (no closing marker yet)
  if (cur['-1'] != null && cur['0'] != null) {
    cur.direction = cur['-1'] > cur['0'] ? 'bullish' : 'bearish';
    sets.push({ ...cur });
  }

  return sets.slice(-2);
}

async function fetchAllTVData() {
  // Returns { MNQ: { levels, fractal }, MES: ..., MGC: ..., SIL: ... }
  // or null if TV is unreachable.
  try {
    await coreHealth.healthCheck();
  } catch {
    return null; // TV down — caller will use cache
  }

  const tvData = {};

  for (const ticker of Object.keys(TV_SYMBOL)) {
    try {
      await coreChart.setSymbol({ symbol: TV_SYMBOL[ticker] });
      await new Promise(r => setTimeout(r, 1500)); // let Pine indicators settle

      const [stoicRaw, fractalLabRaw, fractalTabRaw, fractalBoxRaw] = await Promise.all([
        coreData.getPineLabels({ study_filter: 'Stoic Edge', max_labels: 20 }),
        coreData.getPineLabels({ study_filter: 'Fractal Model', max_labels: 40 }),
        coreData.getPineTables({ study_filter: 'Fractal Model' }),
        coreData.getPineBoxes({ study_filter: 'Fractal Model' }),
      ]);

      const { bias, model, smt } = parseFractalTable(fractalTabRaw);
      const activeFibSets = parseFractalLabels(fractalLabRaw);
      const imbalanceZones = fractalBoxRaw?.studies?.[0]?.zones ?? [];

      tvData[ticker] = {
        levels: parseStoicLevels(stoicRaw),
        fractal: { bias, model, smt, activeFibSets, imbalanceZones },
      };

      // Keep fractal-cache.json fresh
      FRACTAL[ticker] = tvData[ticker].fractal;
    } catch (err) {
      console.error(`[${ticker}] TV read error: ${err.message}`);
      tvData[ticker] = null; // will fall back to cache for this ticker
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
      acc.push({ t, h: q.high[i], l: q.low[i], c: q.close[i] });
    return acc;
  }, []);
  if (bars.length < 2) return null;
  const todayET  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const lastDate = new Date(bars.at(-1).t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const prev     = lastDate === todayET ? bars.at(-2) : bars.at(-1);
  return { PDH: prev.h, PDL: prev.l, PDC: prev.c };
}

function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((s, v) => s + v, 0) / n;
}

function macroBias(price, s20, s200) {
  if (!s20 || !s200) return 'NO DATA';
  if (Math.abs(s20 - s200) / s200 < 0.001) return 'AT THE CROSS';
  const bull = s20 > s200;
  if (bull  && price > s20) return 'BULLISH';
  if (!bull && price < s20) return 'BEARISH';
  if (bull  && price < s20) return 'PULLBACK';
  return 'BOUNCE';
}

// ─── Setup detection ──────────────────────────────────────────────────────────

function detectSFP(bars, levels) {
  const out = [];
  const checkBars = bars.slice(-4, -1);
  for (const bar of checkBars) {
    for (const [name, price] of [['PDH', levels.PDH], ['PDL', levels.PDL], ['PDC', levels.PDC]]) {
      if (!price) continue;
      const minSweep = price * MIN_SWEEP_PCT;

      // Natural direction only: SHORT at PDH or PDC (not PDL — would need PDC below PDL for valid target)
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

      // Natural direction only: LONG at PDL or PDC (not PDH — would need PDC above PDH for valid target)
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
    const broke = prev.some(b => b.close > levels.PDH * 1.0025); // 0.25% min breakout conviction
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
    const broke = prev.some(b => b.close < levels.PDL * 0.9975); // 0.25% min breakout conviction
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

    // Point A: swing low/high in the left 60% of lookback
    let A = isLong ? Infinity : -Infinity, A_idx = -1;
    for (let i = 0; i < Math.floor(m * 0.6); i++) {
      const v = isLong ? b[i].low : b[i].high;
      if (isLong ? v < A : v > A) { A = v; A_idx = i; }
    }
    if (A_idx < 0 || A_idx > m - 8) continue;

    // Point B: FIRST local peak after A that is followed by a meaningful pullback.
    // Do NOT take the global highest high — that picks up wave 2 and breaks the anchors.
    let B = isLong ? -Infinity : Infinity, B_idx = -1;
    for (let i = A_idx + 1; i < m - 5; i++) {
      const v = isLong ? b[i].high : b[i].low;
      if (isLong ? v <= A : v >= A) continue; // must move away from A

      // Local peak: next 2 bars go the other way
      const next1 = isLong ? b[i + 1]?.high : b[i + 1]?.low;
      const next2 = isLong ? b[i + 2]?.high : b[i + 2]?.low;
      if (next1 == null || next2 == null) continue;
      const isPeak = isLong ? next1 < v && next2 < v : next1 > v && next2 > v;
      if (!isPeak) continue;

      // Meaningful pullback must follow within 12 bars
      let C_look = isLong ? Infinity : -Infinity;
      for (let j = i + 1; j < Math.min(i + 13, m); j++) {
        const cv = isLong ? b[j].low : b[j].high;
        if (isLong ? cv < C_look : cv > C_look) C_look = cv;
      }
      const w1 = Math.abs(v - A);
      const pb = Math.abs(v - C_look) / w1;
      if (pb < 0.2 || pb > 0.8) continue;

      B = v; B_idx = i;
      break; // first valid local peak only
    }
    if (B_idx < 0) continue;

    const wave1 = Math.abs(B - A);
    if (wave1 < A * 0.001) continue;

    // Point C: deepest pullback within 12 bars of B
    let C = isLong ? Infinity : -Infinity, C_idx = -1;
    for (let i = B_idx + 1; i < Math.min(B_idx + 13, m - 2); i++) {
      const v = isLong ? b[i].low : b[i].high;
      if (isLong ? v < C : v > C) { C = v; C_idx = i; }
    }
    if (C_idx < 0) continue;
    const pbPct = Math.abs(B - C) / wave1;
    if (pbPct < 0.2 || pbPct > 0.8) continue;

    // 100% extension = C + wave1 range
    const ext100 = isLong ? C + wave1 : C - wave1;

    // Wave 2 peak: must reach at least 98% of the 100% extension
    let W2 = isLong ? -Infinity : Infinity, W2_idx = -1;
    for (let i = C_idx + 1; i < m; i++) {
      const v   = isLong ? b[i].high : b[i].low;
      const hit = isLong ? v >= ext100 * 0.998 : v <= ext100 * 1.002;
      if (hit && (isLong ? v > W2 : v < W2)) { W2 = v; W2_idx = i; }
    }
    if (W2_idx < 0) continue;

    // Entry zone: 50% and 61.8% retracement of wave 2 (C → W2)
    const w2Range  = Math.abs(W2 - C);
    const entry50  = isLong ? W2 - w2Range * 0.5   : W2 + w2Range * 0.5;
    const entry618 = isLong ? W2 - w2Range * 0.618 : W2 + w2Range * 0.618;

    // Most recent bar pulling back into 50–61.8% zone
    const last = b[m - 1];
    const inZone = isLong
      ? last.low <= entry50 * 1.001 && last.close >= entry618 * 0.999
      : last.high >= entry50 * 0.999 && last.close <= entry618 * 1.001;
    if (!inZone) continue;

    // Stop below Point C (structural)
    const stop = isLong ? C * 0.9992 : C * 1.0008;
    const risk  = Math.abs(entry50 - stop);
    if (risk === 0) continue;

    // Targets: 161.8% and 200% of trend-based extension
    const t1 = isLong ? C + wave1 * 1.618 : C - wave1 * 1.618;
    const t2 = isLong ? C + wave1 * 2.0   : C - wave1 * 2.0;
    if (Math.abs(t1 - entry50) / risk < MIN_RR) continue;

    return {
      type: 'CISD-Fib', direction: dir, level: '100%',
      entryLow:  isLong ? entry618 : entry50,
      entryHigh: isLong ? entry50  : entry618,
      stop, t1, t1Name: '161.8%', t2, t2Name: '200%',
    };
  }
  return null;
}

function detectCISD(bars) {
  if (!bars || bars.length < 12) return null;
  const b = bars.slice(-21, -1); // last 20 completed bars
  const m = b.length;
  let best = null;

  for (let i = 2; i < m - 2; i++) {
    // Swing low → bullish CISD
    if (b[i].low < b[i - 1].low && b[i].low < b[i + 1].low) {
      const seriesHigh = Math.max(b[Math.max(0, i - 3)].high, b[i - 2].high, b[i - 1].high);
      for (let k = i + 1; k < m; k++) {
        if (b[k].close > seriesHigh && k >= m - 6) {
          if (!best || k > best._k)
            best = { direction: 'LONG', entry: b[k].close, stop: b[i].low * 0.9992, _k: k };
          break;
        }
      }
    }
    // Swing high → bearish CISD
    if (b[i].high > b[i - 1].high && b[i].high > b[i + 1].high) {
      const seriesLow = Math.min(b[Math.max(0, i - 3)].low, b[i - 2].low, b[i - 1].low);
      for (let k = i + 1; k < m; k++) {
        if (b[k].close < seriesLow && k >= m - 6) {
          if (!best || k > best._k)
            best = { direction: 'SHORT', entry: b[k].close, stop: b[i].high * 1.0008, _k: k };
          break;
        }
      }
    }
  }

  return best ? { direction: best.direction, entry: best.entry, stop: best.stop } : null;
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
  const p1 = pnl(entry, t1, direction, ticker);
  const p2 = pnl(entry, t2, direction, ticker);
  const r1 = rrStr(entry, t1, stop, direction);

  return [
    `${emoji} *STOICTA — ${ticker} ${type} at ${level}*`,
    `Direction: *${direction}* ${arrow}`,
    `Entry zone: ${f(entryLow)}–${f(entryHigh)}`,
    `Stop: ${f(stop)}`,
    t1 != null ? `T1: ${f(t1)} (${t1Name}) → ${p1 != null ? `+$${p1}/contract` : '—'}` : null,
    t2 != null ? `T2: ${f(t2)} (${t2Name}) → ${p2 != null ? `+$${p2}/contract` : '—'}` : null,
    r1 ? `R:R T1: ${r1}:1 | Macro: ${macro}` : `Macro: ${macro}`,
    `_${etNow()} ET_`,
  ].filter(Boolean).join('\n');
}

function buildCISDFibMsg(ticker, setup, macro) {
  const { direction, entryLow, entryHigh, stop, t1, t1Name, t2, t2Name } = setup;
  const entry = (entryLow + entryHigh) / 2;
  const arrow  = direction === 'LONG' ? '↑' : '↓';
  const p1 = pnl(entry, t1, direction, ticker);
  const p2 = pnl(entry, t2, direction, ticker);
  const r1 = rrStr(entry, t1, stop, direction);

  return [
    `📐 *STOICTA — ${ticker} CISD-Fib Extension*`,
    `Direction: *${direction}* ${arrow}`,
    `100% extension hit — limit at 50% retracement`,
    `Entry zone: ${f(entryLow)}–${f(entryHigh)}`,
    `Stop: ${f(stop)}`,
    t1 != null ? `T1: ${f(t1)} (${t1Name}) → ${p1 != null ? `+$${p1}/ct` : '—'}` : null,
    t2 != null ? `T2: ${f(t2)} (${t2Name}) → ${p2 != null ? `+$${p2}/ct` : '—'}` : null,
    r1 ? `R:R T1: ${r1}:1 | Macro: ${macro}` : `Macro: ${macro}`,
    `_${etNow()} ET_`,
  ].filter(Boolean).join('\n');
}

function buildTTMsg(ticker, cisd, fractal, macro) {
  const { direction, entry, stop } = cisd;
  const arrow = direction === 'LONG' ? '↑' : '↓';
  const set   = fractal.activeFibSets?.[0] ?? {};
  const wantDir = direction;
  const rawT1 = set['-1'] ?? null;
  const rawT2 = set['-2'] ?? null;
  const t1 = rawT1 != null && (wantDir === 'LONG' ? rawT1 > entry : rawT1 < entry) ? rawT1 : null;
  const t2 = rawT2 != null && (wantDir === 'LONG' ? rawT2 > entry : rawT2 < entry) ? rawT2 : null;
  const p1 = pnl(entry, t1, direction, ticker);
  const p2 = pnl(entry, t2, direction, ticker);
  const r1 = rrStr(entry, t1, stop, direction);

  return [
    `🎯 *TTRADES — ${ticker} CISD*`,
    `Direction: *${direction}* ${arrow}`,
    `Fractal bias: ${fractal.bias} (${fractal.model ?? '—'})`,
    `Entry: ${f(entry)}`,
    `Stop: ${f(stop)}`,
    t1 != null ? `T1: ${f(t1)} (fib -1) → ${p1 != null ? `+$${p1}/contract` : '—'}` : null,
    t2 != null ? `T2: ${f(t2)} (fib -2) → ${p2 != null ? `+$${p2}/contract` : '—'}` : null,
    r1 ? `R:R T1: ${r1}:1 | Macro: ${macro}` : `Macro: ${macro}`,
    `_${etNow()} ET_`,
  ].filter(Boolean).join('\n');
}

// ─── Chart drawing ────────────────────────────────────────────────────────────

async function drawSignal(ticker, setup, macro, tvConnected) {
  if (!tvConnected) return;
  try {
    await coreChart.setSymbol({ symbol: TV_SYMBOL[ticker] });
    await new Promise(r => setTimeout(r, 1000));

    const { type, direction, level, entryLow, entryHigh, stop, t1, t1Name, t2, t2Name } = setup;
    const entry = (entryLow + entryHigh) / 2;
    const now   = Math.floor(Date.now() / 1000);
    const color = direction === 'LONG' ? '#1976D2' : '#e53935';
    const p1    = pnl(entry, t1, direction, ticker);
    const r1    = rrStr(entry, t1, stop, direction);

    // Entry line
    await coreDrawing.drawShape({ shape: 'horizontal_line',
      point: { time: now, price: entry },
      overrides: JSON.stringify({ linecolor: color, linewidth: 2, linestyle: 0 }),
      text: `${direction} Entry` });

    // Stop line (dashed red)
    await coreDrawing.drawShape({ shape: 'horizontal_line',
      point: { time: now, price: stop },
      overrides: JSON.stringify({ linecolor: '#e53935', linewidth: 1, linestyle: 2 }),
      text: 'Stop' });

    // T1 line (green dashed)
    if (t1 != null) {
      await coreDrawing.drawShape({ shape: 'horizontal_line',
        point: { time: now, price: t1 },
        overrides: JSON.stringify({ linecolor: '#43a047', linewidth: 1, linestyle: 1 }),
        text: `T1 (${t1Name})` });
    }

    // T2 line (lighter green)
    if (t2 != null) {
      await coreDrawing.drawShape({ shape: 'horizontal_line',
        point: { time: now, price: t2 },
        overrides: JSON.stringify({ linecolor: '#a5d6a7', linewidth: 1, linestyle: 1 }),
        text: `T2 (${t2Name})` });
    }

    // Label — sits above entry for SHORT, below for LONG
    const labelOffset = (stop - entry) * 0.5;
    await coreDrawing.drawShape({ shape: 'text',
      point: { time: now, price: entry + labelOffset },
      text: `${direction === 'LONG' ? '🔵' : '🔴'} ${ticker} ${type} ${direction} @ ${level}  |  Stop: ${f(stop)}  |  T1: ${f(t1)} +$${p1 ?? '?'}/ct  |  R:R ${r1 ?? '?'}:1  |  ${macro}`,
      overrides: JSON.stringify({ color, fontsize: 11, bold: true }) });

  } catch (err) {
    console.error(`[${ticker}] draw error: ${err.message}`);
  }
}

// ─── Per-ticker scan ──────────────────────────────────────────────────────────

async function scan(ticker, tvData) {
  const sym = YAHOO[ticker];

  const [bars5d, bars30d, yahooPD] = await Promise.all([
    fetchBars(sym, '5m', '5d'),
    fetchBars(sym, '5m', '30d'),
    fetchYahooPD(sym),
  ]);

  if (bars5d.length < 10) return [];

  // Levels: TV Stoic Edge labels preferred, Yahoo PD as fallback
  const tvLevels = tvData?.[ticker]?.levels ?? {};
  const levels = {
    PDH: tvLevels.PDH ?? yahooPD?.PDH,
    PDL: tvLevels.PDL ?? yahooPD?.PDL,
    PDC: tvLevels.PDC ?? yahooPD?.PDC,
    PWH: tvLevels.PWH, PWL: tvLevels.PWL,
    HCOM: tvLevels.HCOM, LCOM: tvLevels.LCOM,
  };

  if (!levels.PDH && !levels.PDL) return [];

  const price = bars5d.at(-1).close;
  const s20   = sma(bars30d.map(b => b.close), 20);
  const s200  = sma(bars30d.map(b => b.close), 200);
  const macro = macroBias(price, s20, s200);

  // Fractal data: live TV preferred, cache fallback
  const fractal = tvData?.[ticker]?.fractal ?? FRACTAL[ticker] ?? null;

  const out = [];

  const bullishMacro = ['BULLISH', 'BOUNCE', 'AT THE CROSS'];
  const bearishMacro = ['BEARISH', 'PULLBACK', 'AT THE CROSS'];

  // STOICTA — SFP (SFP at a level can trade against macro — level is the filter)
  for (const setup of detectSFP(bars5d, levels)) {
    if (setup.direction === 'SHORT' && macro === 'BULLISH') continue;
    if (setup.direction === 'LONG'  && macro === 'BEARISH') continue;
    const key = `${ticker}_SFP_${setup.level}_${setup.direction}`;
    if (!isDupe(key)) out.push({ key, msg: buildStoicMsg(ticker, setup, macro), ticker, setup, macro });
  }

  // STOICTA — B&R (stricter: must align with macro direction)
  for (const setup of detectBnR(bars5d, levels)) {
    if (setup.direction === 'SHORT' && !bearishMacro.includes(macro)) continue;
    if (setup.direction === 'LONG'  && !bullishMacro.includes(macro)) continue;
    const key = `${ticker}_BnR_${setup.level}_${setup.direction}`;
    if (!isDupe(key)) out.push({ key, msg: buildStoicMsg(ticker, setup, macro), ticker, setup, macro });
  }

  // STOICTA — CISD-Fib: 100% extension hit → limit at 50% retracement
  const cisdFib = detectCISDFib(bars5d);
  if (cisdFib) {
    if (cisdFib.direction === 'SHORT' && macro === 'BULLISH') { /* skip */ }
    else if (cisdFib.direction === 'LONG' && macro === 'BEARISH') { /* skip */ }
    else {
      const key = `${ticker}_CISDFib_${cisdFib.direction}`;
      if (!isDupe(key)) out.push({ key, msg: buildCISDFibMsg(ticker, cisdFib, macro), ticker, setup: cisdFib, macro });
    }
  }

  // TTRADES — CISD + fractal bias
  if (fractal?.bias && fractal.bias !== 'Neutral') {
    const cisd    = detectCISD(bars5d);
    const wantDir = fractal.bias === 'Bullish' ? 'LONG' : 'SHORT';
    if (cisd?.direction === wantDir) {
      const key = `${ticker}_TTRADES_${cisd.direction}`;
      // Build a setup-like object for drawing
      const set   = fractal.activeFibSets?.[0] ?? {};
      const t1Raw = set['-1'] ?? null;
      const t2Raw = set['-2'] ?? null;
      const ttSetup = { type: 'TTRADES', direction: cisd.direction,
        level: 'CISD', entryLow: cisd.entry * 0.9999, entryHigh: cisd.entry * 1.0001,
        stop: cisd.stop,
        t1: t1Raw && (cisd.direction === 'LONG' ? t1Raw > cisd.entry : t1Raw < cisd.entry) ? t1Raw : null, t1Name: 'fib -1',
        t2: t2Raw && (cisd.direction === 'LONG' ? t2Raw > cisd.entry : t2Raw < cisd.entry) ? t2Raw : null, t2Name: 'fib -2' };
      if (!isDupe(key)) out.push({ key, msg: buildTTMsg(ticker, cisd, fractal, macro), ticker, setup: ttSetup, macro });
    }
  }

  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const ts = new Date().toISOString();

  // Check open trades first — send updates before scanning for new ones
  await checkOpenTrades();

  // Fetch live TV data for all tickers (switches chart per ticker)
  // Returns null if TV is down — individual tickers will fall back to cache
  const tvData = await fetchAllTVData();
  if (!tvData) {
    console.log(`[${ts}] TV offline — using fractal-cache.json for TTRADES bias`);
    await telegram('⚠️ *Signals:* TV offline — TTRADES bias from cache. STOICTA levels from Yahoo.');
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
