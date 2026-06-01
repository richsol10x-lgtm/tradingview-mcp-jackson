#!/usr/bin/env node
// scripts/brief.js — node scripts/brief.js [TICKER]
// Multi-timeframe brief: Daily → 4H → 1H → 5M
// Computes SMA 20 + 200 on each TF, applies StoicTA bias rules, gives one advisory.

import Anthropic from '@anthropic-ai/sdk';
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
try { LEVELS = JSON.parse(readFileSync(join(__dirname, 'levels.json'), 'utf8')); } catch {}

// Load backtest stats cache (written by backtest.js)
let BTSTATS = {};
try { BTSTATS = JSON.parse(readFileSync(join(__dirname, 'backtest-cache.json'), 'utf8')); } catch {}

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

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const ADVISORY_SYSTEM = `You are a StoicTA trading advisor for a micro futures day trader. StoicTA uses Fibonacci geometry, SBS (Structure Break + Sweep), and Daily Levels (PDH/PDL/PDC, HCOM/LCOM, PWH/PWL).

Setup A: price breaks a key level, pulls back to retest it from the other side, enter on the 5M 20 SMA confluence. Target 2.618 fib extension.
Setup B: price sweeps a key level (SFP wick), fails to close through it, reverses. Enter on the SFP candle close.

Write 2-3 sentences of specific, actionable advisory. Rules:
- Reference actual price numbers from the data
- Name the specific setup (A or B), the specific level to watch, and why
- If there is a news event within 60 minutes, warn to sit out or reduce size
- If timeframes conflict badly, say so directly and tell them to wait
- Never write vague statements like "watch for opportunities" or "the market is mixed"
- Be direct. No fluff.`;

async function advisory(results, key, newsEvents = []) {
  const fmt   = n => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
  const daily = results[0];
  const tf4h  = results[1];
  const tf1h  = results[2];
  const tf5m  = results[3];
  const lvl   = LEVELS[key] || {};
  const bt    = BTSTATS[key] || {};
  const price = tf5m.price;

  const now = new Date();
  const etTime = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const session = etHour < 9 ? 'pre-market' : etHour < 12 ? 'NY morning' : etHour < 16 ? 'NY afternoon' : 'after-hours';

  const newsStr = newsEvents.length
    ? newsEvents.map(e => `  ${e.time} ET — ${e.title}${e.forecast ? ` (Forecast: ${e.forecast})` : ''}`).join('\n')
    : '  None today';

  const prompt = `Ticker: ${key} | Price: ${fmt(price)} | Session: ${etTime} ET (${session})

Timeframe bias:
  Daily: ${daily.bias.label} (SMA20: ${fmt(daily.sma20)}, SMA200: ${fmt(daily.sma200)})
  4H:    ${tf4h.bias.label}  (SMA20: ${fmt(tf4h.sma20)}, SMA200: ${fmt(tf4h.sma200)})
  1H:    ${tf1h.bias.label}  (SMA20: ${fmt(tf1h.sma20)}, SMA200: ${fmt(tf1h.sma200)})
  5M:    ${tf5m.bias.label}  (SMA20: ${fmt(tf5m.sma20)}, SMA200: ${fmt(tf5m.sma200)})

Stoic Edge levels:
  PDH: ${fmt(lvl.PDH)}  PDC: ${fmt(lvl.PDC)}  PDL: ${fmt(lvl.PDL)}
  HCOM: ${fmt(lvl.HCOM)}  LCOM: ${fmt(lvl.LCOM)}
  PWH: ${fmt(lvl.PWH)}  PWL: ${fmt(lvl.PWL)}

Backtest (60d): Setup A ${bt.setupA?.winRate ?? '?'}% win rate | Setup B ${bt.setupB?.winRate ?? '?'}% win rate

High-impact news today:
${newsStr}

Write the advisory now.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: ADVISORY_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].text.trim();
  } catch {
    // Fallback to score-based canned text if API fails
    const totalScore = results.reduce((s, r) => s + r.bias.score, 0);
    if (totalScore >= 4)  return `Full bull alignment. Setup A: retest of 5M 20 SMA (${fmt(tf5m.sma20)}) or PDC (${fmt(lvl.PDC)}) from above.`;
    if (totalScore <= -4) return `Full bear alignment. Setup A: rejection at 5M 20 SMA (${fmt(tf5m.sma20)}) or PDC (${fmt(lvl.PDC)}) from below.`;
    return `Timeframes mixed — no clear edge. Wait for daily and 4H to agree.`;
  }
}

async function analyzeTicker(key, newsEvents = []) {
  const sym = SYMBOLS[key];
  try {
    const results = await Promise.all(TIMEFRAMES.map(tf => analyzeTF(sym.yahoo, tf)));
    const adv  = await advisory(results, key, newsEvents);
    const fmt  = n => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
    const lvl  = LEVELS[key];
    const lvlLines = lvl ? [
      ``,
      `Levels (Stoic Edge):`,
      `PDH: ${fmt(lvl.PDH)}  PDC: ${fmt(lvl.PDC)}  PDL: ${fmt(lvl.PDL)}`,
      `PWH: ${fmt(lvl.PWH)}  PWL: ${fmt(lvl.PWL)}`,
      `HCOM: ${fmt(lvl.HCOM)}  LCOM: ${fmt(lvl.LCOM)}`,
    ] : [];

    const bt  = BTSTATS[key];
    const btLines = bt?.setupA?.count ? (() => {
      const sA = bt.setupA;
      const sB = bt.setupB;
      const aLine = sA.count
        ? `A: ${sA.winRate}% (${sA.count} trades) ~${sA.avgWinBars*5}min to target`
        : `A: no data`;
      const bLine = sB.count
        ? `B: ${sB.winRate}% (${sB.count} trades) ~${sB.avgWinBars*5}min to target`
        : `B: no data`;
      return [``, `Stats (60d backtest):`, aLine, bLine];
    })() : [];

    return [
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `${sym.label} — ${fmt(results[3].price)}`,
      ``,
      ...results.map(r => r.line),
      ...lvlLines,
      ...btLines,
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

  // Fetch today's news once, pass to all tickers
  let newsEvents = [];
  try {
    const newsRes = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const allEvents = await newsRes.json();
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    newsEvents = allEvents
      .filter(e => e.impact === 'High' && ['USD', 'XAU', 'XAG'].includes(e.country))
      .filter(e => new Date(e.date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayET)
      .map(e => ({
        time: new Date(e.date).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }),
        title: e.title,
        forecast: e.forecast || null,
      }));
  } catch { /* ForexFactory down — continue without news */ }

  const sections = await Promise.all(keys.map(k => analyzeTicker(k, newsEvents)));

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
