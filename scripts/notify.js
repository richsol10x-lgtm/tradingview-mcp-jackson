// scripts/notify.js — node scripts/notify.js "message"
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const env = require('dotenv').config({ path: join(__dirname, '../.env') }).parsed || {};
const msg = process.argv.slice(2).join(' ');

(async () => {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg })
    });
    console.log('telegram:', (await r.json()).ok ? 'sent' : 'FAILED');
  } else if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    const { default: nodemailer } = await import('nodemailer');
    const tx = nodemailer.createTransport({ service: 'gmail',
      auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD } });
    await tx.sendMail({ from: env.GMAIL_USER, to: env.GMAIL_USER,
      subject: 'TradingView brief', text: msg });
    console.log('gmail: sent');
  } else {
    console.log('NO CHANNEL — printing:\n' + msg);
  }
})();
