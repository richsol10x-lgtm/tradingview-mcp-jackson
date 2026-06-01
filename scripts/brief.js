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

const ADVISORY_SYSTEM = `You are a trading partner for a micro futures day trader. Two frameworks govern entries — they do not compete.

STOICTA (fires near daily levels only):
- Setup 1 SFP: price sweeps a daily level (fakeout beyond swing high/low), candle closes back inside. Enter on close of that candle. Stop beyond SFP wick. Reversal.
- Setup 2 B&R: price breaks a level with conviction, pulls back to retest, level holds. Enter on hold confirmation. Stop beyond structural swing of retest. Continuation.
- RULE: if price is NOT near a significant daily level, StoicTA does NOT apply.

TTRADES FRACTAL MODEL (fires away from daily levels):
- Setup 3 Fractal: The Fractal Model indicator bias is the authoritative TTrades directional read — trust it over SMA approximations. Daily/4H/15M SMA bias confirms the structure context. 5M is primary entry timeframe. Stop beyond protected swing on 15M.
- Setup 4 Post-Stop Re-entry: after a stop — wait for (1) higher TF candle 2 or 3 closure AND (2) CISD on lower TF — price closes through candles that created the swing, V-shaped, decisive, 1-3 candles. Sideways grind through structure = not CISD. Lower TF CISD without higher TF closure = ignore entirely.

PRICE TARGETS (updated May 2026):
Primary — higher timeframe swing structure: bullish targets previous untouched swing highs, bearish targets previous untouched swing lows. If already taken out = invalid, find the next one. TF alignment: 5M entry targets hourly swing, hourly setup targets daily swing, daily targets weekly.
Dual target: nearest swing high/low = partial exit (short-term), larger swing = runner (higher TF).
Secondary (only when no clear structure visible) — fib projection from manipulation leg: average leg -2 to -2.5, expanding leg -4 to -4.5, large leg -1 only. Use as confluence when it aligns with a structural level.

CONTINUATION QUALITY FILTER (check before any continuation):
1. Real continuation or consolidation? V-shaped, closes through opposing candles decisively = valid. Slow grind / sideways = skip.
2. Liquidity sweep? If price is sweeping short-term highs/lows — wait one more candle. Sweep completion is not an entry.
3. Higher TF target already met? If price already reached major objective = do not chase. Wait for next setup.

STOP RULES:
- Structural always — beyond protected swing or SFP wick. Never fixed pip.
- Do NOT move to BE at 1:1. Trail to below most recent rejection zone once 1.5R cleared.
- Price commonly rejects 20-40% into the swing before continuing — real stop sits below that rejection zone.

Answer in this exact order. Be SHORT. Plain text only, no markdown. Talk like a trading partner — tell what the rules say, not what you predict:
1. Near a daily level? If yes — which level and is there an SFP or B&R forming?
2. If no level nearby — is Daily/4H/15M fractal aligned? What direction?
3. Bias: bullish/bearish/neutral + one plain English reason from the rules.
4. Continuation check: real continuation or consolidation? Sweep happening? Higher TF target already met?
5. Target: nearest untouched swing high/low for partial, next higher TF swing for runner. Only use fib if no clear structure.
6. What invalidates this setup.`;

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

Backtest win rates (StoicTA @ 3R): B&R ${bt.setupA?.['3R']?.winRate ?? '?'}% | SFP ${bt.setupB?.['3R']?.winRate ?? '?'}%

High-impact news today:
${newsStr}${flagStr}

Give the brief now.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
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
      return [
        ``, `Stats (60d backtest):`,
        `A (B&R): 2R=${sA2.winRate}%  3R=${sA3.winRate}% (${sA3.count} trades)`,
        `B (SFP): 2R=${sB2.winRate}%  3R=${sB3.winRate}% (${sB3.count} trades)`,
      ];
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
