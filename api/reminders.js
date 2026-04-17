// api/reminders.js — hourly cron job (IST throughout)
//
// What it does:
//   1. Timed reminders — today tasks with a time: remind at that IST time
//                       — dated tasks with no time: remind at 9 AM IST on that date
//                       — dated tasks with a time: remind at that IST time on that date
//                       — today tasks with no time: never remind
//   2. Auto-delete expired today-tasks at midnight IST
//   3. Monthly export+purge — on the 1st at midnight IST, export all of last month's
//      tasks to a CSV in Supabase Storage, delete them, and WhatsApp you a summary

const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY;
const YOUR_WA_NUMBER     = process.env.YOUR_WHATSAPP_NUMBER;
const TWILIO_SID         = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN       = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_NUMBER   = process.env.TWILIO_WHATSAPP_NUMBER;
const CRON_SECRET        = process.env.CRON_SECRET;

// ── Supabase REST helper
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
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return null; }
}

// ── WhatsApp via Twilio
async function sendWA(msg) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_WA_NUMBER || !YOUR_WA_NUMBER) {
    console.error('Missing Twilio env vars — skipping WA send');
    return;
  }
  const creds = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ From: TWILIO_WA_NUMBER, To: YOUR_WA_NUMBER, Body: msg })
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error(`Twilio error ${res.status}: ${txt}`);
  }
}

// ── IST time helpers (UTC+5:30)
const IST_MS = 5.5 * 60 * 60 * 1000;

function istNow() {
  return new Date(Date.now() + IST_MS);
}

function todayIst() {
  const d = istNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// Convert IST date+time to UTC millis
function istToUtcMs(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi]    = (timeStr || '00:00').split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, 0) - IST_MS;
}

// When should this task's reminder fire? Returns UTC millis, or null for "never"
function reminderTimeMs(task) {
  if (task.deadline_type === 'today') {
    if (!task.deadline_time) return null;
    return istToUtcMs(task.deadline_date, task.deadline_time);
  }
  if (task.deadline_type === 'date') {
    return istToUtcMs(task.deadline_date, task.deadline_time || '09:00');
  }
  return null;
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── CSV helpers
function csvEscape(str) {
  if (!str) return '';
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function tasksToCsv(rows) {
  const headers = ['Task','Status','Urgent','Type','Date','Time','Created'];
  const lines = [headers.join(',')];
  for (const t of rows) {
    lines.push([
      csvEscape(t.text),
      t.done ? 'Done' : 'Pending',
      t.urgent ? 'Yes' : 'No',
      t.deadline_type === 'today' ? 'Today' : 'Scheduled',
      t.deadline_date || '',
      t.deadline_time ? t.deadline_time.slice(0,5) : '',
      t.created_at ? t.created_at.slice(0,16).replace('T',' ') : ''
    ].join(','));
  }
  return lines.join('\n');
}

// ── Upload CSV to Supabase Storage (bucket: reports)
async function uploadCsv(filename, csvContent) {
  const url = `${SUPABASE_URL}/storage/v1/object/reports/${filename}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'text/csv',
      'x-upsert': 'true'
    },
    body: csvContent
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Storage upload failed ${res.status}: ${txt}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/reports/${filename}`;
}

// ── Delete tasks by IDs in batches
async function deleteTasks(ids) {
  const batchSize = 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const filter = `id=in.(${batch.join(',')})`;
    await db('DELETE', `tasks?${filter}`);
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const qsSecret   = (req.query && req.query.secret) || '';
  const ok = CRON_SECRET
    ? (authHeader === `Bearer ${CRON_SECRET}` || qsSecret === CRON_SECRET)
    : true;
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const now     = Date.now();
  const ist     = istNow();
  const istHour = ist.getUTCHours();
  const istDay  = ist.getUTCDate();
  const today   = todayIst();
  const log     = [];

  try {
    // ── 1. TIMED REMINDERS
    const candidates = await db('GET',
      `tasks?done=eq.false&reminder_sent=eq.false&deadline_date=lte.${today}`
    );
    for (const task of (candidates || [])) {
      const triggerMs = reminderTimeMs(task);
      if (triggerMs === null) continue;
      if (now < triggerMs) continue;

      const uFlag = task.urgent ? '🔴 *Urgent* ' : '';
      const whenStr = task.deadline_time
        ? ` is due at ${task.deadline_time.slice(0,5)}`
        : ` is due today`;
      try {
        await sendWA(`⏰ ${uFlag}Reminder: _${task.text}_${whenStr}`);
        await db('PATCH', `tasks?id=eq.${task.id}`, { reminder_sent: true });
        log.push(`reminder: ${task.text}`);
      } catch (err) {
        console.error('Reminder send failed:', task.id, err.message);
        log.push(`reminder failed: ${task.id}`);
      }
    }

    // ── 2. AUTO-DELETE expired today-tasks at midnight IST
    if (istHour === 0) {
      const expired = await db('GET',
        `tasks?deadline_type=eq.today&deadline_date=lt.${today}`
      );
      if (expired && expired.length) {
        await deleteTasks(expired.map(t => t.id));
        log.push(`deleted ${expired.length} expired today-tasks`);
      }
    }

    // ── 3. MONTHLY EXPORT + PURGE — 1st of month, midnight IST
    if (istHour === 0 && istDay === 1) {
      const istMonth = ist.getUTCMonth();     // 0-indexed current month
      const istYear  = ist.getUTCFullYear();
      const prevMonth = istMonth === 0 ? 12 : istMonth;       // 1-indexed
      const prevYear  = istMonth === 0 ? istYear - 1 : istYear;
      const startDate = `${prevYear}-${String(prevMonth).padStart(2,'0')}-01`;
      const endDate   = `${istYear}-${String(istMonth + 1).padStart(2,'0')}-01`;

      const rows = await db('GET',
        `tasks?deadline_date=gte.${startDate}&deadline_date=lt.${endDate}&order=deadline_date.asc,created_at.asc`
      );

      if (rows && rows.length) {
        const csv = tasksToCsv(rows);
        const filename = `tasks-${MONTH_NAMES[prevMonth-1]}-${prevYear}.csv`;
        await uploadCsv(filename, csv);

        await deleteTasks(rows.map(t => t.id));

        const done = rows.filter(r => r.done).length;
        const pending = rows.length - done;
        await sendWA(
          `📊 *${MONTH_NAMES[prevMonth-1]} ${prevYear} report archived*\n\n` +
          `${rows.length} tasks exported (${done} done, ${pending} pending)\n` +
          `CSV saved — download from your Tasks app.`
        );
        log.push(`monthly export: ${rows.length} tasks → ${filename}`);
      } else {
        log.push('monthly export: no tasks for previous month');
      }
    }

    return res.json({ ok: true, istHour, istDay, today, log });
  } catch (err) {
    console.error('Reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
}
