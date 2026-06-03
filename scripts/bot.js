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
const BRIEF_CACHE = join(__dirname, 'brief-cache.json');
const TRADE_LOG   = join(__dirname, 'trade-log.json');

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

const QA_SYSTEM = `You are a StoicTA trading advisor. Answer questions about the last market brief in 2-3 sentences. Reference specific price levels and setup names (A or B). Be direct — no fluff. Plain text only — no markdown, no bold, no asterisks.

StoicTA strategy:
- Setup A: break of level → retest from other side at 5M 20 SMA confluence → enter. Target 2.618 fib.
- Setup B: wick sweeps level (SFP) → fails to close through → reverses. Enter on SFP candle close.
- Key levels: PDH/PDL/PDC (prior day), HCOM/LCOM (composite), PWH/PWL (prior week).`;

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
- setup: "SFP" | "B&R" | "Fractal" | "Post-Stop" | null
- ticker: "MNQ" | "MES" | "MGC" | "SIL" | null
- nearDailyLevel: true | false | null
- stopStructural: true | false | null
- cisdConfirmed: true | false | null
- projectionUsed: true | false | null
- rejectionZoneDip: true | false | null
- beAt1r1: true | false | null
- outcome: "TP" | "SL" | "BE" | "open" | null
- rMultiple: number | null
- notes: string | null`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: PARSE_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    return JSON.parse(msg.content[0].text.trim());
  } catch { return { notes: description }; }
}

async function runReview(trades) {
  const last10 = trades.slice(-10);
  const summary = last10.map(t =>
    `#${t.id} ${t.setup ?? '?'} ${t.ticker ?? '?'}: outcome=${t.outcome ?? '?'} R=${t.rMultiple ?? '?'} nearLevel=${t.nearDailyLevel} CISD=${t.cisdConfirmed} projection=${t.projectionUsed} BE1:1=${t.beAt1r1}`
  ).join('\n');

  const prompt = `Review the last 10 trades and give a direct performance breakdown.

Trades:
${summary}

Answer these 6 points:
1. Which setup has best avg R?
2. Which setup gets stopped most?
3. How many stopped trades moved to TP after? (stop placement issue)
4. CISD present on valid re-entries vs skipped?
5. Targets: swing structure targets reached? When fib used instead of structure, did it hit?
6. ONE specific thing to tighten.

Then flag any of these if triggered:
- SFP win rate < 40% → flag + ask if market conditions changed
- Fractal alignment outperforming SFP → note shift
- BE at 1:1 still happening → call it out
- CISD being skipped on re-entries → flag each one
- Projections consistently missing → adjust expectations

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
    reply += ' BE at 1:1 flagged — use rejection zone trailing, not BE.';
  if (parsed.outcome === 'SL' && parsed.notes?.toLowerCase().includes('tp after'))
    reply += ' Stopped then hit TP — stop placement still the issue.';
  if (parsed.setup === 'Post-Stop' && parsed.cisdConfirmed === false)
    reply += ' CISD not confirmed on re-entry — that one should have been skipped.';

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
      `Commands:\n` +
      `• price MNQ / MES / MGC / SIL\n` +
      `• price all\n` +
      `• brief all\n` +
      `• brief MNQ / MES / MGC / SIL\n` +
      `• backtest all\n` +
      `• backtest MNQ / MES / MGC / SIL\n` +
      `• news — today's high-impact events\n` +
      `• news week — full week calendar\n` +
      `• log [trade] — log a trade\n` +
      `  e.g. log SFP MNQ PDH, hit TP 2.1R\n` +
      `\nAnything else = Q&A against last brief`
    );
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
