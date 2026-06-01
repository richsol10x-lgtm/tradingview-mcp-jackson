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
const MAX_HOLD      = 100;
const MAX_HOLD_15M  = 60;     // 60 × 15min = 15h max hold for Setup D
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

// Group 1H bars into 4H bars (every 4 consecutive)
function aggregateTo4H(bars1H) {
  const result = [];
  for (let i = 0; i + 3 < bars1H.length; i += 4) {
    const s = bars1H.slice(i, i + 4);
    result.push({
      t: s[0].t,
      o: s[0].o,
      h: Math.max(...s.map(b => b.h)),
      l: Math.min(...s.map(b => b.l)),
      c: s[3].c,
    });
  }
  return result;
}

// Build C2 bias for each complete 4H bar
function build4HBiases(bars4H) {
  const result = [];
  for (let i = 1; i < bars4H.length; i++) {
    const curr = bars4H[i];
    const prev = bars4H[i - 1];
    let bias   = null;
    if (curr.h > prev.h && curr.c < prev.h) bias = 'BEARISH';
    else if (curr.l < prev.l && curr.c > prev.l) bias = 'BULLISH';
    result.push({ endTime: curr.t + 4 * 3600, bias });
  }
  return result;
}

function getCurrent4HBias(biases4H, ts) {
  let latest = null;
  for (const b of biases4H) {
    if (b.endTime <= ts) latest = b.bias;
    else break;
  }
  return latest;
}

function stats(trades) {
  if (!trades.length) return { count: 0, wins: 0, losses: 0, winRate: 0, avgWinBars: 0, avgLossBars: 0 };
  const wins   = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const avg    = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  return {
    count:       trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     Math.round((wins.length / trades.length) * 100),
    avgWinBars:  avg(wins.map(t => t.bars)),
    avgLossBars: avg(losses.map(t => t.bars)),
  };
}

function checkOutcome(bars, fromIdx, entryPrice, stopPrice, targetPrice, maxHold = MAX_HOLD) {
  for (let i = fromIdx; i < Math.min(fromIdx + maxHold, bars.length); i++) {
    const { h, l } = bars[i];
    const hitTarget = targetPrice > entryPrice ? h >= targetPrice : l <= targetPrice;
    const hitStop   = stopPrice  < entryPrice  ? l <= stopPrice   : h >= stopPrice;
    if (hitTarget && hitStop) return { result: 'WIN', bars: i - fromIdx };
    if (hitTarget) return { result: 'WIN',  bars: i - fromIdx };
    if (hitStop)   return { result: 'LOSS', bars: i - fromIdx };
  }
  return { result: 'EXPIRED', bars: maxHold };
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

// Setup D — TTrades CISD on 15M, intraday daily C2 bias + 4H agreement required.
// Daily C2 is detected intraday: today's running H/L sweeps prev day's PDH/PDL and
// the current bar closes back inside → same logic as watching the daily bar form live.
function runSetupD(bars15m, biases4H, levels, rMultiplier = 2) {
  const trades   = [];
  const usedDays = new Set();
  const dayRunH  = {}; // date → running session high
  const dayRunL  = {}; // date → running session low

  for (let i = 3; i < bars15m.length - MAX_HOLD_15M; i++) {
    const bar   = bars15m[i];
    const today = dateStr(bar.t);
    if (!isNYSession(bar.t)) continue;

    const lvl = levels[today]; // prev day's PDH/PDL
    if (!lvl) continue;

    // Update running session OHLCV (NY session only)
    dayRunH[today] = Math.max(dayRunH[today] ?? bar.h, bar.h);
    dayRunL[today] = Math.min(dayRunL[today] ?? bar.l, bar.l);

    // Intraday C2: session has swept PDH/PDL and current bar closes back inside
    let dBias = null;
    if (dayRunH[today] > lvl.PDH && bar.c < lvl.PDH) dBias = 'BEARISH';
    else if (dayRunL[today] < lvl.PDL && bar.c > lvl.PDL) dBias = 'BULLISH';
    if (!dBias) continue;

    // 4H must agree
    const h4Bias = getCurrent4HBias(biases4H, bar.t);
    if (!h4Bias || h4Bias !== dBias) continue;

    // 15M CISD entry
    const cisd = findCISD(bars15m, i, dBias);
    if (!cisd) continue;

    const dayKey = `${today}-D-${dBias}`;
    if (usedDays.has(dayKey)) continue;
    usedDays.add(dayKey);

    const entry = bar.c;
    let stop, rDist;
    if (dBias === 'BULLISH') {
      stop  = cisd.seriesLow;
      rDist = entry - stop;
    } else {
      stop  = cisd.seriesHigh;
      rDist = stop - entry;
    }
    if (rDist <= 0) continue;

    const target = dBias === 'BULLISH' ? entry + rMultiplier * rDist : entry - rMultiplier * rDist;
    const dir    = dBias === 'BULLISH' ? 'LONG' : 'SHORT';
    const out    = checkOutcome(bars15m, i + 1, entry, stop, target, MAX_HOLD_15M);
    if (out.result !== 'EXPIRED')
      trades.push({ dir, entry, stop, target, ...out, date: today });
  }
  return trades;
}

function formatReport(results) {
  const m5  = b => b * 5;
  const m15 = b => b * 15;
  const pct = n => String(n + '%').padEnd(5);

  const rowAB = (label, s2, s3) => s2.count
    ? `${label} (${s2.count} trades)\n` +
      `  2R: ${pct(s2.winRate)}  ~${m5(s2.avgWinBars)}min to target\n` +
      `  3R: ${pct(s3.winRate)}  ~${m5(s3.avgWinBars)}min to target`
    : `${label}: no setups found`;

  const rowC = (s2, s3) => {
    if (!s2.count) return `Setup C — SBS: no setups found`;
    const lines = [
      `Setup C — SBS (${s2.count} trades)`,
      `  2R: ${pct(s2.winRate)}  ~${m5(s2.avgWinBars)}min to target`,
      `  3R: ${pct(s3.winRate)}  ~${m5(s3.avgWinBars)}min to target`,
    ];
    if (s2.m1.count) lines.push(`  M1 (shallow): ${s2.m1.count} trades | ${s2.m1.winRate}% win`);
    if (s2.m2.count) lines.push(`  M2 (deep):    ${s2.m2.count} trades | ${s2.m2.winRate}% win`);
    return lines.join('\n');
  };

  const rowD = (s2, s3) => s2.count
    ? `Setup D — TTrades CISD (${s2.count} trades)\n` +
      `  2R: ${pct(s2.winRate)}  ~${m15(s2.avgWinBars)}min to target\n` +
      `  3R: ${pct(s3.winRate)}  ~${m15(s3.avgWinBars)}min to target`
    : `Setup D — TTrades CISD: no setups found`;

  const sections = results.map(({ key, setupA, setupB, setupC, setupD }) => [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `${key} — 60-Day Backtest`,
    ``,
    rowAB(`Setup A — B&R`, setupA['2R'], setupA['3R']),
    ``,
    rowAB(`Setup B — SFP`, setupB['2R'], setupB['3R']),
    ``,
    rowC(setupC['2R'], setupC['3R']),
    ``,
    rowD(setupD['2R'], setupD['3R']),
  ].join('\n'));

  return [
    `📊 STOIC EDGE — FULL BACKTEST`,
    `A+B: StoicTA PDH/PDL  |  C: SBS fractal (5M)  |  D: TTrades CISD (15M)`,
    `60-day  |  NY session only  |  Structural stops`,
    ``,
    ...sections,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Mechanical approximation only — real execution will vary.`,
  ].join('\n');
}

async function analyzeTicker(key) {
  const sym = SYMBOLS[key];
  const [bars5m, barsDaily, bars1H, bars15m] = await Promise.all([
    fetchOHLCV(sym, '5m',  '60d'),
    fetchOHLCV(sym, '1d',  '6mo'),
    fetchOHLCV(sym, '1h',  '60d'),
    fetchOHLCV(sym, '15m', '60d'),
  ]);

  const levels   = buildDailyLevels(barsDaily);
  const bars4H   = aggregateTo4H(bars1H);
  const biases4H = build4HBiases(bars4H);

  const tradesC2R = runSetupC(bars5m, 2);
  const tradesC3R = runSetupC(bars5m, 3);
  const mkC = trades => ({
    ...stats(trades),
    m1: stats(trades.filter(t => t.model === 'M1')),
    m2: stats(trades.filter(t => t.model === 'M2')),
  });

  return {
    key,
    setupA: { '2R': stats(runSetupA(bars5m, levels, 2)), '3R': stats(runSetupA(bars5m, levels, 3)) },
    setupB: { '2R': stats(runSetupB(bars5m, levels, 2)), '3R': stats(runSetupB(bars5m, levels, 3)) },
    setupC: { '2R': mkC(tradesC2R), '3R': mkC(tradesC3R) },
    setupD: {
      '2R': stats(runSetupD(bars15m, biases4H, levels, 2)),
      '3R': stats(runSetupD(bars15m, biases4H, levels, 3)),
    },
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
        setupA: { '2R': empty, '3R': empty },
        setupB: { '2R': empty, '3R': empty },
        setupC: { '2R': emptyC, '3R': emptyC },
        setupD: { '2R': empty, '3R': empty },
      };
    }
  }));

  const cache = { updated: new Date().toISOString(), period: '60d' };
  for (const r of results)
    cache[r.key] = { setupA: r.setupA, setupB: r.setupB, setupC: r.setupC, setupD: r.setupD };
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
