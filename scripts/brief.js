#!/usr/bin/env node
// scripts/brief.js — node scripts/brief.js [TICKER]
// TICKER = MNQ | MES | MGC | SIL (or omit for all four)
// Fetches 5-min OHLCV from Yahoo Finance, computes SMA 20 + 200, applies rules.json bias.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const env = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

const SYMBOLS = {
  MNQ: { yahoo: 'MNQ=F', label: 'MNQ (Micro Nasdaq)' },
  MES: { yahoo: 'MES=F', label: 'MES (Micro S&P 500)' },
  MGC: { yahoo: 'MGC=F', label: 'MGC (Micro Gold)' },
  SIL: { yahoo: 'SIL=F', label: 'SIL (Micro Silver)' },
};

function sma(closes, length) {
  if (closes.length < length) return null;
  const slice = closes.slice(-length);
  return slice.reduce((a, b) => a + b, 0) / length;
}

function bias(price, sma20, sma200) {
  if (sma20 === null || sma200 === null) return { label: 'INSUFFICIENT DATA', reason: 'Not enough bars for SMA 200' };

  const spread = Math.abs(sma20 - sma200) / sma200;
  if (spread < 0.001)
    return { label: 'AT THE CROSS', reason: `20 SMA (${sma20.toFixed(2)}) and 200 SMA (${sma200.toFixed(2)}) are within 0.1% — direction is unreliable. Wait for a clear separation before trading.` };

  const above20 = price > sma20;
  const above200 = price > sma200;
  const ribbon_bull = sma20 > sma200;

  if (ribbon_bull && above20 && above200)
    return { label: 'BULLISH', reason: '20 above 200, price above both — clean bull alignment' };
  if (!ribbon_bull && !above20 && !above200)
    return { label: 'BEARISH', reason: '20 below 200, price below both — clean bear alignment' };
  if (ribbon_bull && !above20 && above200)
    return { label: 'NEUTRAL → lean BULLISH', reason: '20 above 200 (structure bullish) but price pulled under the 20 — wait for reclaim' };
  if (!ribbon_bull && above20 && !above200)
    return { label: 'NEUTRAL → lean BEARISH', reason: '20 below 200 (structure bearish) but price bounced above the 20 — wait for rejection or break' };
  return { label: 'NEUTRAL', reason: 'Price between the two MAs — no edge, wait for clarity' };
}

function strategy(b, price, sma20, sma200) {
  const fmt = (n) => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
  if (b.label.startsWith('BULLISH'))
    return `Longs only. Setup A: retest of ${fmt(sma20)} (20 SMA) from above after a break. Setup B SFP: wick below a level that closes back above. Target 2.618 fib extension.`;
  if (b.label.startsWith('BEARISH'))
    return `Shorts only. Setup A: retest of ${fmt(sma20)} (20 SMA) from below after a break. Setup B SFP: wick above a level that closes back below. Target 2.618 fib extension.`;
  if (b.label.includes('lean BULLISH'))
    return `Wait. Need price to reclaim ${fmt(sma20)} (20 SMA) and hold. Only then consider long setups. Do not short into the 200 SMA at ${fmt(sma200)}.`;
  if (b.label.includes('lean BEARISH'))
    return `Wait. Need price to reject the 20 SMA (${fmt(sma20)}) and break below. Only then consider short setups. No longs until above both MAs.`;
  return `No trade. Price is between the 20 SMA (${fmt(sma20)}) and 200 SMA (${fmt(sma200)}). Wait for a decisive break of one level.`;
}

async function fetchBars(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=5m&range=30d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${yahooSymbol}`);
  const closes = result.indicators.quote[0].close
    .filter(c => typeof c === 'number' && Number.isFinite(c) && c > 0);
  if (closes.length === 0) throw new Error(`No valid close prices for ${yahooSymbol}`);
  const price = closes[closes.length - 1];
  return { closes, price };
}

async function analyzeTicker(key) {
  const sym = SYMBOLS[key];
  try {
    const { closes, price } = await fetchBars(sym.yahoo);
    const sma20  = sma(closes, 20);
    const sma200 = sma(closes, 200);
    const b = bias(price, sma20, sma200);
    const strat = strategy(b, price, sma20, sma200);
    const fmt = (n) => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
    const watch = sma20 ? fmt(sma20) : '—';
    return [
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `${sym.label} — ${fmt(price)}`,
      `SMA 20: ${fmt(sma20)} | SMA 200: ${fmt(sma200)}`,
      `Bias: ${b.label}`,
      `Why: ${b.reason}`,
      `Strategy: ${strat}`,
      `Watch: ${watch}`,
    ].join('\n');
  } catch (e) {
    return `━━━━━━━━━━━━━━━━━━━━━━\n${sym.label} — ERROR: ${e.message}`;
  }
}

async function main() {
  const arg = process.argv[2]?.toUpperCase();
  const keys = arg && SYMBOLS[arg] ? [arg] : Object.keys(SYMBOLS);

  const now = new Date().toLocaleString('en-GB', {
    timeZone: 'America/New_York', weekday: 'short', day: 'numeric',
    month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const sections = await Promise.all(keys.map(analyzeTicker));

  const msg = [
    `📊 STOIC TA — ${arg ?? 'SESSION BRIEF'}`,
    `${now} ET | 5-Min Charts`,
    '',
    ...sections,
    '',
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `⚠️  Max 3 trades. Hard stop before entry. 2:1 R:R minimum.`,
  ].join('\n');

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg })
    });
    const ok = (await r.json()).ok;
    console.log(ok ? 'telegram: sent' : 'telegram: FAILED');
  } else {
    console.log(msg);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
