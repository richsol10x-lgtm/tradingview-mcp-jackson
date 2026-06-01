#!/usr/bin/env node
// scripts/bot.js — Telegram bot listener (long polling)
// Commands: "brief all" | "brief MNQ" | "brief MES" | "brief MGC" | "brief SIL"
// Only responds to the authorised TELEGRAM_CHAT_ID in .env

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const env       = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

const TOKEN     = env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = String(env.TELEGRAM_CHAT_ID);
const BRIEF     = join(__dirname, 'brief.js');
const TICKERS   = ['MNQ', 'MES', 'MGC', 'SIL'];

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

function runBrief(arg) {
  return new Promise(resolve => {
    const args = arg ? [BRIEF, arg] : [BRIEF];
    const child = spawn(process.execPath, args, { cwd: join(__dirname, '..') });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('close', resolve);
  });
}

async function handleMessage(text) {
  const cmd = text.trim().toLowerCase();

  if (cmd === 'brief all' || cmd === 'brief') {
    await send('Running full brief — one moment...');
    await runBrief(null);
    return;
  }

  const match = cmd.match(/^brief\s+([a-z]+)$/i);
  if (match) {
    const ticker = match[1].toUpperCase();
    if (TICKERS.includes(ticker)) {
      await send(`Running ${ticker} brief — one moment...`);
      await runBrief(ticker);
      return;
    }
    await send(`Unknown ticker "${ticker}". Valid options: ${TICKERS.join(', ')}`);
    return;
  }

  await send(`Commands:\n• brief all — full brief (all tickers)\n• brief MNQ — single ticker\n• brief MES\n• brief MGC\n• brief SIL`);
}

async function poll() {
  let offset = 0;
  console.log(`Bot live — listening for messages from chat ${CHAT_ID}`);

  while (true) {
    try {
      const res  = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=30&offset=${offset}`);
      const data = await res.json();

      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== CHAT_ID) continue; // ignore unauthorised senders
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
