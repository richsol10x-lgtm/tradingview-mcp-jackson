#!/usr/bin/env node
// scripts/backtest.js — Backtests Setup A (Break & Retest) + Setup B (SFP)
// against historical PDH/PDL/PDC levels for all four tickers.
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

const STOP_PCT    = 0.0025;  // 0.25% stop below/above the level
const MAX_RETEST  = 24;      // bars to wait for retest after break
const MAX_HOLD    = 100;     // bars to check for target/stop after entry
const MIN_WICK    = 0.0015;  // SFP wick must extend at least 0.15% beyond the level
const MIN_BREAK   = 0.001;   // break bar must close at least 0.1% beyond level (conviction)

async function fetchOHLCV(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  const r    = json?.chart?.result?.[0];
  if (!r) throw new Error(`No data for ${symbol} (${interval}/${range})`);
  const ts     = r.timestamp;
  const q      = r.indicators.quote[0];
  const bars   = [];
  for (let i = 0; i < ts.length; i++) {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null || !isFinite(v))) continue;
    bars.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return bars;
}

// Build a map of date string → { PDH, PDL, PDC } using previous day's daily bar
function buildDailyLevels(dailyBars) {
  const map = {};
  for (let i = 1; i < dailyBars.length; i++) {
    const prev = dailyBars[i - 1];
    const curr = dailyBars[i];
    const dateStr = new Date(curr.t * 1000).toISOString().slice(0, 10);
    map[dateStr] = { PDH: prev.h, PDL: prev.l, PDC: prev.c };
  }
  return map;
}

function dateStr(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function stats(trades) {
  if (!trades.length) return { count: 0, winRate: 0, avgWinBars: 0, avgLossBars: 0 };
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

function checkOutcome(bars, fromIdx, entryPrice, stopPrice, targetPrice) {
  for (let i = fromIdx; i < Math.min(fromIdx + MAX_HOLD, bars.length); i++) {
    const { h, l } = bars[i];
    const hitTarget = targetPrice > entryPrice ? h >= targetPrice : l <= targetPrice;
    const hitStop   = stopPrice < entryPrice   ? l <= stopPrice   : h >= stopPrice;
    if (hitTarget && hitStop) return { result: 'WIN', bars: i - fromIdx }; // target reached first (assume)
    if (hitTarget) return { result: 'WIN',  bars: i - fromIdx };
    if (hitStop)   return { result: 'LOSS', bars: i - fromIdx };
  }
  return { result: 'EXPIRED', bars: MAX_HOLD };
}

function runSetupA(bars, levels, rMultiplier = 2) {
  const trades   = [];
  const usedDays = new Set();

  for (let i = 1; i < bars.length - MAX_HOLD; i++) {
    const bar  = bars[i];
    const prev = bars[i - 1];
    const lvl  = levels[dateStr(bar.t)];
    if (!lvl) continue;

    const { PDH, PDL } = lvl;
    const dayKeyL = `${dateStr(bar.t)}-PDH-LONG`;
    const dayKeyS = `${dateStr(bar.t)}-PDL-SHORT`;

    if (!usedDays.has(dayKeyL) && prev.c <= PDH && bar.c > PDH * (1 + MIN_BREAK)) {
      usedDays.add(dayKeyL);
      for (let j = i + 1; j < Math.min(i + MAX_RETEST, bars.length); j++) {
        if (bars[j].l <= PDH * 1.001 && bars[j].l >= PDH * 0.999) {
          const entry  = PDH;
          const stop   = PDH * (1 - STOP_PCT);
          const target = PDH + rMultiplier * (PDH - stop);
          const out    = checkOutcome(bars, j + 1, entry, stop, target);
          if (out.result !== 'EXPIRED')
            trades.push({ dir: 'LONG', level: 'PDH', entry, stop, target, ...out, date: dateStr(bar.t) });
          break;
        }
      }
    }

    if (!usedDays.has(dayKeyS) && prev.c >= PDL && bar.c < PDL * (1 - MIN_BREAK)) {
      usedDays.add(dayKeyS);
      for (let j = i + 1; j < Math.min(i + MAX_RETEST, bars.length); j++) {
        if (bars[j].h >= PDL * 0.999 && bars[j].h <= PDL * 1.001) {
          const entry  = PDL;
          const stop   = PDL * (1 + STOP_PCT);
          const target = PDL - rMultiplier * (stop - PDL);
          const out    = checkOutcome(bars, j + 1, entry, stop, target);
          if (out.result !== 'EXPIRED')
            trades.push({ dir: 'SHORT', level: 'PDL', entry, stop, target, ...out, date: dateStr(bar.t) });
          break;
        }
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
    if (!lvl) continue;

    const { PDH, PDL } = lvl;
    const dayKeyL = `${dateStr(bar.t)}-PDL-SFP`;
    const dayKeyS = `${dateStr(bar.t)}-PDH-SFP`;

    if (!usedDays.has(dayKeyL) && bar.l < PDL * (1 - MIN_WICK) && bar.c > PDL) {
      usedDays.add(dayKeyL);
      const entry  = bar.c;
      const stop   = bar.l;
      const rDist  = entry - stop;
      if (rDist > 0) {
        const target = entry + rMultiplier * rDist;
        const out    = checkOutcome(bars, i + 1, entry, stop, target);
        if (out.result !== 'EXPIRED')
          trades.push({ dir: 'LONG', level: 'PDL-SFP', entry, stop, target, ...out, date: dateStr(bar.t) });
      }
    }

    if (!usedDays.has(dayKeyS) && bar.h > PDH * (1 + MIN_WICK) && bar.c < PDH) {
      usedDays.add(dayKeyS);
      const entry  = bar.c;
      const stop   = bar.h;
      const rDist  = stop - entry;
      if (rDist > 0) {
        const target = entry - rMultiplier * rDist;
        const out    = checkOutcome(bars, i + 1, entry, stop, target);
        if (out.result !== 'EXPIRED')
          trades.push({ dir: 'SHORT', level: 'PDH-SFP', entry, stop, target, ...out, date: dateStr(bar.t) });
      }
    }
  }
  return trades;
}

function fmt(n) { return n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—'; }

function report(ticker, setupA, setupB) {
  const sA = stats(setupA);
  const sB = stats(setupB);
  const avgMins = bars => bars * 5;

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `${ticker} — 60-Day Backtest (5M bars)`,
    ``,
    `Setup A — Break & Retest (PDH/PDL)`,
    sA.count
      ? `  Trades: ${sA.count}  |  Win rate: ${sA.winRate}%  (${sA.wins}W / ${sA.losses}L)`
      + `\n  Avg time to win: ~${avgMins(sA.avgWinBars)} min`
      + `\n  Avg time to stop: ~${avgMins(sA.avgLossBars)} min`
      : `  No setups found in this period`,
    ``,
    `Setup B — SFP (PDH/PDL wick reversal)`,
    sB.count
      ? `  Trades: ${sB.count}  |  Win rate: ${sB.winRate}%  (${sB.wins}W / ${sB.losses}L)`
      + `\n  Avg time to win: ~${avgMins(sB.avgWinBars)} min`
      + `\n  Avg time to stop: ~${avgMins(sB.avgLossBars)} min`
      : `  No setups found in this period`,
  ];

  return lines.join('\n');
}

async function analyzeTicker(key) {
  const sym = SYMBOLS[key];
  const [bars5m, barsDaily] = await Promise.all([
    fetchOHLCV(sym, '5m', '60d'),
    fetchOHLCV(sym, '1d', '6mo'),
  ]);
  const levels = buildDailyLevels(barsDaily);
  return {
    key,
    setupA: { '2R': stats(runSetupA(bars5m, levels, 2)), '3R': stats(runSetupA(bars5m, levels, 3)) },
    setupB: { '2R': stats(runSetupB(bars5m, levels, 2)), '3R': stats(runSetupB(bars5m, levels, 3)) },
  };
}

function formatReport(results) {
  const m = b => b * 5;
  const row = (label, s2, s3) => s2.count
    ? `${label} (${s2.count} trades)\n` +
      `  2R: ${String(s2.winRate + '%').padEnd(5)}  ~${m(s2.avgWinBars)}min to target\n` +
      `  3R: ${String(s3.winRate + '%').padEnd(5)}  ~${m(s3.avgWinBars)}min to target ← your target`
    : `${label}: no setups found`;

  const sections = results.map(({ key, setupA, setupB }) => [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `${key} — 60-Day Backtest (StoicTA near PDH/PDL)`,
    ``,
    row(`Setup A — B&R`, setupA['2R'], setupA['3R']),
    ``,
    row(`Setup B — SFP`, setupB['2R'], setupB['3R']),
  ].join('\n'));

  return [
    `📊 STOIC TA — BACKTEST RESULTS`,
    `StoicTA Setups A+B  |  60-day  |  5M  |  2R vs 3R`,
    `TTrades fractal entries: use 2R column for comparison`,
    ``,
    ...sections,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Mechanical approximation only — real execution will vary.`,
  ].join('\n');
}

async function main() {
  const arg  = process.argv[2]?.toUpperCase();
  const keys = arg && SYMBOLS[arg] ? [arg] : Object.keys(SYMBOLS);

  console.log(`Running backtest for: ${keys.join(', ')} — please wait...`);

  const results = await Promise.all(keys.map(async key => {
    try {
      return await analyzeTicker(key);
    } catch (e) {
      return { key, error: e.message, setupA: { count: 0 }, setupB: { count: 0 } };
    }
  }));

  // Save cache for brief.js to read
  const cache = { updated: new Date().toISOString(), period: '60d' };
  for (const r of results) cache[r.key] = { setupA: r.setupA, setupB: r.setupB };
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
