// api/reminders.js — hourly cron job
//
// Reminder rules:
//   - deadline_type='today', no time  → never remind
//   - deadline_type='today', with time → remind at that time (IST)
//   - deadline_type='date',  no time  → remind at 9:00 AM IST on that date
//   - deadline_type='date',  with time → remind at that time on that date
//
// Plus: auto-delete expired today-tasks at midnight IST.
//
// Idempotency: each task has a `reminder_sent` boolean. We send at most once.
// Robust to missed cron runs: we fire whenever "now ≥ trigger time" and !reminder_sent.

const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY;
const YOUR_WA_NUMBER     = process.env.YOUR_WHATSAPP_NUMBER;       // e.g. whatsapp:+91XXXXXXXXXX
const TWILIO_SID         = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN       = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_NUMBER   = process.env.TWILIO_WHATSAPP_NUMBER;     // e.g. whatsapp:+14155238886
const CRON_SECRET        = process.env.CRON_SECRET;

// ── Supabase helper
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

// ── Twilio WhatsApp send
async function sendWA(msg) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_WA_NUMBER || !YOUR_WA_NUMBER) {
    throw new Error('Missing Twilio env vars');
  }
  const creds = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      From: TWILIO_WA_NUMBER,
      To: YOUR_WA_NUMBER,
      Body: msg
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Twilio ${res.status}: ${txt}`);
  }
}

// ── Time helpers (IST = UTC+5:30)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

// Convert a (dateStr 'YYYY-MM-DD', timeStr 'HH:MM' or 'HH:MM:SS') pair — interpreted as IST —
// into a Date representing the equivalent UTC instant. Use this to compare against Date.now().
function istToUtcMs(dateStr, timeStr) {
  const [y, mo, d]   = dateStr.split('-').map(Number);
  const [h, mi]      = (timeStr || '00:00').split(':').map(Number);
  // Build a timestamp by pretending the IST wall-clock is UTC, then subtracting the offset
  const pseudoUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  return pseudoUtc - IST_OFFSET_MS;
}

function todayIstStr() {
  const ist = istNow();
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth()+1).padStart(2,'0')}-${String(ist.getUTCDate()).padStart(2,'0')}`;
}

function fmtDate(s) {
  if (!s) return '';
  return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short' });
}

function fmtTime(t) {
  // t is 'HH:MM' or 'HH:MM:SS' — return 'HH:MM'
  return t ? t.slice(0,5) : '';
}

// ── Compute when a task should be reminded, in UTC millis. Returns null if no reminder.
function reminderTimeMs(task) {
  if (task.deadline_type === 'today') {
    // Today with no time → never remind
    if (!task.deadline_time) return null;
    // Today with time → at that time (IST) on deadline_date
    return istToUtcMs(task.deadline_date, task.deadline_time);
  }
  if (task.deadline_type === 'date') {
    // Scheduled date — at its time, or at 9 AM IST if no time
    return istToUtcMs(task.deadline_date, task.deadline_time || '09:00');
  }
  return null;
}

// ── Main handler
export default async function handler(req, res) {
  // Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET env var is set.
  // Allow either that header OR a matching ?secret=... query param (for manual testing).
  const authHeader = req.headers['authorization'] || '';
  const qsSecret   = (req.query && req.query.secret) || '';
  const ok = CRON_SECRET
    ? authHeader === `Bearer ${CRON_SECRET}` || qsSecret === CRON_SECRET
    : true; // if you haven't set one, allow (not recommended in production)
  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const now   = Date.now();
  const today = todayIstStr();
  const log   = [];

  try {
    // ── 1. Fire any due reminders that haven't been sent yet.
    //
    // We only look at open tasks with reminder_sent=false. We fetch tasks whose
    // deadline_date is <= today (so we catch past-due ones too in case cron missed a run).
    // Past-due note: if a task was scheduled for yesterday at 3pm and cron skipped that run,
    // we'll still send it now — slightly late is better than silent.
    const candidates = await db(
      'GET',
      `tasks?done=eq.false&reminder_sent=eq.false&deadline_date=lte.${today}`
    );

    for (const task of (candidates || [])) {
      const triggerMs = reminderTimeMs(task);
      if (triggerMs === null) continue;           // never-remind (today w/o time)
      if (now < triggerMs) continue;              // not yet due

      // Build message
      const uFlag = task.urgent ? '🔴 *Urgent* ' : '';
      const whenStr = task.deadline_time
        ? ` is due at ${fmtTime(task.deadline_time)}`
        : ` is due today`;
      const msg = `⏰ ${uFlag}Reminder: _${task.text}_${whenStr}`;

      try {
        await sendWA(msg);
        await db('PATCH', `tasks?id=eq.${task.id}`, { reminder_sent: true });
        log.push({ sent: task.id, text: task.text });
      } catch (err) {
        // Don't mark as sent if Twilio failed — we'll retry next run
        console.error('Failed to send reminder for', task.id, err.message);
        log.push({ failed: task.id, error: err.message });
      }
    }

    // ── 2. Auto-delete expired today-tasks at midnight IST (cron hour 0 IST)
    const ist = istNow();
    const istHour = ist.getUTCHours();

    if (istHour === 0) {
      const expired = await db(
        'GET',
        `tasks?deadline_type=eq.today&deadline_date=lt.${today}`
      );
      if (expired && expired.length) {
        for (const t of expired) {
          await db('DELETE', `tasks?id=eq.${t.id}`);
        }
        log.push({ deleted: expired.length });
      }
    }

    return res.json({
      ok: true,
      nowIst: ist.toISOString().replace('Z', '+05:30'),
      checked: candidates ? candidates.length : 0,
      log
    });
  } catch (err) {
    console.error('Reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
}
