// api/whatsapp.js
// Columns used: id, text, urgent, deadline_type, deadline_date, deadline_time, done, reminder_sent, created_at

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
  if (!res.ok) throw new Error(txt);
  try { return JSON.parse(txt); } catch { return null; }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateDDMMYY(str) {
  const p = str.split('/');
  if (p.length !== 3) return null;
  let [d, m, y] = p.map(Number);
  if (y < 100) y += 2000;
  const s = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return isNaN(new Date(s).getTime()) ? null : s;
}

function parseTime(str) {
  if (!str) return null;
  const m = str.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = m[2] ? parseInt(m[2]) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

// Parse message into task fields.
// Supported formats:
//   Today: Buy milk
//   Today 3pm: Call doctor
//   14/05/26: Submit report
//   14/05/26 3pm: Submit report
//   Urgent: Fix bug
//   Urgent Today 3pm: Call client
//   Urgent 14/05/26: Big deadline
//   anything else -> today task
function parseMsg(raw) {
  let text = raw.trim();
  let urgent = false;
  let deadline_date = todayStr();
  let deadline_type = 'today';
  let deadline_time = null;

  // Strip leading "Urgent" / "Urgent:" / "Urgent -"
  if (/^urgent[\s:\-]/i.test(text)) {
    urgent = true;
    text = text.replace(/^urgent[\s:\-]*/i, '').trim();
  }

  const colon = text.indexOf(':');
  if (colon === -1) {
    // No colon — just a today task
    return { text, urgent, deadline_date, deadline_type, deadline_time };
  }

  const prefix = text.slice(0, colon).trim();
  const rest = text.slice(colon + 1).trim();

  if (!rest) {
    return { text: prefix || text, urgent, deadline_date, deadline_type, deadline_time };
  }

  // "Today" or "Today 3pm"
  const todayM = prefix.match(/^today(?:\s+(.+))?$/i);
  if (todayM) {
    if (todayM[1]) deadline_time = parseTime(todayM[1]);
    return { text: rest, urgent, deadline_date: todayStr(), deadline_type: 'today', deadline_time };
  }

  // "14/05/26" or "14/05/26 3pm"
  const dateM = prefix.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(.+))?$/);
  if (dateM) {
    const parsed = parseDateDDMMYY(dateM[1]);
    if (parsed) {
      if (dateM[2]) deadline_time = parseTime(dateM[2]);
      return { text: rest, urgent, deadline_date: parsed, deadline_type: 'date', deadline_time };
    }
  }

  // Unrecognised prefix — treat whole thing as today task
  return { text: text.trim(), urgent, deadline_date: todayStr(), deadline_type: 'today', deadline_time };
}

function fmtDate(s) {
  if (!s || s === todayStr()) return 'Today';
  return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'2-digit' });
}

function twiml(msg) {
  const safe = msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

async function handle(raw) {
  const lower = raw.trim().toLowerCase();

  // LIST — today
  if (lower === 'list' || lower === 'today') {
    const rows = await db('GET', `tasks?done=eq.false&deadline_date=eq.${todayStr()}&order=urgent.desc,created_at.asc`);
    if (!rows || !rows.length) return '📭 No tasks for today!\n\nSend "all" to see all upcoming tasks.';
    const lines = rows.map((t,i) =>
      `${i+1}. ${t.urgent?'🔴 ':''}${t.text}${t.deadline_time?' ⏰'+t.deadline_time.slice(0,5):''}`
    ).join('\n');
    return `📋 *Today\'s tasks:*\n\n${lines}\n\n_done N · delete N · all_`;
  }

  // ALL
  if (lower === 'all') {
    const rows = await db('GET', 'tasks?done=eq.false&order=deadline_date.asc,urgent.desc,created_at.asc');
    if (!rows || !rows.length) return '📭 No open tasks!';
    const lines = rows.map((t,i) =>
      `${i+1}. ${t.urgent?'🔴 ':''}${t.text} _(${fmtDate(t.deadline_date)})_`
    ).join('\n');
    return `📋 *All open tasks:*\n\n${lines}`;
  }

  // URGENT
  if (lower === 'urgent') {
    const rows = await db('GET', 'tasks?done=eq.false&urgent=eq.true&order=deadline_date.asc');
    if (!rows || !rows.length) return '✅ No urgent tasks!';
    const lines = rows.map((t,i) => `${i+1}. ${t.text} _(${fmtDate(t.deadline_date)})_`).join('\n');
    return `🔴 *Urgent tasks:*\n\n${lines}`;
  }

  // DONE N
  const doneM = raw.trim().match(/^done\s+(\d+)$/i);
  if (doneM) {
    const idx = parseInt(doneM[1]) - 1;
    const rows = await db('GET', 'tasks?done=eq.false&order=deadline_date.asc,created_at.asc');
    if (!rows || idx < 0 || idx >= rows.length) return `❌ Task #${idx+1} not found. Send "all" to see tasks.`;
    await db('PATCH', `tasks?id=eq.${rows[idx].id}`, { done: true });
    return `✅ Done: _${rows[idx].text}_`;
  }

  // DELETE N
  const delM = raw.trim().match(/^(?:delete|del|remove)\s+(\d+)$/i);
  if (delM) {
    const idx = parseInt(delM[1]) - 1;
    const rows = await db('GET', 'tasks?order=deadline_date.asc,created_at.asc');
    if (!rows || idx < 0 || idx >= rows.length) return `❌ Task #${idx+1} not found.`;
    await db('DELETE', `tasks?id=eq.${rows[idx].id}`);
    return `🗑️ Deleted: _${rows[idx].text}_`;
  }

  // HELP
  if (['help','hi','hello','?','start'].includes(lower)) {
    return `👋 *Task Tracker*\n\n*Add tasks:*\n• Today: Buy milk\n• Today 3pm: Call doctor\n• 14/05/26: Submit report\n• Urgent: Fix this now\n• Urgent 14/05/26: Big deadline\n\n*View:*\n• list — today\'s tasks\n• all — all with dates\n• urgent — urgent only\n\n*Update:*\n• done 2\n• delete 3`;
  }

  // FALLBACK — new task
  const p = parseMsg(raw.trim());
  if (!p.text) return '❌ Please include a task description. Send "help" for examples.';

  const payload = {
    text: p.text,
    urgent: p.urgent,
    deadline_type: p.deadline_type,
    deadline_date: p.deadline_date,
    done: false,
    reminder_sent: false
  };
  if (p.deadline_time) payload.deadline_time = p.deadline_time;

  await db('POST', 'tasks', payload);

  const uStr = p.urgent ? '🔴 *Urgent* ' : '';
  const dStr = p.deadline_date === todayStr()
    ? (p.deadline_time ? ` at ${p.deadline_time}` : ' for today')
    : ` by ${fmtDate(p.deadline_date)}`;

  return `${uStr}✅ Added: _${p.text}_${dStr}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  try {
    const msg = (req.body.Body || '').trim();
    if (!msg) return res.status(200).set('Content-Type','text/xml').send(twiml('❌ Empty message.'));
    const reply = await handle(msg);
    res.set('Content-Type','text/xml').status(200).send(twiml(reply));
  } catch(err) {
    console.error('Error:', err.message);
    res.set('Content-Type','text/xml').status(200).send(twiml(`⚠️ Error: ${err.message}`));
  }
}
