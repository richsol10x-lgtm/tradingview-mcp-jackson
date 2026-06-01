#!/usr/bin/env node
// scripts/brief.js — node scripts/brief.js [TICKER]
// Multi-timeframe brief: Daily → 4H → 1H → 5M
// Computes SMA 20 + 200 on each TF, applies StoicTA bias rules, gives one advisory.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const env = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

const SYMBOLS = {
  MNQ: { yahoo: 'MNQ=F', label: 'MNQ (Micro Nasdaq)' },
  MES: { yahoo: 'MES=F', label: 'MES (Micro S&P 500)' },
  MGC: { yahoo: 'MGC=F', label: 'MGC (Micro Gold)' },
  SIL: { yahoo: 'SIL=F', label: 'SIL (Micro Silver)' },
};

// Load Stoic Edge levels cache (written by Claude Code when TradingView is open)
let LEVELS = {};
try {
  LEVELS = JSON.parse(readFileSync(join(__dirname, 'levels.json'), 'utf8'));
} catch {}

// Timeframes to analyse — order matters (top-down)
const TIMEFRAMES = [
  { label: 'Daily', interval: '1d',  range: '2y',  resample: null },
  { label: '4H',    interval: '60m', range: '90d', resample: 4    },  // resample 1H → 4H
  { label: '1H',    interval: '60m', range: '30d', resample: null },
  { label: '5M',    interval: '5m',  range: '30d', resample: null },
];

function sma(closes, length) {
  if (closes.length < length) return null;
  const slice = closes.slice(-length);
  return slice.reduce((a, b) => a + b, 0) / length;
}

// Group consecutive bars into N-bar candles, return array of last closes
function resample(closes, n) {
  const out = [];
  for (let i = n - 1; i < closes.length; i += n) out.push(closes[i]);
  return out;
}

function bias(price, sma20, sma200) {
  if (sma20 === null || sma200 === null)
    return { label: 'NO DATA', score: 0 };

  const spread = Math.abs(sma20 - sma200) / sma200;
  if (spread < 0.001)
    return { label: 'AT THE CROSS', score: 0 };

  const above20  = price > sma20;
  const above200 = price > sma200;
  const bull_ribbon = sma20 > sma200;

  if (bull_ribbon && above20 && above200)   return { label: '🟢 BULLISH',              score:  2 };
  if (!bull_ribbon && !above20 && !above200) return { label: '🔴 BEARISH',              score: -2 };
  if (bull_ribbon && !above20 && above200)  return { label: '🟡 PULLBACK (bull struct)', score:  1 };
  if (!bull_ribbon && above20 && !above200) return { label: '🟠 BOUNCE (bear struct)',  score: -1 };
  return { label: '⚪ NEUTRAL', score: 0 };
}

async function fetchCloses(yahooSymbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No data (${interval}/${range})`);
  return result.indicators.quote[0].close
    .filter(c => typeof c === 'number' && Number.isFinite(c) && c > 0);
}

async function analyzeTF(yahooSymbol, tf) {
  let closes = await fetchCloses(yahooSymbol, tf.interval, tf.range);
  if (tf.resample) closes = resample(closes, tf.resample);
  const price  = closes[closes.length - 1];
  const sma20  = sma(closes, 20);
  const sma200 = sma(closes, 200);
  const b      = bias(price, sma20, sma200);
  const fmt    = n => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
  return {
    label:  tf.label,
    bias:   b,
    price,
    sma20,
    sma200,
    line:   `${tf.label.padEnd(6)} SMA20: ${fmt(sma20).padStart(10)} | SMA200: ${fmt(sma200).padStart(10)} → ${b.label}`,
  };
}

function advisory(results, key) {
  const totalScore = results.reduce((s, r) => s + r.bias.score, 0);
  const daily = results[0];
  const tf4h  = results[1];
  const tf1h  = results[2];
  const tf5m  = results[3];
  const lvl   = LEVELS[key] || {};

  const dailyBull = daily.bias.score > 0;
  const dailyBear = daily.bias.score < 0;
  const lowerBull = [tf4h, tf1h, tf5m].filter(r => r.bias.score > 0).length;
  const lowerBear = [tf4h, tf1h, tf5m].filter(r => r.bias.score < 0).length;
  const fmt       = n => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';

  // Level context — where is price relative to PDH/PDL/PDC?
  const price = tf5m.price;
  let levelCtx = '';
  if (lvl.PDH && lvl.PDL && lvl.PDC) {
    if (price > lvl.PDH)
      levelCtx = ` Price is ABOVE PDH (${fmt(lvl.PDH)}) — trading in premium, watch for Setup A retest of PDH from above or SFP rejection.`;
    else if (price < lvl.PDL)
      levelCtx = ` Price is BELOW PDL (${fmt(lvl.PDL)}) — trading in discount, watch for Setup A retest of PDL from below or SFP reversal back above.`;
    else if (Math.abs(price - lvl.PDH) < Math.abs(price - lvl.PDL))
      levelCtx = ` Price is approaching PDH (${fmt(lvl.PDH)}) — key resistance. Watch for Setup A breakout above or Setup B SFP rejection.`;
    else
      levelCtx = ` Price is near PDC (${fmt(lvl.PDC)}) / PDL (${fmt(lvl.PDL)}) — key support zone. Watch for Setup B SFP long or break below.`;
  }

  if (totalScore >= 6)
    return `Full bull alignment. Longs only. Setup A: retest of 5M 20 SMA (${fmt(tf5m.sma20)}) or PDC (${fmt(lvl.PDC ?? '—')}) from above. Target 2.618 fib extension.${levelCtx}`;

  if (totalScore <= -6)
    return `Full bear alignment. Shorts only. Setup A: rejection at 5M 20 SMA (${fmt(tf5m.sma20)}) or PDC (${fmt(lvl.PDC ?? '—')}) from below. Target 2.618 fib extension.${levelCtx}`;

  if (dailyBull && lowerBear >= 2)
    return `Pullback within a daily uptrend. No longs until 4H and 1H recover. Watch for Setup B SFP long at PDL (${fmt(lvl.PDL ?? '—')}) or PDC (${fmt(lvl.PDC ?? '—')}). No shorts against the daily.${levelCtx}`;

  if (dailyBear && lowerBull >= 2)
    return `Bounce within a daily downtrend. Do not chase longs. Wait for the bounce to fail at PDC (${fmt(lvl.PDC ?? '—')}) or PDH (${fmt(lvl.PDH ?? '—')}), then look for Setup A short.${levelCtx}`;

  if (dailyBull && lowerBull >= 2)
    return `Daily + lower TFs bullish. Longs are the play. Setup A retest of 5M 20 SMA (${fmt(tf5m.sma20)}) or PDC (${fmt(lvl.PDC ?? '—')}). Keep stops tight.${levelCtx}`;

  if (dailyBear && lowerBear >= 2)
    return `Daily + lower TFs bearish. Shorts are the play. Setup A rejection at 5M 20 SMA (${fmt(tf5m.sma20)}) or PDC (${fmt(lvl.PDC ?? '—')}). Keep stops tight.${levelCtx}`;

  return `Timeframes are mixed — no clear edge. Sit on hands. Wait for daily and 4H to agree.${levelCtx}`;
}

async function analyzeTicker(key) {
  const sym = SYMBOLS[key];
  try {
    const results = await Promise.all(TIMEFRAMES.map(tf => analyzeTF(sym.yahoo, tf)));
    const adv  = advisory(results, key);
    const fmt  = n => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
    const lvl  = LEVELS[key];
    const lvlLines = lvl ? [
      ``,
      `Levels (Stoic Edge):`,
      `PDH: ${fmt(lvl.PDH)}  PDC: ${fmt(lvl.PDC)}  PDL: ${fmt(lvl.PDL)}`,
      `PWH: ${fmt(lvl.PWH)}  PWL: ${fmt(lvl.PWL)}`,
      `HCOM: ${fmt(lvl.HCOM)}  LCOM: ${fmt(lvl.LCOM)}`,
    ] : [];

    return [
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `${sym.label} — ${fmt(results[3].price)}`,
      ``,
      ...results.map(r => r.line),
      ...lvlLines,
      ``,
      `Advisory: ${adv}`,
    ].join('\n');
  } catch (e) {
    return `━━━━━━━━━━━━━━━━━━━━━━\n${sym.label} — ERROR: ${e.message}`;
  }
}

async function main() {
  const arg  = process.argv[2]?.toUpperCase();
  const keys = arg && SYMBOLS[arg] ? [arg] : Object.keys(SYMBOLS);

  const now = new Date().toLocaleString('en-GB', {
    timeZone: 'America/New_York', weekday: 'short', day: 'numeric',
    month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const sections = await Promise.all(keys.map(analyzeTicker));

  const msg = [
    `📊 STOIC TA — ${arg ?? 'SESSION BRIEF'}`,
    `${now} ET`,
    ``,
    ...sections,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `⚠️  Max 3 trades. Hard stop before entry. 2:1 R:R minimum.`,
  ].join('\n');

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }),
    });
    const ok = (await r.json()).ok;
    console.log(ok ? 'telegram: sent' : 'telegram: FAILED');
  } else {
    console.log(msg);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
