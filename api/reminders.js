// api/reminders.js — hourly cron job
// Sends morning summary, timed reminders, tomorrow preview, auto-deletes expired today tasks

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const YOUR_WA_NUMBER = process.env.YOUR_WHATSAPP_NUMBER;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const CRON_SECRET = process.env.CRON_SECRET;

async function db(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return null; }
}

async function sendWA(msg) {
  const creds = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: TWILIO_WA_NUMBER, To: YOUR_WA_NUMBER, Body: msg })
  });
}

function todayStr() { return new Date().toISOString().slice(0,10); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function fmtDate(s) {
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'});
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  // Use IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  const today = todayStr();
  const tomorrow = addDays(1);
  const log = [];

  try {
    // 1. MORNING SUMMARY at 8am IST
    if (hour === 8) {
      const rows = await db('GET', `tasks?done=eq.false&deadline_date=eq.${today}&order=urgent.desc,created_at.asc`);
      if (rows && rows.length) {
        const lines = rows.map((t,i) =>
          `${i+1}. ${t.urgent?'🔴 ':''}${t.text}${t.deadline_time?' ⏰'+t.deadline_time.slice(0,5):''}`
        ).join('\n');
        await sendWA(`☀️ *Good morning! Today\'s tasks:*\n\n${lines}`);
        log.push('morning summary sent');
      }
    }

    // 2. TIMED REMINDERS — 30 min before deadline_time
    const timedRows = await db('GET', `tasks?done=eq.false&deadline_date=eq.${today}&reminder_sent=eq.false`);
    if (timedRows) {
      for (const t of timedRows) {
        if (!t.deadline_time) continue;
        const [th, tm] = t.deadline_time.split(':').map(Number);
        // Calculate reminder time = task time minus 30 min
        const taskMins = th * 60 + tm;
        const reminderMins = taskMins - 30;
        const rh = Math.floor(reminderMins / 60);
        const rm = reminderMins % 60;
        if (hour === rh && Math.abs(minute - rm) < 60) {
          await sendWA(`⏰ *Reminder:* ${t.urgent?'🔴 ':''}${t.text} is due at ${t.deadline_time.slice(0,5)}`);
          await db('PATCH', `tasks?id=eq.${t.id}`, { reminder_sent: true });
          log.push(`reminder sent for: ${t.text}`);
        }
      }
    }

    // 3. TOMORROW PREVIEW at 8pm IST
    if (hour === 20) {
      const rows = await db('GET', `tasks?done=eq.false&deadline_date=eq.${tomorrow}&order=urgent.desc`);
      if (rows && rows.length) {
        const lines = rows.map((t,i) => `${i+1}. ${t.urgent?'🔴 ':''}${t.text}`).join('\n');
        await sendWA(`📅 *Tomorrow\'s tasks:*\n\n${lines}`);
        log.push('tomorrow preview sent');
      }
    }

    // 4. AUTO-DELETE expired today tasks at midnight IST (hour === 0)
    if (hour === 0) {
      const expired = await db('GET', `tasks?done=eq.false&deadline_type=eq.today&deadline_date=lt.${today}`);
      if (expired && expired.length) {
        for (const t of expired) {
          await db('DELETE', `tasks?id=eq.${t.id}`);
        }
        await sendWA(`🗑️ Removed ${expired.length} expired today task${expired.length>1?'s':''}.`);
        log.push(`deleted ${expired.length} expired tasks`);
      }
    }

    // 5. UPCOMING DATE REMINDERS — send morning of deadline_date
    if (hour === 8) {
      const dated = await db('GET', `tasks?done=eq.false&deadline_type=eq.date&deadline_date=eq.${today}&order=urgent.desc`);
      if (dated && dated.length) {
        const lines = dated.map((t,i) => `${i+1}. ${t.urgent?'🔴 ':''}${t.text}`).join('\n');
        await sendWA(`📌 *Tasks due today (scheduled):*\n\n${lines}`);
        log.push('dated task reminders sent');
      }
    }

    res.json({ ok: true, hour, log });
  } catch(err) {
    console.error('Reminder error:', err);
    res.status(500).json({ error: err.message });
  }
}
