#!/usr/bin/env node
// scripts/brief.js — node scripts/brief.js [TICKER]
// Multi-timeframe brief: Daily → 4H → 1H → 5M
// Computes SMA 20 + 200 on each TF, applies StoicTA bias rules, gives one advisory.

import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

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

// Load trade log for adjustment flags
let TRADELOG = { trades: [] };
try { TRADELOG = JSON.parse(readFileSync(join(__dirname, 'trade-log.json'), 'utf8')); } catch {}

// Load Fractal Model cache (written during Load up strat sessions)
let FRACTAL = {};
try { FRACTAL = JSON.parse(readFileSync(join(__dirname, 'fractal-cache.json'), 'utf8')); } catch {}

// Timeframes — top-down. 15M for TTrades fractal alignment, 5M is primary entry.
const TIMEFRAMES = [
  { label: 'Daily', interval: '1d',  range: '2y',  resample: null },
  { label: '4H',    interval: '60m', range: '90d', resample: 4    },
  { label: '1H',    interval: '60m', range: '30d', resample: null },
  { label: '15M',   interval: '15m', range: '30d', resample: null },
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

function formatFractalContext(key, price) {
  const fc = FRACTAL[key];
  const fmt = n => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
  if (!fc) return '  No fractal cache — refresh via Load up strat with TV open.';

  const ageH = FRACTAL.updated
    ? Math.round((Date.now() - new Date(FRACTAL.updated).getTime()) / 3600000)
    : null;
  const ageNote = ageH !== null && ageH > 4 ? ` (data ${ageH}h old)` : '';

  const lines = [`Bias: ${fc.bias}${ageNote} | ${fc.model} | SMT: ${fc.smt?.join(', ') ?? '—'}`];

  // Active fib sets — show targets still ahead of price
  for (const set of (fc.activeFibSets || []).slice(0, 2)) {
    const targets = ['-1', '-2', '-2.5', '-4', '-4.5']
      .map(k => set[k]).filter(v => v != null)
      .filter(v => set.direction === 'bearish' ? v < price : v > price);
    const label = `${set.direction.toUpperCase()} set (C2: ${fmt(set.c2)}, 0: ${fmt(set['0'])})`;
    lines.push(`  ${label} → targets: ${targets.length ? targets.slice(0, 3).map(fmt).join(', ') : 'all hit / N/A'}`);
  }

  // 4 nearest imbalance zones (2 above, 2 below)
  const zones = fc.imbalanceZones || [];
  const above = zones.filter(z => z.low >= price).sort((a, b) => a.low - b.low).slice(0, 2);
  const below = zones.filter(z => z.high <= price).sort((a, b) => b.high - a.high).slice(0, 2);
  const allZones = [...below.reverse(), ...above]
    .map(z => `${fmt(z.low)}-${fmt(z.high)}`);
  if (allZones.length) lines.push(`  Imbalance zones near price: ${allZones.join(' | ')}`);

  return lines.join('\n');
}

const ADVISORY_SYSTEM = `You are a trading partner for a micro futures day trader. Three frameworks govern all trades.

MACRO (always running): 20/200 SMA — above both = bullish only, below both = bearish only, between = caution/reduce. Move origin = last move down before price went higher (bull) or last move up before lower (bear) = highest probability reversal zone. Entry against 200 SMA = flag immediately.

STOICTA SETUPS (near PDH/PDL/PDC only):
- SFP: price sweeps level + close fails back inside (wick beyond + close on original side). Enter direction of failure. Stop beyond sweep wick. Reversal.
- B&R: price CLOSES beyond level (not just wick) → wait for retest → level holds → enter. Stop beyond retest swing. Continuation.
- SBS (away from levels, trending): 5-move sequence — 1=breakout, 2=first pullback, 3=new high, 4=liquidation, 5=reversal (ONLY entry). TWO MODELS: Model 1 = move 4 shallow retest at range top (resistance becomes support). Model 2 = move 4 sweeps deep into move origin (A+ setup). Models can combine: Model 1 fails → Model 2 forms. Move 4 reaches move origin = A+ setup. Move 4 stops well above = lower quality, flag and size down.
- FIB GEOMETRY (execution for all entries): first pullback must be ≥50%. Then wait for 100% trend-based fib extension. Enter limit at 50% of second pullback. Targets: 2.618=default, 4.23=runner, 6.86=home run.

TTRADES FRACTAL (away from levels, re-entries):
- Daily C2: sweeps prev candle H/L + closes back inside = bias signal. C3: engulfs C2 + closes through body = stronger signal.
- 4H: same C2/C3 logic required. No 4H confirmation = no trade.
- 15M: protected swing forms (close through candle series after sweep). Continuation entry preferred. Stop beyond protected swing.
- CISD required at every level: fast V-shape, decisive close through candle series in 1–3 candles. Slow grind = invalid.

STOPS: always structural. Never BE at 1:1. Trail below rejection zone at 1.5R. Never move stop further away.
TARGETS: 2.618 fib default. Structural = untouched swing highs/lows. 2.618 aligning with structural level = highest confidence.
QUALITY FILTER: macro aligned? significant level? real continuation not consolidation? sweep in progress (wait one candle)? HTF target already met? first pullback ≥50%? 100% extension hit?

Answer in these sections. SHORT. Plain text only, no markdown. What the rules say, not predictions.

MACRO:
20/200 SMA bias (bullish/bearish/caution)? Price between SMAs = note it. Move origin on daily — unmitigated?

LEVELS:
Near PDH/PDL/PDC? Which? SFP or B&R forming? Probability 0–100% based on setup clarity + backtest EV.

SBS:
What move are we on (1–5)? Move 5 confirmed = flag as active setup. If on move 4: did it reach the move origin (A+ setup) or stop above it (lower quality — flag and note size down)? No sequence = say so.

FIB STATUS:
First pullback happened and ≥50%? 100% extension hit? Second pullback forming? Where is 50% entry level and 2.618 target?

TTRADES:
Daily C2/C3 present? 4H confirmed? 15M protected swing visible? Probability 0–100% based on TF alignment quality.

BIAS:
One sentence. Bullish/bearish/neutral + one rule-based reason.

FLAGS:
Call out: entry before 100% extension, SBS before move 5, against 200 SMA, first pullback <50%, anything invalidating the setup.`;

async function advisory(results, key, newsEvents = []) {
  const fmt    = n => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
  const daily  = results[0];
  const tf4h   = results[1];
  const tf1h   = results[2];
  const tf15m  = results[3];
  const tf5m   = results[4];
  const lvl    = LEVELS[key] || {};
  const bt     = BTSTATS[key] || {};
  const price  = tf5m.price;

  const now = new Date();
  const etTime = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const session = etHour < 9 ? 'pre-market' : etHour < 12 ? 'NY morning' : etHour < 16 ? 'NY afternoon' : 'after-hours';

  // Near-level detection (within 0.3%)
  const nearLevels = Object.entries(lvl)
    .filter(([, val]) => val && Math.abs(price - val) / val < 0.003)
    .map(([name, val]) => `${name} (${fmt(val)})`);

  // Adjustment flags from trade log
  const recent10 = TRADELOG.trades.slice(-10);
  const beCount = recent10.filter(t => t.beAt1r1).length;
  const flagStr = beCount > 0
    ? `\nADJUSTMENT FLAG: BE at 1:1 used in ${beCount} of last 10 trades — remind to use rejection zone trailing.`
    : '';

  const newsStr = newsEvents.length
    ? newsEvents.map(e => `  ${e.time} ET — ${e.title}${e.forecast ? ` (Forecast: ${e.forecast})` : ''}`).join('\n')
    : '  None today';

  const fractalCtx = formatFractalContext(key, price);

  const ev = (wr, r) => wr != null ? ((wr / 100 * r) - (1 - wr / 100)).toFixed(2) : '?';
  const sA2 = bt.setupA?.['2R'], sA3 = bt.setupA?.['3R'];
  const sB2 = bt.setupB?.['2R'], sB3 = bt.setupB?.['3R'];
  const sC2 = bt.setupC?.['2R'], sC3 = bt.setupC?.['3R'];
  const sD2 = bt.setupD?.['2R'], sD3 = bt.setupD?.['3R'];
  const btRows = [];
  if (sA3) btRows.push(`B&R: 2R=${sA2.winRate}% (EV ${ev(sA2.winRate,2)}R) | 3R=${sA3.winRate}% (EV ${ev(sA3.winRate,3)}R) — ${sA3.count} trades`);
  if (sB3) btRows.push(`SFP: 2R=${sB2.winRate}% (EV ${ev(sB2.winRate,2)}R) | 3R=${sB3.winRate}% (EV ${ev(sB3.winRate,3)}R) — ${sB3.count} trades`);
  if (sC3) btRows.push(`SBS: 2R=${sC2.winRate}% | 3R=${sC3.winRate}% — ${sC3.count} trades (M1:${sC3.m1?.winRate??'?'}% M2:${sC3.m2?.winRate??'?'}%)`);
  if (sD3) btRows.push(`CISD: 2R=${sD2.winRate}% | 3R=${sD3.winRate}% — ${sD3.count} trades`);
  const btStr = btRows.length ? btRows.join('\n') : 'No backtest data';

  const prompt = `Ticker: ${key} | Price: ${fmt(price)} | Session: ${etTime} ET (${session})
Near daily levels: ${nearLevels.length ? nearLevels.join(', ') : 'NONE'}

Fractal Model indicator (TTrades — authoritative for Setup 3/4):
${fractalCtx}

Timeframe bias (SMA-based context):
  Daily: ${daily.bias.label} (SMA20: ${fmt(daily.sma20)}, SMA200: ${fmt(daily.sma200)})
  4H:    ${tf4h.bias.label}  (SMA20: ${fmt(tf4h.sma20)}, SMA200: ${fmt(tf4h.sma200)})
  1H:    ${tf1h.bias.label}  (SMA20: ${fmt(tf1h.sma20)}, SMA200: ${fmt(tf1h.sma200)})
  15M:   ${tf15m.bias.label} (SMA20: ${fmt(tf15m.sma20)}, SMA200: ${fmt(tf15m.sma200)}) ← TTrades fractal layer
  5M:    ${tf5m.bias.label}  (SMA20: ${fmt(tf5m.sma20)}, SMA200: ${fmt(tf5m.sma200)}) ← primary entry

All daily levels:
  PDH: ${fmt(lvl.PDH)}  PDC: ${fmt(lvl.PDC)}  PDL: ${fmt(lvl.PDL)}
  HCOM: ${fmt(lvl.HCOM)}  LCOM: ${fmt(lvl.LCOM)}
  PWH: ${fmt(lvl.PWH)}  PWL: ${fmt(lvl.PWL)}

Backtest (60d, StoicTA):
${btStr}

High-impact news today:
${newsStr}${flagStr}

Give the brief now.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: ADVISORY_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].text.trim();
  } catch {
    const totalScore = results.reduce((s, r) => s + r.bias.score, 0);
    if (totalScore >= 5)  return `Full bull alignment. B&R setup: retest of 5M SMA20 (${fmt(tf5m.sma20)}) or PDC (${fmt(lvl.PDC)}) from above.`;
    if (totalScore <= -5) return `Full bear alignment. B&R setup: rejection at 5M SMA20 (${fmt(tf5m.sma20)}) or PDC (${fmt(lvl.PDC)}) from below.`;
    return `Timeframes mixed — no clear edge. Wait for Daily and 4H to agree.`;
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
    const btLines = bt?.setupA?.['3R']?.count ? (() => {
      const sA2 = bt.setupA['2R'], sA3 = bt.setupA['3R'];
      const sB2 = bt.setupB['2R'], sB3 = bt.setupB['3R'];
      const sC2 = bt.setupC?.['2R'], sC3 = bt.setupC?.['3R'];
      const sD2 = bt.setupD?.['2R'], sD3 = bt.setupD?.['3R'];
      const rows = [
        ``, `Stats (60d backtest):`,
        `A (B&R): 2R=${sA2.winRate}%  3R=${sA3.winRate}% (${sA3.count} trades)`,
        `B (SFP): 2R=${sB2.winRate}%  3R=${sB3.winRate}% (${sB3.count} trades)`,
      ];
      if (sC3?.count) rows.push(`C (SBS): 2R=${sC2.winRate}%  3R=${sC3.winRate}% (${sC3.count} trades | M1:${sC3.m1?.winRate??'?'}% M2:${sC3.m2?.winRate??'?'}%)`);
      if (sD3?.count) rows.push(`D (CISD):2R=${sD2.winRate}%  3R=${sD3.winRate}% (${sD3.count} trades)`);
      return rows;
    })() : [];

    const section = [
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `${sym.label} — ${fmt(results[4].price)}`,
      ``,
      ...results.map(r => r.line),
      ...lvlLines,
      ...btLines,
      ``,
      `Advisory: ${adv}`,
    ].join('\n');

    const data = {
      key,
      price: results[4].price,
      timeframes: results.map(r => ({ label: r.label, bias: r.bias.label, sma20: r.sma20, sma200: r.sma200 })),
      levels: lvl || {},
      advisory: adv,
      backtest: BTSTATS[key] || {},
    };

    return { section, data };
  } catch (e) {
    return { section: `━━━━━━━━━━━━━━━━━━━━━━\n${sym.label} — ERROR: ${e.message}`, data: null };
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

  const tickerResults = await Promise.all(keys.map(k => analyzeTicker(k, newsEvents)));
  const sections = tickerResults.map(r => r.section);

  // Save cache for bot Q&A
  const cacheObj = { updated: new Date().toISOString(), newsEvents, tickers: {} };
  for (const { data } of tickerResults) {
    if (data) cacheObj.tickers[data.key] = data;
  }
  try { writeFileSync(join(__dirname, 'brief-cache.json'), JSON.stringify(cacheObj, null, 2)); } catch {}

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
    // Send header + each ticker section separately to stay under 4096 char limit
    const header = [`📊 STOIC TA — ${arg ?? 'SESSION BRIEF'}`, `${now} ET`].join('\n');
    const footer = `━━━━━━━━━━━━━━━━━━━━━━\n⚠️  Max 3 trades. Hard stop before entry. 2:1 R:R minimum.`;
    const messages = sections.length === 1
      ? [[header, sections[0], footer].join('\n\n')]
      : [header, ...sections, footer];

    let allOk = true;
    for (const chunk of messages) {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: chunk }),
      });
      const body = await r.json();
      if (!body.ok) { console.error('telegram error:', JSON.stringify(body)); allOk = false; }
    }
    console.log(allOk ? 'telegram: sent' : 'telegram: FAILED');
  } else {
    console.log(msg);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
