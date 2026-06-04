#!/usr/bin/env node
// scripts/bot.js — Telegram bot listener (long polling)
// Commands: brief all | brief [TICKER] | backtest all | backtest [TICKER] | news | news week
// Auto-warns 15 minutes before high-impact economic events.
// Only responds to the authorised TELEGRAM_CHAT_ID in .env

import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { getUpcoming, getTodayEvents } from './news.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const env       = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const TOKEN    = env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = String(env.TELEGRAM_CHAT_ID);
const BRIEF    = join(__dirname, 'brief.js');
const BACKTEST = join(__dirname, 'backtest.js');
const NEWS     = join(__dirname, 'news.js');
const TICKERS  = ['MNQ', 'MES', 'MGC', 'SIL'];

if (!TOKEN || !CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

async function send(text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
}

function runScript(scriptPath, arg) {
  return new Promise(resolve => {
    const args = arg ? [scriptPath, arg] : [scriptPath];
    const child = spawn(process.execPath, args, { cwd: join(__dirname, '..') });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('close', resolve);
  });
}

function fmtTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// --- Auto news warning loop ---
const warnedEvents = new Set(); // track which events we've already warned about

async function checkUpcomingEvents() {
  try {
    const upcoming = await getUpcoming(20); // events in next 20 minutes
    for (const e of upcoming) {
      const key = `${e.title}-${e.date}`;
      if (warnedEvents.has(key)) continue;
      warnedEvents.add(key);
      const minsAway = Math.round((new Date(e.date) - Date.now()) / 60000);
      const fc  = e.forecast ? `  Forecast: ${e.forecast}` : '';
      const prv = e.previous  ? `  Previous: ${e.previous}` : '';
      await send(
        `⚠️ HIGH IMPACT IN ~${minsAway} MIN\n\n🔴 ${fmtTime(e.date)} ET — ${e.title}${fc}${prv}\n\nStay sharp — consider reducing size or sitting out.`
      );
      console.log(`[NEWS WARNING] ${e.title} in ~${minsAway}min`);
    }
  } catch (e) {
    console.error('News check error:', e.message);
  }
}

// Check for upcoming events every 5 minutes
setInterval(checkUpcomingEvents, 5 * 60 * 1000);
checkUpcomingEvents(); // run immediately on start

// --- Free-form Q&A against last brief ---
const BRIEF_CACHE        = join(__dirname, 'brief-cache.json');
const TRADE_LOG          = join(__dirname, 'trade-log.json');
const OPEN_TRADES_PATH   = join(__dirname, 'open-trades.json');
const LEVELS_PATH        = join(__dirname, 'levels.json');
const SIGNAL_CACHE_PATH  = join(__dirname, 'signal-cache.json');
const SIGNALS_SCRIPT     = join(__dirname, 'signals.js');

const YAHOO_SYMBOLS = { MNQ: 'MNQ=F', MES: 'MES=F', MGC: 'MGC=F', SIL: 'SIL=F' };

async function fetchLivePrice(yahooSym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
}

async function fetchAllLivePrices() {
  const pairs = await Promise.all(
    Object.entries(YAHOO_SYMBOLS).map(async ([key, sym]) => [key, await fetchLivePrice(sym).catch(() => null)])
  );
  return Object.fromEntries(pairs);
}

const QA_SYSTEM = `You are a StoicTA trading advisor. Answer questions about the last market brief in 2-3 sentences. Be direct — no fluff. Plain text only — no markdown, no bold, no asterisks.

Setups: A=B&R (break PDH/PDL/PDC → retest → enter), B=SFP (sweep level + close fails back inside → reverse), C=SBS 5-move sequence (only enter at Move 5 reversal — M1 shallow M4 at range top, M2 deep into move origin = A+), D=TTrades CISD (1H C2/C3 bias → 5M or 1M CISD entry).
Fib geometry on all entries: first pullback ≥50% → wait 100% extension → enter second pullback at 50%. Target 2.618 default.
Key levels: PDH/PDL/PDC (prior day), HCOM/LCOM (monthly composite), PWH/PWL (prior week).
Macro: above both 20/200 SMA = bullish only. Below both = bearish only. Between = caution.`;

function loadOpenTrades() {
  try { return JSON.parse(readFileSync(OPEN_TRADES_PATH, 'utf8')); }
  catch { return { trades: [] }; }
}

function loadLevels() {
  try { return JSON.parse(readFileSync(LEVELS_PATH, 'utf8')); }
  catch { return {}; }
}

function etDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function fmt(n, dp = 2) {
  return n != null ? n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—';
}

async function askAdvisory(question) {
  let cache;
  try { cache = JSON.parse(readFileSync(BRIEF_CACHE, 'utf8')); }
  catch { return 'No brief data yet — run `brief all` first.'; }

  const ageHours = Math.round((Date.now() - new Date(cache.updated).getTime()) / 3600000);
  const ageNote  = ageHours >= 1 ? ` (brief is ${ageHours}h old — SMA/bias from brief, prices are live)` : '';
  const fmt = n => n?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';

  // Fetch live prices in parallel with context build — always use these for price questions
  const [livePrices] = await Promise.all([fetchAllLivePrices()]);
  const livePriceStr = Object.entries(livePrices)
    .filter(([, p]) => p != null)
    .map(([k, p]) => `${k}: ${fmt(p)}`)
    .join(' | ');

  const context = Object.values(cache.tickers).map(t => {
    const tfs = t.timeframes.map(tf =>
      `  ${tf.label}: ${tf.bias} (SMA20: ${fmt(tf.sma20)}, SMA200: ${fmt(tf.sma200)})`
    ).join('\n');
    const l = t.levels;
    const live = livePrices[t.key];
    const priceStr = live != null ? `${fmt(live)} (live)` : `${fmt(t.price)} (cached)`;
    return `${t.key} @ ${priceStr}:\n${tfs}\n  PDH: ${fmt(l.PDH)}  PDC: ${fmt(l.PDC)}  PDL: ${fmt(l.PDL)}  HCOM: ${fmt(l.HCOM)}  LCOM: ${fmt(l.LCOM)}\n  Advisory: ${t.advisory}`;
  }).join('\n\n');

  const news = cache.newsEvents?.length
    ? cache.newsEvents.map(e => `  ${e.time} ET — ${e.title}`).join('\n')
    : '  None';

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      system: QA_SYSTEM,
      messages: [{ role: 'user', content: `TIME: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ET\nLIVE PRICES NOW: ${livePriceStr}\n\nLast brief${ageNote}:\n\n${context}\n\nToday's news:\n${news}\n\nQuestion: ${question}` }],
    });
    return msg.content[0].text.trim();
  } catch (e) {
    return `API error: ${e.message}`;
  }
}

// --- Trade logging & review ---
const PARSE_SYSTEM = `Extract trade fields from a plain-English trade report. Return ONLY valid JSON, no markdown, no explanation.`;

async function parseTrade(description) {
  const prompt = `Trade: "${description}"

Extract these fields (use null if unknown):
- setup: "A" | "B" | "C" | "D5" | "D1" | null   (A=B&R, B=SFP, C=SBS, D5=CISD 5M entry, D1=CISD 1M entry)
- ticker: "MNQ" | "MES" | "MGC" | "SIL" | null
- dir: "LONG" | "SHORT" | null
- model: "M1" | "M2" | null   (Setup C only — M1=shallow M4, M2=deep into move origin)
- entryPrice: number | null
- stopPrice: number | null
- targetPrice: number | null
- outcome: "TP" | "SL" | "BE" | "open" | null
- rMultiple: number | null   (actual R achieved; negative for losses e.g. -1)
- nearDailyLevel: true | false | null   (price within 0.3% of PDH/PDL/PDC at entry)
- atMoveOrigin: true | false | null   (M4 reached move origin — A+ quality for Setup C)
- biasAligned: true | false | null   (20/200 SMA macro bias matches trade direction)
- fibSecondPullback: true | false | null   (waited for fib geometry second pullback ≥50%)
- cisd: true | false | null   (CISD confirmed before entry — required for D setups)
- stopStructural: true | false | null   (stop placed beyond structural swing, not arbitrary)
- beAt1r1: true | false | null   (moved stop to BE at 1:1 — flagged bad habit)
- notes: string | null`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: PARSE_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    return JSON.parse(msg.content[0].text.trim());
  } catch { return { notes: description }; }
}

async function runReview(trades) {
  const last10 = trades.slice(-10);
  const summary = last10.map(t =>
    `#${t.id} ${t.setup ?? '?'}${t.model ? '/'+t.model : ''} ${t.ticker ?? '?'} ${t.dir ?? '?'}: outcome=${t.outcome ?? '?'} R=${t.rMultiple ?? '?'} biasAligned=${t.biasAligned} nearLevel=${t.nearDailyLevel} atMoveOrigin=${t.atMoveOrigin} cisd=${t.cisd} fibPullback=${t.fibSecondPullback} stopStructural=${t.stopStructural} BE1:1=${t.beAt1r1}`
  ).join('\n');

  const prompt = `Review the last 10 trades. Setups: A=B&R, B=SFP, C=SBS (M1=shallow M4, M2=deep into move origin), D5/D1=TTrades CISD.

Trades:
${summary}

Answer these 6 points:
1. Which setup has best avg R? Which has worst?
2. Which setup gets stopped most often?
3. How many stopped trades had biasAligned=false? (entries against macro)
4. Setup C losses: did M4 reach move origin (atMoveOrigin=true = A+) or stop above it? Flag M2 losses where atMoveOrigin=false.
5. Setup D losses: was cisd=true? Was biasAligned=true? Flag any D trade where cisd=false.
6. ONE specific mechanical thing to tighten next 10 trades.

Flag every instance of:
- BE at 1:1 (beAt1r1=true) → call out each one
- Entry against bias (biasAligned=false) → flag each one
- Setup C entered without fibSecondPullback=true → flag
- Setup D entered without cisd=true → flag
- stopStructural=false → flag each one

Plain text, no markdown, be direct.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 450,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].text.trim();
  } catch (e) { return `Review error: ${e.message}`; }
}

async function logTrade(description) {
  const parsed = await parseTrade(description);
  let log = { trades: [] };
  try { log = JSON.parse(readFileSync(TRADE_LOG, 'utf8')); } catch {}

  const trade = { id: log.trades.length + 1, timestamp: new Date().toISOString(), raw: description, ...parsed };
  log.trades.push(trade);
  writeFileSync(TRADE_LOG, JSON.stringify(log, null, 2));

  const count = log.trades.length;
  let reply = `Trade #${count} logged.`;

  // Inline flags
  if (parsed.beAt1r1)
    reply += '\n⚠️ BE at 1:1 flagged — trail below rejection zone at 1.5R, not BE.';
  if (parsed.biasAligned === false)
    reply += '\n⚠️ Entry against macro bias — 20/200 SMA not aligned with direction.';
  if ((parsed.setup === 'D5' || parsed.setup === 'D1') && parsed.cisd === false)
    reply += '\n⚠️ CISD not confirmed — D setup requires CISD before entry. Should have been skipped.';
  if (parsed.setup === 'C' && parsed.fibSecondPullback === false)
    reply += '\n⚠️ Fib second pullback not waited for — entry before confirmation.';
  if (parsed.stopStructural === false)
    reply += '\n⚠️ Stop not structural — always place beyond swing high/low, never arbitrary.';

  // 10-trade review
  if (count % 10 === 0) {
    reply += `\n\n10 trades in — running review...`;
    const review = await runReview(log.trades);
    reply += '\n\n' + review;
  }

  return reply;
}

// --- Command handler ---
async function handleMessage(text) {
  const cmd = text.trim().toLowerCase();

  if (cmd === 'help' || cmd === 'commands') {
    await send(
      `PRICES & LEVELS\n` +
      `• price MNQ / MES / MGC / SIL / all\n` +
      `• levels — all stored levels\n` +
      `• levels MNQ / MES / MGC / SIL\n` +
      `• status — live price vs PDH/PDL for all\n` +
      `\nSIGNALS & TRADES\n` +
      `• signals — today's signal history + outcomes\n` +
      `• trades — open trades + status\n` +
      `• close MNQ / MES / MGC / SIL — manual close\n` +
      `• scan — run signal scan now\n` +
      `\nBRIEFS & ANALYSIS\n` +
      `• brief all / brief MNQ / MES / MGC / SIL\n` +
      `• backtest all / backtest [TICKER]\n` +
      `• news / news week\n` +
      `\nTRADE LOG\n` +
      `• log [trade] — e.g. log SFP MNQ PDH, hit TP 2.1R\n` +
      `• review — run 10-trade review now\n` +
      `\nAnything else = Q&A against last brief`
    );
    return;
  }

  // --- Levels ---
  if (cmd === 'levels' || cmd.startsWith('levels ')) {
    const levels = loadLevels();
    const arg    = cmd.split(' ')[1]?.toUpperCase();
    const tickers = arg && levels[arg] ? [arg] : TICKERS;
    const lines = tickers.map(t => {
      const l = levels[t];
      if (!l) return `${t}: no data`;
      return `${t}  PDH ${fmt(l.PDH, 1)} | PDL ${fmt(l.PDL, 1)} | PDC ${fmt(l.PDC, 1)} | HCOM ${fmt(l.HCOM, 1)} | LCOM ${fmt(l.LCOM, 1)}`;
    });
    await send(`Levels (${levels.updated ? new Date(levels.updated).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }) : 'cached'}):\n${lines.join('\n')}`);
    return;
  }

  // --- Status: live price vs key levels ---
  if (cmd === 'status') {
    const levels = loadLevels();
    const prices = await fetchAllLivePrices();
    const lines  = TICKERS.map(t => {
      const p = prices[t];
      const l = levels[t];
      if (!p || !l) return `${t}: unavailable`;
      const pctPDH = ((p - l.PDH) / l.PDH * 100).toFixed(2);
      const pctPDL = ((p - l.PDL) / l.PDL * 100).toFixed(2);
      const vs = n => (n > 0 ? `+${n}` : `${n}`) + '%';
      return `${t} @ ${fmt(p, 1)}  |  PDH ${vs(pctPDH)}  |  PDL ${vs(pctPDL)}  |  PDC ${fmt(l.PDC, 1)}`;
    });
    await send(`Status:\n${lines.join('\n')}`);
    return;
  }

  // --- Signals today ---
  if (cmd === 'signals' || cmd === 'signals today') {
    let cache = {};
    try { cache = JSON.parse(readFileSync(SIGNAL_CACHE_PATH, 'utf8')); } catch {}
    const today      = etDay();
    const todaySigs  = Object.entries(cache).filter(([k]) => k.endsWith(`_${today}`));
    if (!todaySigs.length) { await send('No signals today.'); return; }
    const db    = loadOpenTrades();
    const emoji = { complete: '✅', stopped: '❌', stopped_after_t1: '⚠️', t1_hit: '🎯', open: '🔵', manual: '🔒' };
    const lines = todaySigs.map(([key, time]) => {
      const baseKey  = key.replace(`_${today}`, '');
      const trade    = db.trades.find(t => t.key === baseKey);
      const status   = trade?.status ?? 'open';
      const timeStr  = new Date(time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });
      return `${emoji[status] ?? '•'} ${baseKey} @ ${timeStr} ET → ${status}`;
    });
    await send(`Signals today:\n${lines.join('\n')}`);
    return;
  }

  // --- Open trades ---
  if (cmd === 'trades') {
    const db      = loadOpenTrades();
    const today   = etDay();
    const active  = db.trades.filter(t =>
      ['open', 't1_hit'].includes(t.status) ||
      t.signaledAt?.startsWith(today)
    );
    if (!active.length) { await send('No trades today.'); return; }
    const emoji = { open: '🔵', t1_hit: '🎯', complete: '✅', stopped: '❌', stopped_after_t1: '⚠️', manual: '🔒' };
    const lines = active.map(t => {
      const dir = t.direction === 'LONG' ? '↑' : '↓';
      const t1  = t.t1 != null ? ` T1:${fmt(t.t1, 1)}` : '';
      const t2  = t.t2 != null ? ` T2:${fmt(t.t2, 1)}` : '';
      return `${emoji[t.status] ?? '•'} ${t.ticker} ${t.type} ${dir} @ ${fmt(t.entry, 1)} | Stop:${fmt(t.stop, 1)}${t1}${t2} [${t.status}]`;
    });
    await send(`Trades:\n${lines.join('\n')}`);
    return;
  }

  // --- Manually close open trade ---
  const closeMatch = cmd.match(/^close\s+([a-z]+)$/i);
  if (closeMatch) {
    const ticker = closeMatch[1].toUpperCase();
    if (!TICKERS.includes(ticker)) { await send(`Unknown ticker. Valid: ${TICKERS.join(', ')}`); return; }
    const db   = loadOpenTrades();
    const open = db.trades.filter(t => t.ticker === ticker && ['open', 't1_hit'].includes(t.status));
    if (!open.length) { await send(`No open trades for ${ticker}.`); return; }
    open.forEach(t => { t.status = 'manual'; t.updatedAt = new Date().toISOString(); });
    writeFileSync(OPEN_TRADES_PATH, JSON.stringify(db, null, 2));
    await send(`${ticker} — ${open.length} trade(s) marked manually closed.`);
    return;
  }

  // --- Trigger immediate signal scan ---
  if (cmd === 'scan') {
    await send('Running signal scan...');
    await runScript(SIGNALS_SCRIPT, null);
    return;
  }

  // --- On-demand 10-trade review ---
  if (cmd === 'review') {
    let log = { trades: [] };
    try { log = JSON.parse(readFileSync(TRADE_LOG, 'utf8')); } catch {}
    if (log.trades.length < 2) { await send('Not enough trades logged yet. Use: log [trade description]'); return; }
    await send(`Reviewing last ${Math.min(log.trades.length, 10)} trades...`);
    const review = await runReview(log.trades);
    await send(review);
    return;
  }

  if (cmd === 'brief all' || cmd === 'brief') {
    await send('Running full brief — one moment...');
    await runScript(BRIEF, null);
    return;
  }

  const briefMatch = cmd.match(/^brief\s+([a-z]+)$/i);
  if (briefMatch) {
    const ticker = briefMatch[1].toUpperCase();
    if (TICKERS.includes(ticker)) {
      await send(`Running ${ticker} brief — one moment...`);
      await runScript(BRIEF, ticker);
      return;
    }
    await send(`Unknown ticker "${ticker}". Valid: ${TICKERS.join(', ')}`);
    return;
  }

  if (cmd === 'backtest' || cmd === 'backtest all') {
    await send('Running 60-day backtest — takes ~15 seconds...');
    await runScript(BACKTEST, null);
    return;
  }

  const btMatch = cmd.match(/^backtest\s+([a-z]+)$/i);
  if (btMatch) {
    const ticker = btMatch[1].toUpperCase();
    if (TICKERS.includes(ticker)) {
      await send(`Running ${ticker} backtest — one moment...`);
      await runScript(BACKTEST, ticker);
      return;
    }
    await send(`Unknown ticker "${ticker}". Valid: ${TICKERS.join(', ')}`);
    return;
  }

  if (cmd === 'price' || cmd === 'price all') {
    const prices = await fetchAllLivePrices();
    const lines = Object.entries(prices).map(([k, p]) =>
      p != null ? `${k}: ${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `${k}: unavailable`
    );
    await send(`Live prices:\n${lines.join('\n')}`);
    return;
  }

  const priceMatch = cmd.match(/^price\s+([a-z]+)$/i);
  if (priceMatch) {
    const ticker = priceMatch[1].toUpperCase();
    const sym = YAHOO_SYMBOLS[ticker];
    if (!sym) { await send(`Unknown ticker. Valid: ${Object.keys(YAHOO_SYMBOLS).join(', ')}`); return; }
    const p = await fetchLivePrice(sym).catch(() => null);
    await send(p != null ? `${ticker}: ${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `${ticker}: price unavailable`);
    return;
  }

  if (cmd.startsWith('log ')) {
    const tradeText = text.trim().slice(4).trim();
    if (tradeText) {
      const result = await logTrade(tradeText);
      await send(result);
      return;
    }
  }

  if (cmd === 'news' || cmd === 'news today') {
    await runScript(NEWS, null);
    return;
  }

  if (cmd === 'news week') {
    await runScript(NEWS, 'week');
    return;
  }

  // Free-form question — answer from last brief cache
  const answer = await askAdvisory(text.trim());
  await send(answer);
}

// --- Polling loop ---
async function poll() {
  let offset = 0;
  console.log(`Bot live — listening on chat ${CHAT_ID}`);

  while (true) {
    try {
      const res  = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=30&offset=${offset}`);
      const data = await res.json();

      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== CHAT_ID) continue;
        const text = msg.text ?? '';
        console.log(`[${new Date().toISOString()}] ${text}`);
        await handleMessage(text);
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

poll();
