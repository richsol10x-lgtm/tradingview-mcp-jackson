#!/usr/bin/env node
// scripts/news.js — ForexFactory high-impact calendar
// Fetches this week's events, filters HIGH impact USD (+ gold/silver movers),
// formats a phone-friendly summary, sends to Telegram.
// Usage: node scripts/news.js          → today's events
//        node scripts/news.js week     → full week

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const env       = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};

// Countries that move our instruments (USD drives MNQ/MES/MGC/SIL)
const WATCHED_COUNTRIES = ['USD', 'XAU', 'XAG'];
const HIGH_IMPACT       = ['High'];

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

async function fetchEvents() {
  const res  = await fetch(CALENDAR_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();
  return data.filter(e =>
    HIGH_IMPACT.includes(e.impact) &&
    (WATCHED_COUNTRIES.includes(e.country) || e.country === 'USD')
  );
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    timeZone: 'America/New_York',
    weekday: 'short', day: 'numeric', month: 'short'
  });
}

function isToday(dateStr) {
  const evDate  = new Date(dateStr).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayET = new Date().toLocaleDateString('en-CA',         { timeZone: 'America/New_York' });
  return evDate === todayET;
}

export async function getUpcoming(windowMins = 20) {
  const events = await fetchEvents();
  const now    = Date.now();
  return events.filter(e => {
    const ms = new Date(e.date).getTime() - now;
    return ms > 0 && ms <= windowMins * 60 * 1000;
  });
}

export async function getTodayEvents() {
  const events = await fetchEvents();
  return events.filter(e => isToday(e.date));
}

function formatEvent(e) {
  const fc  = e.forecast ? `Forecast: ${e.forecast}` : '';
  const prv = e.previous  ? `Previous: ${e.previous}` : '';
  const sub = [fc, prv].filter(Boolean).join('  |  ');
  return `${formatTime(e.date)} ET — ${e.title}${sub ? '\n  ' + sub : ''}`;
}

async function main() {
  const mode   = process.argv[2]?.toLowerCase();
  const events = mode === 'week' ? await fetchEvents() : await getTodayEvents();

  if (!events.length) {
    const msg = mode === 'week'
      ? '📰 No high-impact USD events this week.'
      : '📰 No high-impact USD events today.';
    console.log(msg);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }),
      });
    }
    return;
  }

  // Group by date for week view
  const grouped = {};
  for (const e of events) {
    const d = formatDate(e.date);
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(e);
  }

  const sections = Object.entries(grouped).map(([date, evs]) =>
    `📅 ${date}\n` + evs.map(e => `🔴 ${formatEvent(e)}`).join('\n')
  );

  const header = mode === 'week' ? '📰 HIGH IMPACT EVENTS — THIS WEEK' : '📰 HIGH IMPACT EVENTS — TODAY';
  const msg = [header, '', ...sections].join('\n');

  console.log(msg);

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }),
    });
    console.log((await r.json()).ok ? 'telegram: sent' : 'telegram: FAILED');
  }
}

// Only run when executed directly, not when imported by bot.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
