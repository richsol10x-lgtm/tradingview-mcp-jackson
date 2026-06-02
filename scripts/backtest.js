#!/usr/bin/env node
// scripts/backtest.js — Backtests Setup A (B&R) + B (SFP) + C (SBS) + D (TTrades CISD)
// Usage: node scripts/backtest.js [TICKER]   (omit for all four)

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const env       = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

const SYMBOLS = {
  MNQ: 'MNQ=F',
  MES: 'MES=F',
  MGC: 'MGC=F',
  SIL: 'SIL=F',
};

const MAX_RETEST    = 24;
const MAX_HOLD      = 100;    // bars (5M) — 8.3h max hold
const MAX_HOLD_1M   = 500;    // bars (1M) — 8.3h max hold
const MIN_WICK      = 0.0015;
const MIN_BREAK     = 0.001;
const RETEST_WINDOW = 0.002;
const SWING_LB_SBS  = 15;    // lookback bars for local swing high/low
const MAX_MOVE_BARS = 48;    // max bars per SBS move
const MODEL2_DEPTH  = 0.005; // >0.5% from swing level → Model 2
const SBS_RETEST    = 0.003; // 0.3% tolerance for M2 pullback to level

function isNYSession(ts) {
  const str = new Date(ts * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: false,
  });
  const [h, m] = str.split(':').map(Number);
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960;
}

async function fetchOHLCV(symbol, interval, range) {
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  const r    = json?.chart?.result?.[0];
  if (!r) throw new Error(`No data for ${symbol} (${interval}/${range})`);
  const ts   = r.timestamp;
  const q    = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null || !isFinite(v))) continue;
    bars.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return bars;
}

function dateStr(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function buildDailyLevels(dailyBars) {
  const map = {};
  for (let i = 1; i < dailyBars.length; i++) {
    const prev = dailyBars[i - 1];
    const curr = dailyBars[i];
    map[dateStr(curr.t)] = { PDH: prev.h, PDL: prev.l, PDC: prev.c };
  }
  return map;
}

// Pre-compute 15M C2/C3 signals: each bar that closes as C2 or C3 emits a bias signal.
// C2 bullish: bar sweeps prev low, closes back above.
// C2 bearish: bar sweeps prev high, closes back below.
// C3 bullish: prev was a failed bullish C2 (swept below, didn't close back) → current closes above prev.open.
// C3 bearish: mirror.
function build15mSignals(bars15m) {
  const signals = [];
  for (let i = 2; i < bars15m.length; i++) {
    const bar  = bars15m[i];
    const prev = bars15m[i - 1];
    let bias   = null;
    // C2
    if      (bar.l < prev.l && bar.c > prev.l) bias = 'BULLISH';
    else if (bar.h > prev.h && bar.c < prev.h) bias = 'BEARISH';
    // C3 (prev was a failed C2 attempt)
    else if (i >= 3) {
      const prev2 = bars15m[i - 2];
      if      (prev.l < prev2.l && prev.c <= prev2.l && bar.c > prev.o) bias = 'BULLISH';
      else if (prev.h > prev2.h && prev.c >= prev2.h && bar.c < prev.o) bias = 'BEARISH';
    }
    if (bias) signals.push({ closeTime: bar.t + 900, bias });
  }
  return signals;
}

function stats(trades) {
  if (!trades.length) return { count: 0, wins: 0, losses: 0, winRate: 0, avgWinBars: 0, avgLossBars: 0, mfeLosses: 0, mfeLossPct: 0 };
  const wins      = trades.filter(t => t.result === 'WIN');
  const losses    = trades.filter(t => t.result === 'LOSS');
  const mfeLosses = losses.filter(t => t.wentFavorable).length;
  const avg       = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  return {
    count:       trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     Math.round((wins.length / trades.length) * 100),
    avgWinBars:  avg(wins.map(t => t.bars)),
    avgLossBars: avg(losses.map(t => t.bars)),
    mfeLosses,
    mfeLossPct:  losses.length ? Math.round((mfeLosses / losses.length) * 100) : 0,
  };
}

function checkOutcome(bars, fromIdx, entryPrice, stopPrice, targetPrice, maxHold = MAX_HOLD) {
  const isLong = targetPrice > entryPrice;
  let wentFavorable = false;
  for (let i = fromIdx; i < Math.min(fromIdx + maxHold, bars.length); i++) {
    const { h, l } = bars[i];
    if (isLong  && h > entryPrice) wentFavorable = true;
    if (!isLong && l < entryPrice) wentFavorable = true;
    const hitTarget = isLong             ? h >= targetPrice : l <= targetPrice;
    const hitStop   = stopPrice < entryPrice ? l <= stopPrice : h >= stopPrice;
    if (hitTarget && hitStop) return { result: 'WIN',  bars: i - fromIdx, wentFavorable };
    if (hitTarget) return { result: 'WIN',  bars: i - fromIdx, wentFavorable };
    if (hitStop)   return { result: 'LOSS', bars: i - fromIdx, wentFavorable };
  }
  return { result: 'EXPIRED', bars: maxHold, wentFavorable };
}

function runSetupA(bars, levels, rMultiplier = 2) {
  const trades   = [];
  const usedDays = new Set();

  for (let i = 1; i < bars.length - MAX_HOLD; i++) {
    const bar  = bars[i];
    const prev = bars[i - 1];
    const lvl  = levels[dateStr(bar.t)];
    if (!lvl || !isNYSession(bar.t)) continue;

    const { PDH, PDL, PDC } = lvl;
    const candidates = [
      { level: PDH, key: 'PDH-LONG',  dir: 'LONG',  broke: prev.c <= PDH && bar.c > PDH * (1 + MIN_BREAK) },
      { level: PDL, key: 'PDL-SHORT', dir: 'SHORT', broke: prev.c >= PDL && bar.c < PDL * (1 - MIN_BREAK) },
      { level: PDC, key: 'PDC-LONG',  dir: 'LONG',  broke: PDC && prev.c <= PDC && bar.c > PDC * (1 + MIN_BREAK) },
      { level: PDC, key: 'PDC-SHORT', dir: 'SHORT', broke: PDC && prev.c >= PDC && bar.c < PDC * (1 - MIN_BREAK) },
    ];

    for (const { level, key, dir, broke } of candidates) {
      if (!level || !broke) continue;
      const dayKey = `${dateStr(bar.t)}-${key}`;
      if (usedDays.has(dayKey)) continue;
      usedDays.add(dayKey);

      for (let j = i + 1; j < Math.min(i + MAX_RETEST, bars.length); j++) {
        const rb      = bars[j];
        const hi      = level * (1 + RETEST_WINDOW);
        const lo      = level * (1 - RETEST_WINDOW);
        const touched = dir === 'LONG' ? rb.l <= hi && rb.l >= lo : rb.h >= lo && rb.h <= hi;
        if (!touched) continue;
        const entry  = level;
        const stop   = dir === 'LONG' ? rb.l : rb.h;
        const rDist  = dir === 'LONG' ? entry - stop : stop - entry;
        if (rDist <= 0) break;
        const target = dir === 'LONG' ? entry + rMultiplier * rDist : entry - rMultiplier * rDist;
        const out    = checkOutcome(bars, j + 1, entry, stop, target);
        if (out.result !== 'EXPIRED')
          trades.push({ dir, level: key, entry, stop, target, ...out, date: dateStr(bar.t) });
        break;
      }
    }
  }
  return trades;
}

function runSetupB(bars, levels, rMultiplier = 2) {
  const trades   = [];
  const usedDays = new Set();

  for (let i = 1; i < bars.length - MAX_HOLD; i++) {
    const bar = bars[i];
    const lvl = levels[dateStr(bar.t)];
    if (!lvl || !isNYSession(bar.t)) continue;

    const { PDH, PDL, PDC } = lvl;
    const candidates = [
      { level: PDH, key: 'PDH-SFP',     dir: 'SHORT', sfp: bar.h > PDH * (1 + MIN_WICK) && bar.c < PDH },
      { level: PDL, key: 'PDL-SFP',     dir: 'LONG',  sfp: bar.l < PDL * (1 - MIN_WICK) && bar.c > PDL },
      { level: PDC, key: 'PDC-HIGH-SFP',dir: 'SHORT', sfp: PDC && bar.h > PDC * (1 + MIN_WICK) && bar.c < PDC },
      { level: PDC, key: 'PDC-LOW-SFP', dir: 'LONG',  sfp: PDC && bar.l < PDC * (1 - MIN_WICK) && bar.c > PDC },
    ];

    for (const { level, key, dir, sfp } of candidates) {
      if (!level || !sfp) continue;
      const dayKey = `${dateStr(bar.t)}-${key}`;
      if (usedDays.has(dayKey)) continue;
      usedDays.add(dayKey);

      const entry = bar.c;
      const stop  = dir === 'LONG' ? bar.l : bar.h;
      const rDist = dir === 'LONG' ? entry - stop : stop - entry;
      if (rDist <= 0) continue;
      const target = dir === 'LONG' ? entry + rMultiplier * rDist : entry - rMultiplier * rDist;
      const out    = checkOutcome(bars, i + 1, entry, stop, target);
      if (out.result !== 'EXPIRED')
        trades.push({ dir, level: key, entry, stop, target, ...out, date: dateStr(bar.t) });
    }
  }
  return trades;
}

// Setup C — SBS 5-move sequence, both directions, both models
function runSetupC(bars, rMultiplier = 2) {
  const trades   = [];
  const usedDays = new Set();

  for (let i = SWING_LB_SBS; i < bars.length - MAX_HOLD; i++) {
    // --- BULLISH SBS ---
    {
      const swingH       = Math.max(...bars.slice(i - SWING_LB_SBS, i).map(b => b.h));
      const M1_breakLevel = swingH;

      if (bars[i].c > M1_breakLevel) {
        const M1_high = bars[i].h;

        // M2: pullback to break level
        let m2Idx = -1, m2Low = Infinity;
        for (let j = i + 1; j < Math.min(i + MAX_MOVE_BARS, bars.length); j++) {
          if (bars[j].l < M1_breakLevel * (1 - MODEL2_DEPTH)) break; // dropped way below, abort
          if (bars[j].l <= M1_breakLevel * (1 + SBS_RETEST) &&
              bars[j].l >= M1_breakLevel * (1 - SBS_RETEST)) {
            m2Idx = j; m2Low = bars[j].l; break;
          }
        }
        if (m2Idx === -1) continue;

        // M3: new high beyond M1
        let m3Idx = -1, m3High = M1_high;
        for (let j = m2Idx + 1; j < Math.min(m2Idx + MAX_MOVE_BARS, bars.length); j++) {
          if (bars[j].l < m2Low * (1 - 0.001)) break; // dropped below M2 before M3
          if (bars[j].h > M1_high) { m3Idx = j; m3High = bars[j].h; break; }
        }
        if (m3Idx === -1) continue;

        // M4: drops below M2 low — find deepest point
        let m4Low = Infinity, m4EndIdx = -1;
        for (let j = m3Idx + 1; j < Math.min(m3Idx + MAX_MOVE_BARS, bars.length); j++) {
          if (bars[j].h > m3High * (1 + MODEL2_DEPTH)) break; // sustained new high = reset
          if (bars[j].l < m2Low) {
            if (bars[j].l < m4Low) { m4Low = bars[j].l; m4EndIdx = j; }
          }
        }
        if (m4EndIdx === -1) continue;

        const model = (M1_breakLevel - m4Low) / M1_breakLevel > MODEL2_DEPTH ? 'M2' : 'M1';

        // M5: first bar closing above M4 low = entry
        for (let j = m4EndIdx + 1; j < Math.min(m4EndIdx + MAX_MOVE_BARS, bars.length); j++) {
          if (!isNYSession(bars[j].t)) continue;
          if (bars[j].c > m4Low) {
            const dayKey = `${dateStr(bars[j].t)}-SBS-LONG`;
            if (!usedDays.has(dayKey)) {
              usedDays.add(dayKey);
              const entry = bars[j].c;
              const rDist = entry - m4Low;
              if (rDist > 0) {
                const out = checkOutcome(bars, j + 1, entry, m4Low, entry + rMultiplier * rDist);
                if (out.result !== 'EXPIRED')
                  trades.push({ dir: 'LONG', model, entry, stop: m4Low, ...out, date: dateStr(bars[j].t) });
              }
            }
            break;
          }
        }
      }
    }

    // --- BEARISH SBS ---
    {
      const swingL        = Math.min(...bars.slice(i - SWING_LB_SBS, i).map(b => b.l));
      const M1_breakLevel = swingL;

      if (bars[i].c < M1_breakLevel) {
        const M1_low = bars[i].l;

        // M2: pullback to break level
        let m2Idx = -1, m2High = -Infinity;
        for (let j = i + 1; j < Math.min(i + MAX_MOVE_BARS, bars.length); j++) {
          if (bars[j].h > M1_breakLevel * (1 + MODEL2_DEPTH)) break;
          if (bars[j].h >= M1_breakLevel * (1 - SBS_RETEST) &&
              bars[j].h <= M1_breakLevel * (1 + SBS_RETEST)) {
            m2Idx = j; m2High = bars[j].h; break;
          }
        }
        if (m2Idx === -1) continue;

        // M3: new low beyond M1
        let m3Idx = -1, m3Low = M1_low;
        for (let j = m2Idx + 1; j < Math.min(m2Idx + MAX_MOVE_BARS, bars.length); j++) {
          if (bars[j].h > m2High * (1 + 0.001)) break;
          if (bars[j].l < M1_low) { m3Idx = j; m3Low = bars[j].l; break; }
        }
        if (m3Idx === -1) continue;

        // M4: rises above M2 high — find highest point
        let m4High = -Infinity, m4EndIdx = -1;
        for (let j = m3Idx + 1; j < Math.min(m3Idx + MAX_MOVE_BARS, bars.length); j++) {
          if (bars[j].l < m3Low * (1 - MODEL2_DEPTH)) break;
          if (bars[j].h > m2High) {
            if (bars[j].h > m4High) { m4High = bars[j].h; m4EndIdx = j; }
          }
        }
        if (m4EndIdx === -1) continue;

        const model = (m4High - M1_breakLevel) / M1_breakLevel > MODEL2_DEPTH ? 'M2' : 'M1';

        // M5: first bar closing below M4 high = entry
        for (let j = m4EndIdx + 1; j < Math.min(m4EndIdx + MAX_MOVE_BARS, bars.length); j++) {
          if (!isNYSession(bars[j].t)) continue;
          if (bars[j].c < m4High) {
            const dayKey = `${dateStr(bars[j].t)}-SBS-SHORT`;
            if (!usedDays.has(dayKey)) {
              usedDays.add(dayKey);
              const entry = bars[j].c;
              const rDist = m4High - entry;
              if (rDist > 0) {
                const out = checkOutcome(bars, j + 1, entry, m4High, entry - rMultiplier * rDist);
                if (out.result !== 'EXPIRED')
                  trades.push({ dir: 'SHORT', model, entry, stop: m4High, ...out, date: dateStr(bars[j].t) });
              }
            }
            break;
          }
        }
      }
    }
  }
  return trades;
}

// CISD: consecutive down-close (bullish) or up-close (bearish) series ending at idx-1,
// current bar closes through all their opens
function findCISD(bars, idx, direction) {
  if (idx < 2) return null;
  const run = [];
  for (let j = idx - 1; j >= Math.max(0, idx - 15); j--) {
    const b = bars[j];
    if (direction === 'BULLISH' && b.c >= b.o) break;
    if (direction === 'BEARISH' && b.c <= b.o) break;
    run.unshift(b);
  }
  if (run.length < 2) return null;
  const curr = bars[idx];
  if (direction === 'BULLISH') {
    const maxOpen   = Math.max(...run.map(b => b.o));
    const seriesLow = Math.min(...run.map(b => b.l));
    return curr.c > maxOpen ? { seriesLow } : null;
  } else {
    const minOpen    = Math.min(...run.map(b => b.o));
    const seriesHigh = Math.max(...run.map(b => b.h));
    return curr.c < minOpen ? { seriesHigh } : null;
  }
}

// Setup D — TTrades CISD.
// Bias: 15M C2/C3 signal (build15mSignals). Entry: CISD on cisdBars (1M or 5M).
// Signal stays valid for up to 1 hour (4 × 15M bars) after the C2/C3 close.
// One trade per day per direction per timeframe.
function runSetupD(cisdBars, signals15m, rMultiplier = 2, maxHoldBars = MAX_HOLD) {
  const trades   = [];
  const usedDays = new Set();
  let   sigPtr   = 0;

  for (let i = 2; i < cisdBars.length - maxHoldBars; i++) {
    const bar = cisdBars[i];
    if (!isNYSession(bar.t)) continue;

    // Advance two-pointer to most recent 15M signal that has closed
    while (sigPtr + 1 < signals15m.length && signals15m[sigPtr + 1].closeTime <= bar.t) sigPtr++;

    const sig = signals15m[sigPtr];
    if (!sig || sig.closeTime > bar.t || bar.t - sig.closeTime > 3600) continue;

    const dBias = sig.bias;
    const cisd  = findCISD(cisdBars, i, dBias);
    if (!cisd) continue;

    const dayKey = `${dateStr(bar.t)}-D-${dBias}`;
    if (usedDays.has(dayKey)) continue;
    usedDays.add(dayKey);

    const entry = bar.c;
    let stop, rDist;
    if (dBias === 'BULLISH') { stop = cisd.seriesLow;  rDist = entry - stop; }
    else                      { stop = cisd.seriesHigh; rDist = stop - entry; }
    if (rDist <= 0) continue;

    const target = dBias === 'BULLISH' ? entry + rMultiplier * rDist : entry - rMultiplier * rDist;
    const dir    = dBias === 'BULLISH' ? 'LONG' : 'SHORT';
    const out    = checkOutcome(cisdBars, i + 1, entry, stop, target, maxHoldBars);
    if (out.result !== 'EXPIRED')
      trades.push({ dir, entry, stop, target, ...out, date: dateStr(bar.t) });
  }
  return trades;
}

function formatReport(results) {
  const m5  = b => b * 5;
  const pct = n => String(n + '%').padEnd(5);

  const mfeStr = s => s.losses ? `  Losses that went green first: ${s.mfeLosses}/${s.losses} (${s.mfeLossPct}%)` : '';

  const rowAB = (label, s2, s3) => s2.count
    ? `${label} (${s2.count} trades)\n` +
      `  2R: ${pct(s2.winRate)}  ~${m5(s2.avgWinBars)}min to target\n` +
      `  3R: ${pct(s3.winRate)}  ~${m5(s3.avgWinBars)}min to target\n` +
      mfeStr(s2)
    : `${label}: no setups found`;

  const rowC = (s2, s3) => {
    if (!s2.count) return `Setup C — SBS: no setups found`;
    const lines = [
      `Setup C — SBS (${s2.count} trades)`,
      `  2R: ${pct(s2.winRate)}  ~${m5(s2.avgWinBars)}min to target`,
      `  3R: ${pct(s3.winRate)}  ~${m5(s3.avgWinBars)}min to target`,
      mfeStr(s2),
    ];
    if (s2.m1.count) lines.push(`  M1 (shallow): ${s2.m1.count} trades | ${s2.m1.winRate}% win | green first: ${s2.m1.mfeLossPct}%`);
    if (s2.m2.count) lines.push(`  M2 (deep):    ${s2.m2.count} trades | ${s2.m2.winRate}% win | green first: ${s2.m2.mfeLossPct}%`);
    return lines.join('\n');
  };

  const rowD = (d5s2, d5s3, d1s2, d1s3) => {
    const lines = [];
    if (d5s2.count)
      lines.push(
        `Setup D — TTrades CISD · 5M entry (${d5s2.count} trades, 60d)`,
        `  2R: ${pct(d5s2.winRate)}  ~${m5(d5s2.avgWinBars)}min to target`,
        `  3R: ${pct(d5s3.winRate)}  ~${m5(d5s3.avgWinBars)}min to target`,
        mfeStr(d5s2),
      );
    else lines.push(`Setup D — TTrades CISD · 5M entry: no setups found`);
    if (d1s2.count)
      lines.push(
        `Setup D — TTrades CISD · 1M entry (${d1s2.count} trades, 7d)`,
        `  2R: ${pct(d1s2.winRate)}  ~${d1s2.avgWinBars}min to target`,
        `  3R: ${pct(d1s3.winRate)}  ~${d1s3.avgWinBars}min to target`,
        mfeStr(d1s2),
      );
    else lines.push(`Setup D — TTrades CISD · 1M entry: no setups found (7d sample)`);
    return lines.join('\n');
  };

  const sections = results.map(({ key, setupA, setupB, setupC, setupD5, setupD1 }) => [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `${key} — Backtest`,
    ``,
    rowAB(`Setup A — B&R`, setupA['2R'], setupA['3R']),
    ``,
    rowAB(`Setup B — SFP`, setupB['2R'], setupB['3R']),
    ``,
    rowC(setupC['2R'], setupC['3R']),
    ``,
    rowD(setupD5['2R'], setupD5['3R'], setupD1['2R'], setupD1['3R']),
  ].join('\n'));

  return [
    `📊 STOIC EDGE — FULL BACKTEST`,
    `A+B: StoicTA PDH/PDL  |  C: SBS (5M)  |  D: TTrades 15M C2/C3 → 5M+1M CISD`,
    `A/B/C/D5: 60-day  |  D1: 7-day  |  NY session  |  Structural stops`,
    ``,
    ...sections,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Mechanical approximation only — real execution will vary.`,
  ].join('\n');
}

async function analyzeTicker(key) {
  const sym = SYMBOLS[key];
  const [bars5m, barsDaily, bars15m, bars1m] = await Promise.all([
    fetchOHLCV(sym, '5m',  '60d'),
    fetchOHLCV(sym, '1d',  '6mo'),
    fetchOHLCV(sym, '15m', '60d'),
    fetchOHLCV(sym, '1m',  '7d'),
  ]);

  const levels   = buildDailyLevels(barsDaily);
  const sigs15m  = build15mSignals(bars15m);

  const tradesC2R = runSetupC(bars5m, 2);
  const tradesC3R = runSetupC(bars5m, 3);
  const mkC = trades => ({
    ...stats(trades),
    m1: stats(trades.filter(t => t.model === 'M1')),
    m2: stats(trades.filter(t => t.model === 'M2')),
  });

  return {
    key,
    setupA:  { '2R': stats(runSetupA(bars5m, levels, 2)), '3R': stats(runSetupA(bars5m, levels, 3)) },
    setupB:  { '2R': stats(runSetupB(bars5m, levels, 2)), '3R': stats(runSetupB(bars5m, levels, 3)) },
    setupC:  { '2R': mkC(tradesC2R), '3R': mkC(tradesC3R) },
    setupD5: { '2R': stats(runSetupD(bars5m,  sigs15m, 2, MAX_HOLD)),   '3R': stats(runSetupD(bars5m,  sigs15m, 3, MAX_HOLD)) },
    setupD1: { '2R': stats(runSetupD(bars1m,  sigs15m, 2, MAX_HOLD_1M)),'3R': stats(runSetupD(bars1m,  sigs15m, 3, MAX_HOLD_1M)) },
  };
}

async function main() {
  const arg  = process.argv[2]?.toUpperCase();
  const keys = arg && SYMBOLS[arg] ? [arg] : Object.keys(SYMBOLS);

  console.log(`Running backtest for: ${keys.join(', ')} — please wait...`);

  const results = await Promise.all(keys.map(async key => {
    try {
      return await analyzeTicker(key);
    } catch (e) {
      const empty  = { count: 0, wins: 0, losses: 0, winRate: 0, avgWinBars: 0, avgLossBars: 0 };
      const emptyC = { ...empty, m1: empty, m2: empty };
      return {
        key, error: e.message,
        setupA:  { '2R': empty,  '3R': empty },
        setupB:  { '2R': empty,  '3R': empty },
        setupC:  { '2R': emptyC, '3R': emptyC },
        setupD5: { '2R': empty,  '3R': empty },
        setupD1: { '2R': empty,  '3R': empty },
      };
    }
  }));

  const cache = { updated: new Date().toISOString(), period: '60d' };
  for (const r of results)
    cache[r.key] = { setupA: r.setupA, setupB: r.setupB, setupC: r.setupC, setupD5: r.setupD5, setupD1: r.setupD1 };
  writeFileSync(join(__dirname, 'backtest-cache.json'), JSON.stringify(cache, null, 2));
  console.log('Cache saved → scripts/backtest-cache.json');

  const output = formatReport(results);
  console.log('\n' + output);

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: output }),
    });
    console.log((await r.json()).ok ? 'telegram: sent' : 'telegram: FAILED');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
