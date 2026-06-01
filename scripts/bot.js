#!/usr/bin/env node
// scripts/bot.js — Telegram bot listener (long polling)
// Commands: brief all | brief [TICKER] | backtest all | backtest [TICKER] | news | news week
// Auto-warns 15 minutes before high-impact economic events.
// Only responds to the authorised TELEGRAM_CHAT_ID in .env

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { getUpcoming, getTodayEvents } from './news.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const env       = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

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

// --- Command handler ---
async function handleMessage(text) {
  const cmd = text.trim().toLowerCase();

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

  if (cmd === 'news' || cmd === 'news today') {
    await runScript(NEWS, null);
    return;
  }

  if (cmd === 'news week') {
    await runScript(NEWS, 'week');
    return;
  }

  await send(
    `Commands:\n` +
    `• brief all\n• brief MNQ / MES / MGC / SIL\n` +
    `• backtest all\n• backtest MNQ / MES / MGC / SIL\n` +
    `• news  — today's high-impact events\n` +
    `• news week  — full week calendar`
  );
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
